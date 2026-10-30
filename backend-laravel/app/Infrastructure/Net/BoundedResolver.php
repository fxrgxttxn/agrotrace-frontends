<?php

namespace App\Infrastructure\Net;

use RuntimeException;

/**
 * A host name to an IPv4 address by a deadline (fix round 1, minor 1: the SMTP attempt's 30 s include the name
 * lookup). PHP resolves a `tcp://name:port` with getaddrinfo, which blocks inside C with no limit of its own, so the
 * name is looked up here first, the way glibc does it for the stand: /etc/hosts, then A queries over UDP to the
 * nameservers of /etc/resolv.conf (its `search` and `ndots`), every wait a stream_select bounded by the deadline.
 * An IP literal is returned as it is. Every A record of the answer is returned, in its order, so the caller can fail
 * over from one address to the next (DeadlineStream does, as PHP's own connect walks getaddrinfo's list).
 *
 * Known gaps against glibc (fine for the stand's Docker DNS, `nameserver 127.0.0.11` / `ndots:0`; integration
 * backlog, ruling T12 re-review 1):
 * - IPv4 only: no AAAA query, so a host with only AAAA records does not resolve;
 * - UDP only: a truncated answer (TC bit) is taken as it is, with no retry over TCP;
 * - one try per nameserver, at most TRY_SEC each: resolv.conf's `timeout`, `attempts` and `rotate` are ignored;
 * - no nsswitch: /etc/hosts first, then DNS, always;
 * - /etc/hosts gives its first matching IPv4 line only.
 */
final class BoundedResolver
{
    /** A nameserver that does not answer gets at most this long per query (resolv.conf's default `timeout`). */
    private const TRY_SEC = 5.0;

    public function __construct(
        private readonly string $hostsFile = '/etc/hosts',
        private readonly string $resolvConf = '/etc/resolv.conf',
        private readonly int $port = 53,
    ) {}

    /** The first address of ipv4s(). */
    public function ipv4(string $host, float $deadline): string
    {
        return $this->ipv4s($host, $deadline)[0];
    }

    /**
     * @param  float  $deadline  microtime(true) by which the answer must be known
     * @return non-empty-list<string>
     */
    public function ipv4s(string $host, float $deadline): array
    {
        $bare = rtrim($host, '.');
        if (filter_var($bare, FILTER_VALIDATE_IP) !== false) {
            return [$bare];
        }
        $fromHosts = $this->fromHosts($bare);
        if ($fromHosts !== null) {
            return [$fromHosts];
        }
        [$servers, $search, $ndots] = $this->conf();
        if ($servers === []) {
            throw new RuntimeException("cannot resolve \"{$host}\": no nameserver");
        }
        $names = str_ends_with($host, '.') ? [$bare] : (substr_count($bare, '.') >= $ndots
            ? [$bare, ...array_map(fn (string $d) => "{$bare}.{$d}", $search)]
            : [...array_map(fn (string $d) => "{$bare}.{$d}", $search), $bare]);
        foreach ($names as $name) {
            foreach ($servers as $server) {
                $answer = $this->query($server, $name, $deadline);
                if ($answer === false) {
                    continue; // no answer from this server: the next one
                }
                if ($answer !== null) {
                    return $answer;
                }
                break; // the name does not exist (or has no A record): the next name
            }
        }
        throw new RuntimeException("cannot resolve \"{$host}\"");
    }

    /**
     * The addresses; null — the name has none (NXDOMAIN, no A record); false — no usable answer in time.
     *
     * @return non-empty-list<string>|null|false
     */
    private function query(string $server, string $name, float $deadline): array|null|false
    {
        $left = $deadline - microtime(true);
        if ($left <= 0) {
            throw new RuntimeException("cannot resolve \"{$name}\": the deadline passed");
        }
        $s = @stream_socket_client(sprintf(str_contains($server, ':') ? 'udp://[%s]:%d' : 'udp://%s:%d', $server, $this->port), $errno, $err, $left);
        if ($s === false) {
            return false;
        }
        try {
            $id = random_int(0, 0xFFFF);
            $q = pack('nnnnnn', $id, 0x0100, 1, 0, 0, 0);
            foreach (explode('.', $name) as $label) {
                if ($label === '' || strlen($label) > 63) {
                    return null;
                }
                $q .= chr(strlen($label)).$label;
            }
            $q .= "\0".pack('nn', 1, 1);
            if (@fwrite($s, $q) !== strlen($q)) {
                return false;
            }
            $until = min($deadline, microtime(true) + self::TRY_SEC);
            while (($wait = $until - microtime(true)) > 0) {
                $r = [$s];
                $none = null;
                if (@stream_select($r, $none, $none, (int) $wait, (int) (($wait - (int) $wait) * 1_000_000)) !== 1) {
                    break;
                }
                $res = @fread($s, 4096);
                if (! is_string($res) || strlen($res) < 12) {
                    break;
                }
                $h = unpack('nid/nflags/nqd/nan', $res);
                if ($h['id'] !== $id || ($h['flags'] & 0x8000) === 0) {
                    continue; // not the answer to this query
                }

                return match ($h['flags'] & 0xF) {
                    0 => self::allA($res, $h['qd'], $h['an']),
                    3 => null,
                    default => false,
                };
            }

            return false;
        } finally {
            fclose($s);
        }
    }

    /**
     * The IN A records of the answer section in order (a CNAME chain comes first in it), else null.
     *
     * @return non-empty-list<string>|null
     */
    private static function allA(string $res, int $qd, int $an): ?array
    {
        $at = 12;
        for ($i = 0; $i < $qd; $i++) {
            $at = self::skipName($res, $at) + 4;
        }
        $out = [];
        for ($i = 0; $i < $an && $at < strlen($res); $i++) {
            $at = self::skipName($res, $at);
            if ($at + 10 > strlen($res)) {
                break;
            }
            $rr = unpack('ntype/nclass/Nttl/nlen', $res, $at);
            $at += 10;
            if ($rr['type'] === 1 && $rr['class'] === 1 && $rr['len'] === 4 && $at + 4 <= strlen($res)) {
                $out[] = (string) inet_ntop(substr($res, $at, 4));
            }
            $at += $rr['len'];
        }

        return $out !== [] ? $out : null;
    }

    private static function skipName(string $res, int $at): int
    {
        while ($at < strlen($res)) {
            $len = ord($res[$at]);
            if ($len === 0) {
                return $at + 1;
            }
            if (($len & 0xC0) === 0xC0) {
                return $at + 2;
            }
            $at += $len + 1;
        }

        return $at;
    }

    private function fromHosts(string $host): ?string
    {
        $lines = @file($this->hostsFile, FILE_IGNORE_NEW_LINES) ?: [];
        foreach ($lines as $line) {
            $f = preg_split('/\s+/', trim(explode('#', $line, 2)[0]), -1, PREG_SPLIT_NO_EMPTY) ?: [];
            if (count($f) < 2 || filter_var($f[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
                continue;
            }
            foreach (array_slice($f, 1) as $name) {
                if (strcasecmp($name, $host) === 0) {
                    return $f[0];
                }
            }
        }

        return null;
    }

    /** @return array{0: list<string>, 1: list<string>, 2: int} nameservers, search domains, ndots */
    private function conf(): array
    {
        $servers = [];
        $search = [];
        $ndots = 1;
        foreach (@file($this->resolvConf, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
            $f = preg_split('/\s+/', trim(preg_split('/[#;]/', $line, 2)[0]), -1, PREG_SPLIT_NO_EMPTY) ?: [];
            if ($f === []) {
                continue;
            }
            if ($f[0] === 'nameserver' && isset($f[1]) && filter_var($f[1], FILTER_VALIDATE_IP) !== false) {
                $servers[] = $f[1];
            } elseif ($f[0] === 'search' || $f[0] === 'domain') {
                $search = array_slice($f, 1);
            } elseif ($f[0] === 'options') {
                foreach (array_slice($f, 1) as $o) {
                    if (preg_match('/^ndots:(\d+)$/D', $o, $m) === 1) {
                        $ndots = min(15, (int) $m[1]);
                    }
                }
            }
        }

        return [$servers, $search, $ndots];
    }
}
