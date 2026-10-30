<?php

/*
 * Logs (Global Constraints, contract info.description): one JSON line per entry on stdout with `backend` and
 * `requestId` (App\Support\Logging\JsonLineFormatter); secrets masked at any depth (P8).
 */
use App\Support\Logging\JsonLineFormatter;
use Monolog\Handler\NullHandler;
use Monolog\Handler\StreamHandler;

return [
    'default' => 'stdout',
    'deprecations' => ['channel' => 'null', 'trace' => false],
    'channels' => [
        'stdout' => [
            'driver' => 'monolog',
            'handler' => StreamHandler::class,
            'with' => ['stream' => env('LOG_STREAM', 'php://stdout')],
            'formatter' => JsonLineFormatter::class,
            'level' => env('LOG_LEVEL', 'info'),
        ],
        'null' => [
            'driver' => 'monolog',
            'handler' => NullHandler::class,
        ],
        // PHP/vendor deprecations are silent, as in Express (final review M3). Declared here, not left to
        // HandleExceptions: it adds this channel to the base application's config only, and an Octane request
        // sandbox without it logged `EMERGENCY: Unable to create configured logger` as a non-JSON block.
        'deprecations' => [
            'driver' => 'monolog',
            'handler' => NullHandler::class,
        ],
        'emergency' => [
            'path' => 'php://stderr',
        ],
    ],
];
