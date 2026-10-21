<?php

// Laravel's own settings; everything AgroTrace-specific lives in config/agrotrace.php.
return [
    'name' => 'AgroTrace',
    'env' => env('APP_ENV', 'production'),
    'debug' => (bool) env('APP_DEBUG', false),
    'url' => env('PUBLIC_BASE_URL', 'http://localhost'),
    // Review Focus 7: PHP clocks and Carbon in UTC, whatever the TZ of the container (`--tz Europe/Moscow` runs).
    'timezone' => 'UTC',
    'locale' => 'ru',
    'fallback_locale' => 'ru',
    'faker_locale' => 'ru_RU',
    'cipher' => 'AES-256-CBC',
    'key' => env('APP_KEY'),
    'previous_keys' => [],
    'maintenance' => ['driver' => 'file'],
];
