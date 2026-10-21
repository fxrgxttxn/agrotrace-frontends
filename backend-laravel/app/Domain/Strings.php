<?php

namespace App\Domain;

/**
 * R21, R92: strings compare by Unicode code point — UTF-8 byte order, PostgreSQL `COLLATE "C"`, JavaScript
 * compareCodePoints, PHP strcmp. Returns -1, 0 or 1.
 */
final class Strings
{
    public static function compareCodePoints(string $a, string $b): int
    {
        return strcmp($a, $b) <=> 0;
    }
}
