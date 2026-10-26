<?php

namespace App\Infrastructure\Mail;

use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\I18n\Messages;
use App\Support\RequestContext;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Mailer\Transport\Smtp\EsmtpTransport;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;
use Throwable;

/**
 * Outgoing mail over SMTP (dev: Mailpit), plain-text Russian letters from packages/i18n (`mail.*`, Messages). Sending
 * never blocks or fails the operation that asks for it (spec 8.9): `send` runs after the response has been sent
 * (RequestContext::afterResponse) with the DB slot given back first (P61), 3 attempts with back-off 500 ms / 1 s,
 * then the letter is logged as not delivered — without its body (the links in it are secrets). Without SMTP_HOST mail
 * is not configured: logged, nothing sent. One attempt (sendOnce) waits at most 10 s for any byte (Express
 * socketTimeout) and ends by its deadline, 30 s by default (DeadlineStream); the notification delivery counts it as
 * one failed attempt.
 */
final class Mailer
{
    public const SOCKET_TIMEOUT_SEC = 10.0;

    public const ATTEMPT_TIMEOUT_SEC = 30.0;

    public static function configured(): bool
    {
        $host = config('agrotrace.smtp.host');

        return is_string($host) && $host !== '';
    }

    /** @param  array<string, string|int>  $params */
    public static function send(string $to, string $subjectKey, string $bodyKey, array $params, string $kind = ''): void
    {
        $letter = [
            'to' => $to,
            'subject' => Messages::t($subjectKey, $params),
            'text' => Messages::t($bodyKey, $params),
            'kind' => $kind !== '' ? $kind : $subjectKey,
        ];
        app(RequestContext::class)->afterResponse(function () use ($letter): void {
            SlotHolder::release();
            self::deliver($letter);
        });
    }

    /**
     * One letter with retries (never throws).
     *
     * @param  array{to: string, subject: string, text: string, kind: string}  $letter
     */
    public static function deliver(array $letter, int $backoffMs = 500): void
    {
        $host = config('agrotrace.smtp.host');
        if (! is_string($host) || $host === '') {
            Log::error('mail not delivered: SMTP_HOST is not set', ['kind' => $letter['kind']]);

            return;
        }
        for ($attempt = 1; $attempt <= 3; $attempt++) {
            try {
                self::sendOnce($letter);

                return;
            } catch (Throwable $e) {
                if ($attempt === 3) {
                    Log::error('mail not delivered', ['err' => $e->getMessage(), 'kind' => $letter['kind']]);

                    return;
                }
                usleep($backoffMs * 1000 * 2 ** ($attempt - 1));
            }
        }
    }

    /**
     * One attempt, no retries; throws when the SMTP server refuses or is unreachable.
     *
     * @param  array{to: string, subject: string, text: string, kind: string}  $letter
     */
    public static function sendOnce(array $letter, float $timeoutSec = self::ATTEMPT_TIMEOUT_SEC): void
    {
        // Every wait of the attempt ≤ 10 s (Express socketTimeout) and the whole attempt ≤ $timeoutSec (DeadlineStream).
        $stream = new DeadlineStream(microtime(true) + $timeoutSec, self::SOCKET_TIMEOUT_SEC);
        $transport = new EsmtpTransport((string) config('agrotrace.smtp.host'), (int) config('agrotrace.smtp.port', 1025), false, stream: $stream);
        $transport->setAutoTls(false);
        $email = (new Email)
            ->from(Address::create((string) config('agrotrace.smtp.from')))
            ->to($letter['to'])
            ->subject($letter['subject'])
            ->text($letter['text']);
        $transport->send($email);
    }
}
