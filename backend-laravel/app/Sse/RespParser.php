<?php

namespace App\Sse;

/**
 * RESP2 replies parsed from a byte buffer that may end anywhere (RespSubscriber): simple string `+`, error `-`
 * (a RespError value), integer `:`, bulk string `$` (null for -1), array `*` (null for -1), nested arrays. INCOMPLETE
 * when the buffer holds no whole reply yet — nothing is consumed then.
 */
final class RespParser
{
    public const INCOMPLETE = "\0incomplete";

    /** One reply starting at $pos; on success $pos is moved past it. */
    public static function parse(string $buf, int &$pos): mixed
    {
        $at = $pos;
        $r = self::one($buf, $at);
        if ($r !== self::INCOMPLETE) {
            $pos = $at;
        }

        return $r;
    }

    private static function one(string $buf, int &$at): mixed
    {
        $eol = strpos($buf, "\r\n", $at);
        if ($eol === false || $eol === $at) {
            return $eol === $at ? new RespError('redis protocol error: empty line') : self::INCOMPLETE;
        }
        $type = $buf[$at];
        $line = substr($buf, $at + 1, $eol - $at - 1);
        $next = $eol + 2;
        switch ($type) {
            case '+':
                $at = $next;

                return $line;
            case '-':
                $at = $next;

                return new RespError("redis: {$line}");
            case ':':
                $at = $next;

                return (int) $line;
            case '$':
                $len = (int) $line;
                if ($len < 0) {
                    $at = $next;

                    return null;
                }
                if (strlen($buf) < $next + $len + 2) {
                    return self::INCOMPLETE;
                }
                if (substr($buf, $next + $len, 2) !== "\r\n") {
                    return new RespError('redis protocol error: a bulk string without its CRLF');
                }
                $at = $next + $len + 2;

                return substr($buf, $next, $len);
            case '*':
                $n = (int) $line;
                if ($n < 0) {
                    $at = $next;

                    return null;
                }
                $items = [];
                $cursor = $next;
                for ($i = 0; $i < $n; $i++) {
                    $item = self::one($buf, $cursor);
                    if ($item === self::INCOMPLETE) {
                        return self::INCOMPLETE;
                    }
                    $items[] = $item;
                }
                $at = $cursor;

                return $items;
            default:
                return new RespError('redis protocol error: unexpected type byte '.bin2hex($type));
        }
    }
}
