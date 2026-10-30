<?php

// LaneTest: a parent process that runs one Lane job (argv: script, lane dir, deadline s, stdin of the job) and is killed
// by the test while the job runs — what a worker restart or a crash does to the thread that started a child.

use App\Infrastructure\Sandbox\Lane;
use App\Infrastructure\Sandbox\LaneOptions;
use Illuminate\Contracts\Console\Kernel;

require __DIR__.'/../../../vendor/autoload.php';
$app = require __DIR__.'/../../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

[, $script, $dir, $deadline, $input] = $argv;
try {
    echo Lane::run($script, $input, new LaneOptions('orphan', 0, (float) $deadline, '64M', $dir));
} catch (Throwable $e) {
    echo get_class($e), ': ', $e->getMessage();
}
