<?php

/*
 * Prometheus metrics of the api (spec 14.5, contract «Мониторинг», P54, L15): the HTTP families in APCu
 * (prometheus_client_php APCng), one observation per request after the response, `route` = the contract template or
 * `unmatched`; the exposition only for the METRICS_PORT listener, never measured itself; the scrape-time gauges
 * bounded, NaN when unknown. tests/api/metrics.test.ts covers the live stand.
 */

use App\Http\Middleware\Metrics;
use App\Infrastructure\Metrics\HttpMetrics;
use App\Infrastructure\Metrics\ScrapeGauges;
use App\Octane\EndOfRequest;
use App\Support\RequestContext;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Testing\TestResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Tests\TestCase;

uses(TestCase::class);

beforeEach(function () {
    app(HttpMetrics::class)->wipe();
    // No broker or DB in unit tests: fixed gauge values.
    app()->instance(ScrapeGauges::class, new ScrapeGauges(fn () => 3, fn () => 7));
});

/** The `_count` samples of http_request_duration_seconds as "METHOD route status" => count. */
function durationCounts(string $text): array
{
    preg_match_all('/^http_request_duration_seconds_count\{method="([^"]*)",route="([^"]*)",status="([^"]*)",backend="laravel"\} (\S+)$/m', $text, $m, PREG_SET_ORDER);
    $out = [];
    foreach ($m as $x) {
        $out["{$x[1]} {$x[2]} {$x[3]}"] = (int) $x[4];
    }
    ksort($out);

    return $out;
}

/** A request of the METRICS_PORT listener (the server variable Caddy's :9464 block sets). */
function scrape(string $uri = '/metrics'): TestResponse
{
    $request = Request::create($uri, 'GET', server: [Metrics::LISTENER_VAR => '1', 'REQUEST_URI' => $uri]);
    $kernel = app(Kernel::class);
    $response = $kernel->handle($request);
    $kernel->terminate($request, $response);

    return TestResponse::fromBaseResponse($response, $request);
}

it('observes each request once by method, contract template and status; outside the contract → unmatched', function () {
    $this->raw('GET', '/api/v1/health/live')->assertStatus(200);
    $this->raw('GET', '/api/v1/health/live')->assertStatus(200);
    $this->raw('GET', '/api/v1/batches/0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e')->assertStatus(401);
    $this->raw('POST', '/api/v1/dictionaries/regions/import')->assertStatus(401); // the literal template wins
    $this->raw('GET', '/api/v1/no/such/path-for-metrics?x=1')->assertStatus(404);
    $this->raw('GET', '/metrics')->assertStatus(404);
    $this->raw('DELETE', '/api/v1/health/live')->assertStatus(405);
    $this->raw('BREW', '/api/v1/health/live')->assertStatus(405);

    expect(durationCounts(app(HttpMetrics::class)->render()))->toBe([
        'DELETE /health/live 405' => 1,
        'GET /batches/{id} 401' => 1,
        'GET /health/live 200' => 2,
        'GET unmatched 404' => 2,
        'POST /dictionaries/{name}/import 401' => 1,
        'other /health/live 405' => 1,
    ]);
});

it('writes the histogram with Express buckets and counts only 5xx as errors (499 is not one)', function () {
    $m = app(HttpMetrics::class);
    $m->observe('GET', '/health/live', 200, 0.02);
    $m->observe('POST', '/batches', 503, 1.5);
    $m->observe('POST', '/batches', 499, 0.3);
    $text = $m->render();

    expect($text)->toContain("# TYPE http_request_duration_seconds histogram\n")
        ->toContain('http_request_duration_seconds_bucket{method="GET",route="/health/live",status="200",backend="laravel",le="0.01"} 0')
        ->toContain('http_request_duration_seconds_bucket{method="GET",route="/health/live",status="200",backend="laravel",le="0.025"} 1')
        ->toContain('http_request_duration_seconds_bucket{method="GET",route="/health/live",status="200",backend="laravel",le="+Inf"} 1')
        ->toContain('http_request_duration_seconds_sum{method="POST",route="/batches",status="503",backend="laravel"} 1.5')
        ->toContain("# TYPE http_request_errors_total counter\n")
        ->toContain('http_request_errors_total{method="POST",route="/batches",status="503",backend="laravel"} 1');
    expect($text)->not->toContain('http_request_errors_total{method="POST",route="/batches",status="499"');
    preg_match_all('/le="([^"]+)"/', $text, $le);
    expect(array_values(array_unique($le[1])))->toBe(['0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5', '1', '2.5', '5', '10', '+Inf']);
});

it('declares both HTTP families before any sample', function () {
    expect(app(HttpMetrics::class)->render())->toBe(
        "# HELP http_request_duration_seconds HTTP response time of the API by method, contract route and status\n"
        ."# TYPE http_request_duration_seconds histogram\n"
        ."# HELP http_request_errors_total HTTP responses with status >= 500 by method, contract route and status\n"
        ."# TYPE http_request_errors_total counter\n"
    );
});

it('a request whose client ClientConnection saw go away is 499', function () {
    app(HttpMetrics::class)->observe('GET', '/health/live', 200, 0.001); // the family exists
    $mw = new Metrics;
    $request = Request::create('/api/v1/reports/batches', 'GET');
    $request->server->set('REQUEST_URI', '/api/v1/reports/batches');
    $ctx = app(RequestContext::class);
    $mw->handle($request, function () use ($ctx) {
        $ctx->markClientGone();

        return response('', 204);
    });
    foreach ($ctx->takeAfterResponse() as $cb) {
        $cb();
    }
    expect(durationCounts(app(HttpMetrics::class)->render()))->toHaveKey('GET /reports/{type} 499');
});

it('serves the exposition to the METRICS_PORT listener only, unmeasured, every series with backend', function () {
    $this->raw('GET', '/api/v1/health/live');
    $res = scrape();
    $res->assertStatus(200);
    expect($res->headers->get('Content-Type'))->toStartWith('text/plain');
    $text = $res->getContent();
    expect($text)->toContain("queue_messages{queue=\"agrotrace.laravel.jobs\",backend=\"laravel\"} 3\n")
        ->toContain("# TYPE recalls_open gauge\nrecalls_open{backend=\"laravel\"} 7\n");
    foreach (preg_split('/\n/', trim($text)) as $line) {
        if (! str_starts_with($line, '#')) {
            expect($line)->toContain('backend="laravel"');
        }
    }
    scrape();
    // The scrapes themselves are not observed (L15), and get no request id / backend header of the API.
    expect(durationCounts(app(HttpMetrics::class)->render()))->toBe(['GET /health/live 200' => 1]);
    expect($res->headers->get('X-Request-Id'))->toBeNull();
});

it('the listener answers 404 for any other path, as written (Caddy matches case-insensitively)', function () {
    scrape('/METRICS')->assertStatus(404);
    scrape('/metric%73')->assertStatus(404);
    scrape('/metrics?x=1')->assertStatus(200);
});

it('a gauge that fails, times out or is being read by another scrape is NaN, never a stale value', function () {
    $failing = new ScrapeGauges(fn () => throw new RuntimeException('down'), fn () => 5);
    expect($failing->render())->toContain('queue_messages{queue="agrotrace.laravel.jobs",backend="laravel"} NaN')
        ->toContain('recalls_open{backend="laravel"} 5');

    $slow = new ScrapeGauges(fn () => 1, function (float $budget) {
        expect($budget)->toBeLessThanOrEqual(0.2);
        usleep(250_000);

        return 9;
    }, timeoutSec: 0.2);
    expect($slow->render())->toContain('recalls_open{backend="laravel"} NaN');

    apcu_add('agrotrace_metrics_read:recalls_open', 1, 5); // another thread is reading
    try {
        $t0 = microtime(true);
        $busy = new ScrapeGauges(fn () => 1, fn () => 2, timeoutSec: 0.1);
        expect($busy->render())->toContain('recalls_open{backend="laravel"} NaN')
            ->toContain('queue_messages{queue="agrotrace.laravel.jobs",backend="laravel"} 1');
        expect(microtime(true) - $t0)->toBeLessThan(1.0);
    } finally {
        apcu_delete('agrotrace_metrics_read:recalls_open');
    }
    // The lock is given back after every read.
    expect(apcu_exists('agrotrace_metrics_read:queue_messages'))->toBeFalse();
});

/** The `_sum` of one series of http_request_duration_seconds. */
function durationSum(string $text, string $method, string $route, string $status): ?float
{
    $re = '/^http_request_duration_seconds_sum\{method="'.preg_quote($method, '/').'",route="'.preg_quote($route, '/')
        .'",status="'.$status.'",backend="laravel"\} (\S+)$/m';

    return preg_match($re, $text, $m) ? (float) $m[1] : null;
}

it('ends the duration when the response is sent, not after the after-response work queued before it (review I1)', function () {
    $request = Request::create('/api/v1/auth/password/forgot', 'POST');
    $request->server->set('REQUEST_URI', '/api/v1/auth/password/forgot');
    $ctx = app(RequestContext::class);
    (new Metrics)->handle($request, function () use ($ctx) {
        // A mail delivery (Mailer::send) registered during the request runs after the response, before the metrics.
        $ctx->afterResponse(fn () => usleep(300_000));

        return response('', 202);
    });
    EndOfRequest::finish(app());
    $sum = durationSum(app(HttpMetrics::class)->render(), 'POST', '/auth/password/forgot', '202');
    expect($sum)->not->toBeNull()->toBeLessThan(0.2);
});

it('a stream gives one observation with its status, however often the end of the request runs', function () {
    $request = Request::create('/api/v1/events/stream', 'GET');
    $request->server->set('REQUEST_URI', '/api/v1/events/stream');
    (new Metrics)->handle($request, fn () => new StreamedResponse(fn () => null, 200));
    EndOfRequest::finish(app()); // Kernel::terminate
    EndOfRequest::finish(app()); // Octane RequestTerminated
    expect(durationCounts(app(HttpMetrics::class)->render()))->toBe(['GET /events/stream 200' => 1]);
});

it('499: a client seen gone, or an aborted write of a whole response; a stream whose headers went keeps its status', function () {
    $plain = response('x', 200);
    $stream = new StreamedResponse(fn () => null, 200);
    expect(Metrics::status($plain, clientGone: false, aborted: false))->toBe(200)
        ->and(Metrics::status($plain, clientGone: false, aborted: true))->toBe(499)
        ->and(Metrics::status($plain, clientGone: true, aborted: false))->toBe(499)
        ->and(Metrics::status($stream, clientGone: false, aborted: true))->toBe(200)
        ->and(Metrics::status(response('', 204), clientGone: true, aborted: true))->toBe(499);
});

it('the listener 404 is Express\'s text, byte for byte, for any other method or path', function () {
    foreach (['/METRICS', '/nope'] as $uri) {
        $res = scrape($uri);
        $res->assertStatus(404);
        expect($res->getContent())->toBe("not found\n")->and($res->headers->get('Content-Type'))->toBe('text/plain; charset=utf-8');
    }
    $request = Request::create('/metrics', 'POST', server: [Metrics::LISTENER_VAR => '1', 'REQUEST_URI' => '/metrics']);
    $res = app(Kernel::class)->handle($request);
    expect($res->getStatusCode())->toBe(404)->and($res->getContent())->toBe("not found\n");
});
