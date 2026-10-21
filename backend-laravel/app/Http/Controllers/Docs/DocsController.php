<?php

namespace App\Http\Controllers\Docs;

use App\Contract\Contract;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use Illuminate\Http\Response;

/**
 * Swagger UI at /api/v1/docs (spec 8.3, L10) over the bundled contract, as Express serves it: swagger-ui-dist of the
 * same lockfile version (Dockerfile stage `contract`), no CDN, no inline script or handler — the initializer is the
 * static init.js, so the page works under the gateway's CSP `script-src 'self'` (R89/I6, P5).
 */
final class DocsController
{
    private const BASE = '/api/v1/docs';

    /** Our asset name → [file in swagger-ui-dist, content type]. */
    private const ASSETS = [
        'swagger-ui.css' => 'text/css; charset=utf-8',
        'swagger-ui-bundle.js' => 'text/javascript; charset=utf-8',
        'swagger-ui-standalone-preset.js' => 'text/javascript; charset=utf-8',
        'favicon-32x32.png' => 'image/png',
    ];

    /** The page's own policy (also without the gateway, which sets the same one). */
    private const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
        ."script-src 'self'; font-src 'self'; frame-ancestors 'none'";

    public function page(): Response
    {
        $b = self::BASE;
        $html = <<<HTML
            <!doctype html>
            <html lang="ru">
            <head>
            <meta charset="utf-8">
            <title>AgroTrace API — Laravel</title>
            <link rel="stylesheet" href="{$b}/swagger-ui.css">
            <link rel="icon" type="image/png" href="{$b}/favicon-32x32.png">
            </head>
            <body>
            <div id="swagger-ui"></div>
            <script src="{$b}/swagger-ui-bundle.js"></script>
            <script src="{$b}/swagger-ui-standalone-preset.js"></script>
            <script src="{$b}/init.js"></script>
            </body>
            </html>

            HTML;

        return self::send($html, 'text/html; charset=utf-8', 'no-cache', ['Content-Security-Policy' => self::CSP]);
    }

    public function init(): Response
    {
        $b = self::BASE;
        $js = <<<JS
            window.addEventListener('load', function () {
              window.ui = SwaggerUIBundle({
                url: '{$b}/openapi.json',
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
                layout: 'StandaloneLayout',
              });
            });

            JS;

        return self::send($js, 'text/javascript; charset=utf-8', 'no-cache');
    }

    public function openapi(Contract $contract): Response
    {
        return self::send($contract->raw(), 'application/json; charset=utf-8', 'no-cache');
    }

    public function asset(string $asset): Response
    {
        $type = self::ASSETS[$asset] ?? null;
        $body = $type !== null ? @file_get_contents(self::dir().'/'.$asset) : false;
        if ($body === false) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }

        return self::send($body, (string) $type, 'public, max-age=86400');
    }

    private static function dir(): string
    {
        $configured = config('agrotrace.swagger_path');

        return is_string($configured) && $configured !== '' ? $configured : resource_path('swagger/dist');
    }

    /** @param  array<string, string>  $headers */
    private static function send(string $body, string $type, string $cache, array $headers = []): Response
    {
        return new Response($body, 200, [
            'Content-Type' => $type,
            'Cache-Control' => $cache,
            'X-Content-Type-Options' => 'nosniff',
            ...$headers,
        ]);
    }
}
