<?php

namespace App\Infrastructure\Metrics;

use Prometheus\CollectorRegistry;
use Prometheus\Counter;
use Prometheus\Histogram;
use Prometheus\RenderTextFormat;
use Prometheus\Storage\Adapter;
use Prometheus\Storage\APCng;

/**
 * The HTTP series of the api (spec 14.5, contract «Мониторинг», P54, L15), the port of backend-express's
 * infra/metrics.ts: prometheus_client_php over APCng — APCu is the shared memory of every FrankenPHP thread of the one
 * api process (the Octane workers and the classic SSE threads), so `/metrics` on METRICS_PORT shows their sums.
 *
 * - `http_request_duration_seconds` (histogram; method, route, status, backend) — Express's buckets (prom-client's
 *   defaults);
 * - `http_request_errors_total` (counter; the same labels) — responses with status ≥ 500 (499 is not one).
 *
 * `method` outside GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS is `other`; `route` is the contract template or
 * `unmatched` (App\Http\Middleware\Metrics) — bounded cardinality whatever clients send.
 */
final class HttpMetrics
{
    public const BACKEND = 'laravel';

    public const DURATION = 'http_request_duration_seconds';

    public const ERRORS = 'http_request_errors_total';

    public const DURATION_HELP = 'HTTP response time of the API by method, contract route and status';

    public const ERRORS_HELP = 'HTTP responses with status >= 500 by method, contract route and status';

    /** prom-client's default buckets, as Express (and Django) use. */
    public const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

    public const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

    private const LABELS = ['method', 'route', 'status', 'backend'];

    /** The APCu key prefix of the series (one api container, one APCu segment). */
    private const PREFIX = 'agrotrace_metrics';

    private readonly CollectorRegistry $registry;

    private readonly Histogram $duration;

    private readonly Counter $errors;

    public function __construct(private readonly Adapter $storage = new APCng(self::PREFIX, 6))
    {
        $this->registry = new CollectorRegistry($this->storage, false);
        $this->duration = $this->registry->getOrRegisterHistogram('', self::DURATION, self::DURATION_HELP, self::LABELS, self::BUCKETS);
        $this->errors = $this->registry->getOrRegisterCounter('', self::ERRORS, self::ERRORS_HELP, self::LABELS);
    }

    /** One finished request. */
    public function observe(string $method, string $route, int $status, float $seconds): void
    {
        $labels = [in_array($method, self::METHODS, true) ? $method : 'other', $route, (string) $status, self::BACKEND];
        $this->duration->observe(max(0.0, $seconds), $labels);
        if ($status >= 500) {
            $this->errors->inc($labels);
        }
    }

    /**
     * The two HTTP families in the text format. A family without samples yet (no 5xx since the start) still gets its
     * HELP and TYPE lines, as prom-client writes them.
     */
    public function render(): string
    {
        $text = (new RenderTextFormat)->render($this->registry->getMetricFamilySamples());
        foreach ([[self::DURATION, self::DURATION_HELP, 'histogram'], [self::ERRORS, self::ERRORS_HELP, 'counter']] as [$name, $help, $type]) {
            if (! str_contains($text, "# TYPE {$name} {$type}\n")) {
                $text .= "# HELP {$name} {$help}\n# TYPE {$name} {$type}\n";
            }
        }

        return ltrim($text, "\n");
    }

    /** Tests: every stored series removed. */
    public function wipe(): void
    {
        $this->storage->wipeStorage();
    }
}
