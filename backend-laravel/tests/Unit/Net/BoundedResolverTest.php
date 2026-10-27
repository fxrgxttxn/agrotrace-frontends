<?php

/*
 * The SMTP attempt's deadline covers the name lookup (fix round 1, minor 1): App\Infrastructure\Net\BoundedResolver
 * against a fake nameserver in a child process — /etc/hosts first, `search` and `ndots` as glibc applies them, a CNAME
 * chain, NXDOMAIN, and a silent nameserver that only the deadline ends (DeadlineStream then fails the attempt in time).
 */

use App\Infrastructure\Mail\DeadlineStream;
use App\Infrastructure\Net\BoundedResolver;
use Symfony\Component\Mailer\Exception\TransportException;
use Tests\TestCase;

uses(TestCase::class);

function dnsName(string $name): string
{
    $out = '';
    foreach (explode('.', $name) as $l) {
        $out .= chr(strlen($l)).$l;
    }

    return $out."\0";
}

/**
 * A nameserver on 127.0.0.1 (child process): smtp.test → CNAME real.test → 10.1.2.3, short.corp.test → 10.9.9.9,
 * multi.test → 127.0.0.2 and 127.0.0.1, silent.test → never answers, anything else → NXDOMAIN.
 *
 * @return array{0: int, 1: int} [port, pid]
 */
function fakeNameserver(): array
{
    $srv = stream_socket_server('udp://127.0.0.1:0', $errno, $err, STREAM_SERVER_BIND);
    $name = (string) stream_socket_get_name($srv, false);
    $port = (int) substr($name, strrpos($name, ':') + 1);
    $pid = pcntl_fork();
    if ($pid === 0) {
        $deadline = microtime(true) + 20;
        while (microtime(true) < $deadline) {
            $q = stream_socket_recvfrom($srv, 512, 0, $peer);
            if (! is_string($q) || strlen($q) < 17) {
                continue;
            }
            $id = unpack('n', $q)[1];
            $labels = [];
            for ($at = 12; ($len = ord($q[$at])) !== 0; $at += $len + 1) {
                $labels[] = substr($q, $at + 1, $len);
            }
            $qname = implode('.', $labels);
            $question = substr($q, 12, $at + 5 - 12);
            $an = '';
            $count = 0;
            if ($qname === 'smtp.test') {
                $target = dnsName('real.test');
                $an = "\xC0\x0C".pack('nnNn', 5, 1, 60, strlen($target)).$target
                    .$target.pack('nnNn', 1, 1, 60, 4).inet_pton('10.1.2.3');
                $count = 2;
            } elseif ($qname === 'short.corp.test') {
                $an = "\xC0\x0C".pack('nnNn', 1, 1, 60, 4).inet_pton('10.9.9.9');
                $count = 1;
            } elseif ($qname === 'multi.test') {
                $an = "\xC0\x0C".pack('nnNn', 1, 1, 60, 4).inet_pton('127.0.0.2')
                    ."\xC0\x0C".pack('nnNn', 1, 1, 60, 4).inet_pton('127.0.0.1');
                $count = 2;
            } elseif ($qname === 'silent.test') {
                continue;
            }
            $flags = 0x8180 | ($count === 0 ? 3 : 0);
            stream_socket_sendto($srv, pack('nnnnnn', $id, $flags, 1, $count, 0, 0).$question.$an, 0, $peer);
        }
        posix_kill(posix_getpid(), SIGKILL);
    }
    fclose($srv);

    return [$port, $pid];
}

beforeEach(function () {
    [$this->port, $this->pid] = fakeNameserver();
    $this->hosts = tempnam(sys_get_temp_dir(), 'hosts');
    file_put_contents($this->hosts, "# comment\n127.0.0.1 localhost\n::1 localhost\n10.5.5.5\tmailhost alias # trailing\n");
    $this->conf = tempnam(sys_get_temp_dir(), 'resolv');
    file_put_contents($this->conf, "nameserver 127.0.0.1\nsearch corp.test\noptions ndots:1 timeout:1\n");
    $this->resolver = new BoundedResolver($this->hosts, $this->conf, $this->port);
});

afterEach(function () {
    posix_kill($this->pid, SIGKILL);
    pcntl_waitpid($this->pid, $status);
    unlink($this->hosts);
    unlink($this->conf);
});

it('returns an IP literal as it is and takes /etc/hosts first', function () {
    expect($this->resolver->ipv4('10.0.0.1', microtime(true) + 1))->toBe('10.0.0.1');
    expect($this->resolver->ipv4('MAILHOST', microtime(true) + 1))->toBe('10.5.5.5');
    expect($this->resolver->ipv4('alias.', microtime(true) + 1))->toBe('10.5.5.5');
});

it('asks the nameserver: a CNAME chain, a search domain for a short name, NXDOMAIN', function () {
    expect($this->resolver->ipv4('smtp.test', microtime(true) + 2))->toBe('10.1.2.3');
    expect($this->resolver->ipv4('short', microtime(true) + 2))->toBe('10.9.9.9');
    expect(fn () => $this->resolver->ipv4('nope.test', microtime(true) + 2))->toThrow(RuntimeException::class, 'cannot resolve "nope.test"');
});

it('ends a lookup the nameserver never answers at the deadline, and the SMTP attempt with it', function () {
    $t = microtime(true);
    expect(fn () => $this->resolver->ipv4('silent.test', microtime(true) + 0.4))->toThrow(RuntimeException::class);
    expect(microtime(true) - $t)->toBeLessThan(0.8);

    $t = microtime(true);
    $stream = (new DeadlineStream(microtime(true) + 0.4, 10.0, $this->resolver))->setHost('silent.test')->setPort(25);
    expect(fn () => $stream->initialize())->toThrow(TransportException::class, 'Connection could not be established with host "silent.test:25"');
    expect(microtime(true) - $t)->toBeLessThan(0.8);
});

it('returns every A record, and the SMTP connect fails over to the next address', function () {
    expect($this->resolver->ipv4s('multi.test', microtime(true) + 2))->toBe(['127.0.0.2', '127.0.0.1']);
    $srv = stream_socket_server('tcp://127.0.0.1:0'); // nothing listens on 127.0.0.2 at that port: refused
    $name = (string) stream_socket_get_name($srv, false);
    $port = (int) substr($name, strrpos($name, ':') + 1);
    $stream = (new DeadlineStream(microtime(true) + 2, 10.0, $this->resolver))->setHost('multi.test')->setPort($port);
    $stream->initialize();
    expect(stream_socket_accept($srv, 1))->not->toBeFalse();
    $stream->terminate();
    fclose($srv);
});
