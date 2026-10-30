<?php

namespace App\Infrastructure\Svg;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Infrastructure\Sandbox\Lane;
use App\Infrastructure\Sandbox\LaneOptions;
use App\Infrastructure\Sandbox\LaneRefused;

/**
 * SVG logo sanitization (spec 8.6, Review Focus #5, P15, P18; Express infra/svg.ts `sanitizeSvg`):
 * 1. strict UTF-8 (a leading BOM dropped, as TextDecoder does);
 * 2. the linear pre-scan (SvgScanner) before any DOM;
 * 3. the DOM work (SvgDom) in the sandbox — two lanes, documents up to 64 KiB and larger ones, each 1 running + 8
 *    waiting per container, 3 s from enqueue; a full queue, a missed deadline or a crash → too complex.
 * Every refusal is 415 UNSUPPORTED_MEDIA_TYPE `{allowed}`, complexity ones with `reason: "svg-too-complex"`.
 * The caller holds no DB slot (P61).
 */
final class SvgSanitizer
{
    public const SMALL_LANE_BYTES = 65536;

    public const WAITING = 8;

    public const DEADLINE_SEC = 3.0;

    /**
     * @param  list<string>  $allowed  the 415 `params.allowed`
     * @param  null|callable(): bool  $clientGone
     */
    public static function sanitize(string $bytes, array $allowed, ?callable $clientGone = null): string
    {
        if (! mb_check_encoding($bytes, 'UTF-8')) {
            throw SvgScanner::refusal($allowed, false);
        }
        $text = str_starts_with($bytes, "\u{FEFF}") ? substr($bytes, 3) : $bytes;
        SvgScanner::scan($text, $allowed);
        $lane = strlen($bytes) <= self::SMALL_LANE_BYTES ? 'svg-small' : 'svg-large';
        try {
            $out = Lane::run(
                base_path('resources/sandbox/svg-sanitize.php'),
                $text,
                new LaneOptions($lane, self::WAITING, self::DEADLINE_SEC, '256M'),
                $clientGone,
            );
        } catch (LaneRefused $e) {
            throw SvgScanner::refusal($allowed, $e->reason === 'too-complex');
        }
        $result = json_decode($out, true);
        $svg = is_array($result) ? ($result['svg'] ?? null) : null;
        if (! is_string($svg)) {
            throw new Problem(415, ProblemCode::UNSUPPORTED_MEDIA_TYPE, params: ['allowed' => $allowed]);
        }

        return $svg;
    }
}
