<?php

namespace App\Infrastructure\Telegram;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\RequestException;
use GuzzleHttp\Handler\CurlMultiHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Promise\CancellationException;
use GuzzleHttp\Promise\PromiseInterface;
use Psr\Http\Message\ResponseInterface;
use Throwable;

/**
 * Telegram Bot API (FR-NOTIF-02; Express infra/telegram.ts): `sendMessage` for the delivery half and `getUpdates` for
 * the poller that links accounts. Without TELEGRAM_BOT_TOKEN the client is not configured: TELEGRAM rows end
 * NOT_CONFIGURED without an attempt and no poller runs.
 *
 * Every call is POST `{apiUrl}/bot{token}/{method}` with a JSON body; a transport error, a non-2xx status or `ok: false`
 * is a TelegramError. sendMessage: 10 s for the whole request (curl's total timeout — a trickling server cannot stretch
 * it), at most what is left of the attempt's deadline. getUpdates runs on a curl multi handle (`getUpdatesAsync` +
 * `tick`), so the poller renews its key every 10 s while a 25 s long poll is in flight and can abort it at once
 * (`cancel`, Express `abort.abort()`); its own timeout is the long poll + 10 s.
 */
final class Telegram implements UpdatesPort
{
    public const TIMEOUT_SEC = 10.0;

    private readonly CurlMultiHandler $multi;

    private readonly Client $http;

    public function __construct(
        private readonly ?string $token,
        private readonly string $apiUrl = 'https://api.telegram.org',
        ?callable $handler = null,
    ) {
        $this->multi = new CurlMultiHandler(['select_timeout' => 0.2]);
        $this->http = new Client(['handler' => HandlerStack::create($handler ?? $this->multi), 'http_errors' => false]);
    }

    public static function fromConfig(): self
    {
        $token = config('agrotrace.telegram.token');

        return new self(is_string($token) && $token !== '' ? $token : null,
            rtrim((string) config('agrotrace.telegram.api_url', 'https://api.telegram.org'), '/'));
    }

    public function configured(): bool
    {
        return $this->token !== null;
    }

    /** One attempt; throws TelegramError. */
    public function sendMessage(string $chatId, string $text, float $timeoutSec = self::TIMEOUT_SEC): void
    {
        $this->call('sendMessage', ['chat_id' => $chatId, 'text' => $text], min(self::TIMEOUT_SEC, $timeoutSec))->wait();
    }

    /**
     * The long poll, started on the multi handle; resolves to the updates (list of arrays) or rejects with
     * TelegramError. Drive it with tick() (or wait()).
     */
    public function getUpdatesAsync(?int $offset, int $timeoutSec): PromiseInterface
    {
        $body = ['timeout' => $timeoutSec, 'allowed_updates' => ['message']];
        if ($offset !== null) {
            $body = ['offset' => $offset] + $body;
        }

        return $this->call('getUpdates', $body, $timeoutSec + 10.0);
    }

    /** @return list<array<string, mixed>> */
    public function getUpdates(?int $offset, int $timeoutSec): array
    {
        /** @var list<array<string, mixed>> */
        return $this->getUpdatesAsync($offset, $timeoutSec)->wait();
    }

    /** Runs the multi handle once (at most ~0.2 s waiting for activity). */
    public function tick(): void
    {
        $this->multi->tick();
    }

    /** @param  array<string, mixed>  $body */
    private function call(string $method, array $body, float $timeoutSec): PromiseInterface
    {
        if ($this->token === null) {
            throw new TelegramError('telegram is not configured');
        }

        return $this->http->postAsync("{$this->apiUrl}/bot{$this->token}/{$method}", [
            'json' => $body,
            'timeout' => $timeoutSec,
            'connect_timeout' => min(self::TIMEOUT_SEC, $timeoutSec),
        ])->then(function (ResponseInterface $res) use ($method) {
            $json = json_decode((string) $res->getBody(), true);
            $ok = is_array($json) && ($json['ok'] ?? false) === true;
            if ($res->getStatusCode() < 200 || $res->getStatusCode() > 299 || ! $ok) {
                $description = is_array($json) && is_string($json['description'] ?? null) ? $json['description'] : '';
                throw new TelegramError($this->masked(trim("telegram {$method}: {$res->getStatusCode()} {$description}")));
            }

            return $json['result'] ?? null;
        }, function (mixed $reason) use ($method) {
            // P8 (final review I1): Guzzle's transport errors end with `for <uri>`, and the URI holds the bot token —
            // the error says only what failed, as Express's fetch does (`fetch failed`), and chains nothing.
            throw new TelegramError("telegram {$method}: ".self::transportError($reason));
        });
    }

    /** A transport failure in a few words: `timeout` (cURL 28), `aborted` (a cancelled long poll) or `fetch failed`. */
    private static function transportError(mixed $reason): string
    {
        if ($reason instanceof CancellationException) {
            return 'aborted';
        }
        $context = $reason instanceof RequestException || $reason instanceof ConnectException ? $reason->getHandlerContext() : [];

        return ($context['errno'] ?? null) === 28 || ($reason instanceof Throwable && str_contains($reason->getMessage(), 'cURL error 28'))
            ? 'timeout' : 'fetch failed';
    }

    /** The token never leaves this class in a message (an API description could echo it). */
    private function masked(string $text): string
    {
        return $this->token === null || $this->token === '' ? $text : str_replace($this->token, '***', $text);
    }
}
