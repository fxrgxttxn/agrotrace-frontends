<?php

// The FrankenPHP worker of Octane (docker/Caddyfile): one Laravel application per worker thread, a sandbox per request.
$_SERVER['APP_BASE_PATH'] = $_ENV['APP_BASE_PATH'] ?? $_SERVER['APP_BASE_PATH'] ?? __DIR__.'/..';
$_SERVER['APP_PUBLIC_PATH'] = $_ENV['APP_PUBLIC_PATH'] ?? $_SERVER['APP_PUBLIC_PATH'] ?? __DIR__;

require __DIR__.'/../vendor/laravel/octane/bin/frankenphp-worker.php';
