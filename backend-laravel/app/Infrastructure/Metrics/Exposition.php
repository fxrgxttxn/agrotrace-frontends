<?php

namespace App\Infrastructure\Metrics;

use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * `GET /metrics` of METRICS_PORT (9464, docker/Caddyfile — the block passes nothing else): the HTTP families of
 * HttpMetrics and the scrape-time gauges of ScrapeGauges, every series with `backend="laravel"`. Prometheus scrapes it
 * inside the compose network; neither the API port nor the gateway serves it (P54).
 */
final class Exposition
{
    public const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

    public static function response(HttpMetrics $http, ScrapeGauges $gauges): Response
    {
        try {
            $text = $http->render().$gauges->render();
        } catch (Throwable $e) {
            Log::error('metrics: scrape failed', ['err' => $e->getMessage()]);

            return new Response("scrape failed\n", 500, ['Content-Type' => 'text/plain; charset=utf-8']);
        }

        return new Response($text, 200, ['Content-Type' => self::CONTENT_TYPE]);
    }
}
