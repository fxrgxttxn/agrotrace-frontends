<?php

/*
 * Sandbox child of the SVG lanes (L6, P15/P18; App\Infrastructure\Sandbox\Lane): the DOM sanitization of one logo,
 * off the Octane worker. No Laravel: only the two framework-free classes it needs. Protocol: `ready\n` once loaded,
 * the document on stdin (to EOF), one JSON line on stdout: {"svg": "<sanitized>"} or {"svg": null}.
 */

declare(strict_types=1);

require __DIR__.'/../../app/Http/Validation/Ecma.php';
require __DIR__.'/../../app/Infrastructure/Svg/SvgDom.php';

use App\Infrastructure\Svg\SvgDom;

// Warm up libxml and the class before reporting ready (the job's clock starts at `ready`).
SvgDom::sanitize('<svg xmlns="http://www.w3.org/2000/svg"/>');
sandbox_ready(); // limits.php, the Lane's prelude: `ready`, then the child's own alarm on the job's budget

$input = stream_get_contents(STDIN);
try {
    $svg = is_string($input) ? SvgDom::sanitize($input) : null;
} catch (Throwable) {
    $svg = null;
}
fwrite(STDOUT, json_encode(['svg' => $svg], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
exit(0);
