<?php

namespace App\Infrastructure\Mercury;

use App\Domain\Strings;
use App\Http\Query\QueryReader;
use App\Http\Validation\Ecma;
use App\Http\Validation\Z\StringS as ZString;
use App\Support\Json;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use stdClass;
use Throwable;

/**
 * ФГИС «Меркурий» adapter (R81; dev: mercury-mock, `MERCURY_URL`; Express infra/mercury.ts): one list query per call,
 * `GET {MERCURY_URL}/api/v1/vsd?productCode=&senderInn=&dateFrom=&dateTo=`, `MERCURY_TIMEOUT_MS` (10 s) for the
 * whole call. A call either returns the items in the Mercury format (Express's VsdSchema: nested objects keep only
 * their known keys, the document itself keeps every key — `payload` is the whole document) or fails: network error,
 * timeout, non-200 status, a body that is not the Mercury format. Retries belong to the `vsd.import` handler.
 *
 * Test stand only (P35): calls for a product code listed in `MERCURY_FAIL_PRODUCT_CODES` carry
 * `X-Mock-Fail: <MERCURY_FAIL_MODE>` so mercury-mock fails them on purpose.
 */
final class Mercury
{
    /**
     * @param  list<string>  $failProductCodes
     */
    public function __construct(
        private readonly string $url,
        private readonly int $timeoutMs = 10000,
        private readonly array $failProductCodes = [],
        private readonly string $failMode = '500',
    ) {}

    public static function fromConfig(): self
    {
        $codes = array_values(array_filter(array_map('trim', explode(',', (string) config('agrotrace.mercury.fail_product_codes', ''))),
            fn (string $c) => $c !== ''));

        return new self(
            rtrim((string) config('agrotrace.mercury.url'), '/'),
            (int) config('agrotrace.mercury.timeout_ms', 10000),
            $codes,
            (string) config('agrotrace.mercury.fail_mode', '500'),
        );
    }

    /**
     * @param  array{productCode: string, senderInn: string, dateFrom: string, dateTo: string}  $q
     * @return array{ok: true, items: list<stdClass>}|array{ok: false, error: string}
     */
    public function listVsd(array $q): array
    {
        $headers = ['Accept' => 'application/json'];
        if (in_array($q['productCode'], $this->failProductCodes, true)) {
            $headers['X-Mock-Fail'] = $this->failMode;
        }
        $seconds = $this->timeoutMs / 1000;
        try {
            $res = Http::withHeaders($headers)->timeout((int) ceil($seconds))->connectTimeout((int) ceil($seconds))
                ->withOptions(['timeout' => $seconds, 'connect_timeout' => $seconds])
                ->get("{$this->url}/api/v1/vsd?".http_build_query($q, '', '&', PHP_QUERY_RFC1738));
        } catch (ConnectionException $e) {
            $timedOut = str_contains($e->getMessage(), 'timed out') || str_contains($e->getMessage(), 'cURL error 28');

            // last_error as Express stores it (final review M4): fetch's `fetch failed`, never cURL's text with the URL.
            return ['ok' => false, 'error' => 'mercury: '.($timedOut ? "timeout after {$this->timeoutMs} ms" : 'fetch failed')];
        } catch (Throwable) {
            return ['ok' => false, 'error' => 'mercury: fetch failed'];
        }
        if ($res->status() !== 200) {
            return ['ok' => false, 'error' => 'mercury: HTTP '.$res->status()];
        }
        try {
            $list = Json::decode($res->body());
        } catch (Throwable) {
            return ['ok' => false, 'error' => 'mercury: the response is not JSON'];
        }
        if (! $list instanceof stdClass || ! isset($list->items) || ! is_array($list->items)) {
            return ['ok' => false, 'error' => 'mercury: the response is not a VSD list'];
        }
        $items = [];
        foreach ($list->items as $raw) {
            $v = self::vsd($raw);
            if ($v === null) {
                return ['ok' => false, 'error' => 'mercury: a VSD item does not match the Mercury format'];
            }
            $items[] = $v;
        }

        return ['ok' => true, 'items' => $items];
    }

    /** Express VsdSchema (passthrough at the top, nested objects stripped to their keys); null — not the format. */
    public static function vsd(mixed $raw): ?stdClass
    {
        if (! $raw instanceof stdClass) {
            return null;
        }
        $inn = Ecma::compile('^\d{10}(\d{2})?$');
        $str = fn (mixed $v): bool => is_string($v);
        $party = function (mixed $p) use ($inn, $str): ?stdClass {
            if (! $p instanceof stdClass || ! $str($p->inn ?? null) || ! Ecma::test($inn, $p->inn) || ! $str($p->name ?? null)) {
                return null;
            }

            return (object) ['inn' => $p->inn, 'name' => $p->name];
        };
        $uuid = $raw->uuid ?? null;
        $number = $raw->number ?? null;
        $issueDate = $raw->issueDate ?? null;
        $status = $raw->status ?? null;
        $product = $raw->product ?? null;
        $volume = $raw->volume ?? null;
        if (! is_string($uuid) || ! QueryReader::isUuid($uuid)
            || ! is_string($number) || ZString::jsLength($number) < 1 || ZString::jsLength($number) > 64
            || ! is_string($issueDate) || ! Ecma::test(Ecma::compile('^\d{4}-\d{2}-\d{2}$'), $issueDate)
            || ! in_array($status, ['CONFIRMED', 'WITHDRAWN', 'UTILIZED'], true)
            || ! $product instanceof stdClass || ! $str($product->code ?? null) || ! $str($product->name ?? null)
            || ! $volume instanceof stdClass || ! (is_int($volume->value ?? null) || is_float($volume->value ?? null))
            || $volume->value < 0 || ! $str($volume->unit ?? null)) {
            return null;
        }
        $consignor = $party($raw->consignor ?? null);
        $consignee = $party($raw->consignee ?? null);
        if ($consignor === null || $consignee === null) {
            return null;
        }
        $out = clone $raw;
        $out->product = (object) ['code' => $product->code, 'name' => $product->name];
        $out->volume = (object) ['value' => $volume->value, 'unit' => $volume->unit];
        $out->consignor = $consignor;
        $out->consignee = $consignee;

        return $out;
    }

    /**
     * The document to import (the event schema): among CONFIRMED items the latest — greatest issueDate, then number,
     * then uuid (code points); none → null.
     *
     * @param  list<stdClass>  $items
     */
    public static function pick(array $items): ?stdClass
    {
        $best = null;
        foreach ($items as $v) {
            if ($v->status !== 'CONFIRMED') {
                continue;
            }
            if ($best === null || (Strings::compareCodePoints($v->issueDate, $best->issueDate)
                ?: Strings::compareCodePoints($v->number, $best->number)
                ?: Strings::compareCodePoints($v->uuid, $best->uuid)) > 0) {
                $best = $v;
            }
        }

        return $best;
    }
}
