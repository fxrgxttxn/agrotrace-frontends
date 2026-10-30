<?php

namespace App\Console\Commands;

use App\Support\EnvConfig;
use Illuminate\Console\Command;

/** `artisan agrotrace:preflight` — the environment check of docker/entrypoint.sh (exit 78 on any problem). */
final class Preflight extends Command
{
    protected $signature = 'agrotrace:preflight';

    protected $description = 'Validate the environment of an AgroTrace process (exit 78 on invalid configuration)';

    public function handle(): int
    {
        $env = [];
        foreach (getenv() as $k => $v) {
            $env[(string) $k] = $v;
        }
        $problems = EnvConfig::problems($env);
        if ($problems === []) {
            return self::SUCCESS;
        }
        fwrite(STDERR, "invalid configuration:\n".implode('', array_map(fn ($p) => "  - {$p}\n", $problems)));

        return EnvConfig::EXIT_CONFIG;
    }
}
