<?php

namespace Tests\Support;

use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;

/**
 * The PHP sources of app/ for the static guards (Task 14): every file, and its tokens without comments, whitespace and
 * inline HTML, each with its line.
 */
final class SourceScan
{
    /** @return list<string> paths relative to the backend root (`app/…`), sorted */
    public static function appFiles(): array
    {
        $root = base_path('app');
        $out = [];
        foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, RecursiveDirectoryIterator::SKIP_DOTS)) as $f) {
            if ($f->isFile() && $f->getExtension() === 'php') {
                $out[] = 'app/'.str_replace('\\', '/', substr($f->getPathname(), strlen($root) + 1));
            }
        }
        sort($out);

        return $out;
    }

    /** @return list<\PhpToken> */
    public static function code(string $file): array
    {
        return array_values(array_filter(
            \PhpToken::tokenize((string) file_get_contents(base_path($file))),
            fn (\PhpToken $t) => ! $t->isIgnorable() && ! $t->is(T_INLINE_HTML),
        ));
    }
}
