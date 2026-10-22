<?php

/*
 * P18 under FrankenPHP (fix round 1, I2): the client is gone when no socket of the peer address is ESTABLISHED in
 * /proc/net/tcp; unknown peers are never gone; the table is read at most every 50 ms per request.
 */

use App\Http\ClientConnection;
use Illuminate\Http\Request;
use Tests\TestCase;

uses(TestCase::class);

const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

function tcpLine(int $sl, string $local, string $remote, string $state): string
{
    return sprintf("%4d: %s %s %s 00000000:00000000 00:00000000 00000000     0        0 1234 1 0000000000000000 20 4 30 10 -1\n", $sl, $local, $remote, $state);
}

it('writes the peer as /proc/net/tcp does and refuses what it cannot judge', function () {
    expect(ClientConnection::peer('127.0.0.1', '57280'))->toBe('0100007F:DFC0');
    expect(ClientConnection::peer('172.18.0.5', 8080))->toBe('050012AC:1F90');
    expect(ClientConnection::peer('::1', '57280'))->toBeNull();
    expect(ClientConnection::peer('127.0.0.1', null))->toBeNull();
    expect(ClientConnection::peer(null, '1'))->toBeNull();
    expect(ClientConnection::peer('127.0.0.1', '0'))->toBeNull();
});

it('is gone only when no socket of the peer is ESTABLISHED', function () {
    $peer = '0100007F:DFC0';
    $both = TCP_HEADER.tcpLine(0, '0100007F:1F90', $peer, '01').tcpLine(1, $peer, '0100007F:1F90', '01');
    expect(ClientConnection::goneIn($both, $peer))->toBeFalse();
    $closing = TCP_HEADER.tcpLine(0, '0100007F:1F90', $peer, '08').tcpLine(1, $peer, '0100007F:1F90', '05');
    expect(ClientConnection::goneIn($closing, $peer))->toBeTrue();
    expect(ClientConnection::goneIn(TCP_HEADER.tcpLine(0, '0100007F:1F90', '0100007F:DFC1', '01'), $peer))->toBeTrue();
    // A port that merely contains the peer's digits elsewhere on the line does not count.
    expect(ClientConnection::goneIn(TCP_HEADER.tcpLine(0, '0100007F:1F90', '0100007F:DFC01', '01'), $peer))->toBeTrue();
    expect(ClientConnection::goneIn(tcpLine(0, $peer, '0100007F:1F90', '01'), $peer))->toBeFalse();
});

it('watches the request\'s peer, at most every 50 ms, and stays gone', function () {
    $file = tempnam(sys_get_temp_dir(), 'tcp');
    $peer = '0100007F:DFC0';
    file_put_contents($file, TCP_HEADER.tcpLine(0, '0100007F:1F90', $peer, '01'));
    $request = Request::create('/x', 'PUT', server: ['REMOTE_ADDR' => '127.0.0.1', 'REMOTE_PORT' => '57280']);
    $gone = ClientConnection::watcher($request, $file);
    expect($gone())->toBeFalse();
    file_put_contents($file, TCP_HEADER.tcpLine(0, '0100007F:1F90', $peer, '08'));
    expect($gone())->toBeFalse(); // throttled
    usleep(60_000);
    expect($gone())->toBeTrue();
    file_put_contents($file, TCP_HEADER.tcpLine(0, '0100007F:1F90', $peer, '01'));
    usleep(60_000);
    expect($gone())->toBeTrue();
    unlink($file);

    $unknown = ClientConnection::watcher(Request::create('/x', 'PUT', server: ['REMOTE_ADDR' => '127.0.0.1']), '/nonexistent');
    expect($unknown())->toBeFalse();
    $noProc = ClientConnection::watcher($request, '/nonexistent');
    expect($noProc())->toBeFalse();
});
