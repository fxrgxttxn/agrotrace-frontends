<?php

namespace App\Support\Logging;

use App\Support\Json;
use App\Support\RequestContext;
use Monolog\Formatter\FormatterInterface;
use Monolog\LogRecord;
use Throwable;

/**
 * One JSON line per log entry (Global Constraints «Заголовки и журналы», contract info.description): level, time,
 * `backend` laravel, `process`, `requestId` (the request's X-Request-Id; in the worker the handled envelope's), `msg`
 * and the context fields. Secrets never reach the log at any depth (P8): their values become "***".
 */
final class JsonLineFormatter implements FormatterInterface
{
    public const SECRET_KEYS = [
        'password', 'newpassword', 'currentpassword', 'token', 'accesstoken', 'refreshtoken', 'access_token',
        'refresh', 'secret', 'totp', 'totpsecret', 'authorization', 'cookie', 'set-cookie', 'idempotencykey',
        'altcha', 'sig',
    ];

    private const MAX_DEPTH = 8;

    public function format(LogRecord $record): string
    {
        $line = [
            'level' => strtolower($record->level->getName()),
            'time' => $record->datetime->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z'),
            'backend' => 'laravel',
            'process' => (string) (getenv('AGROTRACE_PROCESS') ?: 'cli'),
        ];
        $requestId = self::requestId();
        if ($requestId !== null) {
            $line['requestId'] = $requestId;
        }
        $line['msg'] = $record->message;
        foreach (self::redact($record->context, 0) as $k => $v) {
            if (! array_key_exists($k, $line)) {
                $line[$k] = $v;
            }
        }

        try {
            return Json::encode($line)."\n";
        } catch (Throwable) {
            return json_encode($line, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE)."\n";
        }
    }

    /** @param  array<LogRecord>  $records */
    public function formatBatch(array $records): string
    {
        return implode('', array_map(fn (LogRecord $r) => $this->format($r), $records));
    }

    /**
     * @param  array<mixed>  $data
     * @return array<mixed>
     */
    public static function redact(array $data, int $depth): array
    {
        $out = [];
        foreach ($data as $k => $v) {
            if (is_string($k) && in_array(strtolower($k), self::SECRET_KEYS, true)) {
                $out[$k] = '***';
            } elseif ($v instanceof Throwable) {
                $out[$k] = [
                    'type' => $v::class,
                    'message' => $v->getMessage(),
                    'at' => $v->getFile().':'.$v->getLine(),
                    'stack' => array_slice(explode("\n", $v->getTraceAsString()), 0, 15),
                ];
            } elseif (is_array($v) || is_object($v)) {
                $out[$k] = $depth >= self::MAX_DEPTH ? '[depth]' : self::redact((array) $v, $depth + 1);
            } else {
                $out[$k] = $v;
            }
        }

        return $out;
    }

    private static function requestId(): ?string
    {
        try {
            $app = app();

            return $app->resolved(RequestContext::class) ? $app->make(RequestContext::class)->logRequestId() : null;
        } catch (Throwable) {
            return null;
        }
    }
}
