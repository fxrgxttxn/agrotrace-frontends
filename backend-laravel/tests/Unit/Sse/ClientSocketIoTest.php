<?php

/*
 * App\Sse\ClientSocketIo against /proc/net/tcp fixtures (review minors 6 and 7): the client peer HAProxy writes (IPv4,
 * IPv6, ::ffff:, bracketed; anything else → no peer), the backlog on the path summed from the right sockets, and a
 * cached table read before the stream began is never taken as "the client is gone".
 */

use App\Http\ClientConnection;
use App\Sse\ClientSocketIo;
use Illuminate\Http\Request;
use Tests\TestCase;

uses(TestCase::class);

const SSE_TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

function sseTcpLine(int $sl, string $local, string $remote, int $tx, int $rx, string $state = '01'): string
{
    return sprintf("%4d: %s %s %s %08X:%08X 00:00000000 00000000     0        0 1234 1 0000000000000000 20 4 30 10 -1\n", $sl, $local, $remote, $state, $tx, $rx);
}

it('reads the client peer HAProxy writes, in every form of its address', function () {
    expect(ClientSocketIo::clientPeer('172.18.0.9:51234'))->toBe('090012AC:C822');
    expect(ClientSocketIo::clientPeer('::ffff:172.18.0.9:51234'))->toBe('090012AC:C822');
    expect(ClientSocketIo::clientPeer('[::ffff:172.18.0.9]:51234'))->toBe('090012AC:C822');
    expect(ClientSocketIo::clientPeer('2001:db8::7:1'))->toBe('B80D0120000000000000000007000000:0001');
    expect(ClientSocketIo::clientPeer('[2001:db8::7]:1'))->toBe('B80D0120000000000000000007000000:0001');
    expect(ClientSocketIo::clientPeer(null))->toBeNull();
    foreach (['', 'x', '172.18.0.9', '172.18.0.9:', '172.18.0.9:99999', '999.1.1.1:5', 'host:80'] as $bad) {
        expect(ClientSocketIo::clientPeer($bad))->toBeNull($bad);
    }
});

it('sums the backlog of the three sockets on the path and nothing else', function () {
    $backend = (string) ClientConnection::peer('127.0.0.1', 40000); // HAProxy's end towards FrankenPHP
    $client = (string) ClientConnection::peer('172.18.0.9', 51234);
    $table = SSE_TCP_HEADER
        .sseTcpLine(0, '0100007F:1F90', $backend, 1000, 7)        // FrankenPHP → HAProxy: its tx
        .sseTcpLine(1, $backend, '0100007F:1F90', 3, 200)         // HAProxy from FrankenPHP: its rx
        .sseTcpLine(2, '0500A8C0:1F40', $client, 30, 9)           // HAProxy → the client: its tx
        .sseTcpLine(3, '0100007F:1F90', '0100007F:9C41', 5000, 5000) // another stream
        .sseTcpLine(4, '0500A8C0:1F40', '0A0012AC:C822', 5000, 5000); // another client
    expect(ClientSocketIo::backlogIn($table, $backend, $client))->toBe(1230);
    expect(ClientSocketIo::backlogIn(SSE_TCP_HEADER, $backend, $client))->toBe(0);

    $file = tempnam(sys_get_temp_dir(), 'tcp');
    file_put_contents($file, $table);
    $request = Request::create('/x', 'GET', server: ['REMOTE_ADDR' => '127.0.0.1', 'REMOTE_PORT' => '40000']);
    $request->headers->set(ClientSocketIo::PEER_HEADER, '172.18.0.9:51234');
    expect((new ClientSocketIo($request, $file))->backlog())->toBe(1230);
    $request->headers->remove(ClientSocketIo::PEER_HEADER);
    expect((new ClientSocketIo($request, $file))->backlog())->toBeNull();
    unlink($file);
});

it('never judges a stream by a cached table read before the stream began', function () {
    $file = tempnam(sys_get_temp_dir(), 'tcp');
    $request = fn (string $peer) => tap(
        Request::create('/x', 'GET', server: ['REMOTE_ADDR' => '127.0.0.1', 'REMOTE_PORT' => '40000']),
        fn (Request $r) => $r->headers->set(ClientSocketIo::PEER_HEADER, $peer),
    );
    file_put_contents($file, SSE_TCP_HEADER.sseTcpLine(0, '0500A8C0:1F40', (string) ClientConnection::peer('172.18.0.9', 1111), 0, 0));
    $first = new ClientSocketIo($request('172.18.0.9:1111'), $file);
    expect($first->gone())->toBeFalse(); // reads and caches the table: the second client is not in it yet
    // The second client connects; its stream starts within the cached table's TTL.
    usleep(2_000);
    file_put_contents($file, SSE_TCP_HEADER
        .sseTcpLine(0, '0500A8C0:1F40', (string) ClientConnection::peer('172.18.0.9', 1111), 0, 0)
        .sseTcpLine(1, '0500A8C0:1F40', (string) ClientConnection::peer('172.18.0.9', 2222), 0, 0));
    $second = new ClientSocketIo($request('172.18.0.9:2222'), $file);
    expect($second->gone())->toBeFalse();
    // Its socket closing is seen (a fresh read), and the first stream may share that read.
    file_put_contents($file, SSE_TCP_HEADER.sseTcpLine(0, '0500A8C0:1F40', (string) ClientConnection::peer('172.18.0.9', 1111), 0, 0));
    expect((new ClientSocketIo($request('172.18.0.9:2222'), $file))->gone())->toBeTrue();
    expect($first->gone())->toBeFalse();
    unlink($file);
});
