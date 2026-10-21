<?php

namespace App\Contract;

use RuntimeException;

/**
 * contracts/rules/*.json (state machines, trust rating, rate limits, notifications, ALTCHA, vectors). The image carries
 * a copy in resources/contract/rules (Dockerfile); in the repository (php-tools) the files of contracts/rules
 * themselves are read. Framework-free (the domain uses it) and stateless: the files are small and read when asked.
 */
final class RulesRepo
{
    public static function dir(): string
    {
        $env = getenv('AGROTRACE_RULES_PATH');
        if (is_string($env) && $env !== '') {
            return rtrim($env, '/');
        }
        $image = dirname(__DIR__, 2).'/resources/contract/rules';
        if (is_dir($image)) {
            return $image;
        }

        return dirname(__DIR__, 3).'/contracts/rules';
    }

    /**
     * The decoded file `contracts/rules/<name>.json` (associative arrays).
     *
     * @return array<mixed>
     */
    public static function json(string $name): array
    {
        if (! preg_match('/^[a-z0-9-]+(\/[A-Za-z0-9-]+)?$/D', $name)) {
            throw new RuntimeException("invalid rules name {$name}");
        }
        $file = self::dir()."/{$name}.json";
        $raw = @file_get_contents($file);
        if ($raw === false) {
            throw new RuntimeException("contract rules file not found: {$file}");
        }
        $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        if (! is_array($data)) {
            throw new RuntimeException("contract rules file is not a JSON object: {$file}");
        }

        return $data;
    }
}
