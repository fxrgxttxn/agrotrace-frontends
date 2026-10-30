<?php

/*
 * The cap on open SSE streams (fix round 1, I1): past SSE_MAX_STREAMS a stream is answered at once with a 200 that
 * carries only `retry:` (an EventSource reconnects later; FrankenPHP would otherwise park it with no answer at all),
 * while the 401 and the `user` limit still come first; a place is given back exactly once.
 */

use App\Security\Jwt;
use App\Sse\SseFrame;
use App\Sse\StreamAdmission;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Tests\TestCase;

uses(TestCase::class);

beforeEach(function () {
    if (! function_exists('apcu_enabled') || ! apcu_enabled()) {
        $this->fail('APCu is off in the CLI (docker/php.ini: apc.enable_cli = 1)');
    }
    apcu_delete(new APCUIterator('/^agrotrace:sse:open-streams/'));
});

afterEach(fn () => apcu_delete(new APCUIterator('/^agrotrace:sse:open-streams/')));

it('admits up to the cap, refuses past it without holding a place, and gives a place back once', function () {
    $a = new StreamAdmission(2);
    $b = new StreamAdmission(2);
    $c = new StreamAdmission(2);
    expect($a->enter())->toBeTrue();
    expect($b->enter())->toBeTrue();
    expect($c->enter())->toBeFalse();
    expect($a->open())->toBe(2);
    $c->leave(); // refused: holds nothing
    expect($a->open())->toBe(2);
    $a->leave();
    $a->leave(); // the finally and the shutdown function: once
    expect($b->open())->toBe(1);
    expect($c->enter())->toBeTrue();
    $b->leave();
    $c->leave();
    expect($c->open())->toBe(0);
});

it('counts from zero again after APCu lost the entry while streams were open', function () {
    $a = new StreamAdmission(1);
    expect($a->enter())->toBeTrue();
    apcu_delete(StreamAdmission::KEY);
    $a->leave();
    expect($a->open())->toBe(0);
    expect(apcu_fetch(StreamAdmission::KEY))->toBe(0);
    expect((new StreamAdmission(1))->enter())->toBeTrue();
});

it('writes the over-cap answer as a lone retry field', function () {
    expect(SseFrame::retry(7000))->toBe("retry: 7000\n\n");
});

/** The body of a StreamedResponse as the client would read it. */
function streamedBody(StreamedResponse $res): string
{
    $level = ob_get_level();
    ob_start();
    try {
        $res->sendContent();
    } finally {
        $out = '';
        while (ob_get_level() > $level) {
            $out = ob_get_clean().$out;
        }
    }

    return $out;
}

it('answers a stream past the cap at once: 200, the SSE headers, only `retry:` (401 and 429 first)', function () {
    config([
        'agrotrace.jwt_secret' => 'jwt_test_secret_of_at_least_32_bytes!!',
        'agrotrace.rate_limit_overrides' => '{"user":100000}',
        'agrotrace.sse_max_streams' => 3,
    ]);
    apcu_store(StreamAdmission::KEY, 3);
    $anon = $this->raw('GET', '/api/v1/events/stream?access_token=bad');
    expect($anon->getStatusCode())->toBe(401);

    $token = Jwt::issue('11111111-1111-4111-8111-'.bin2hex(random_bytes(6)), '22222222-2222-4222-8222-222222222222', ['FARMER'], false);
    $res = $this->raw('GET', '/api/v1/events/stream?access_token='.$token);
    expect($res->getStatusCode())->toBe(200);
    expect($res->headers->get('Content-Type'))->toBe('text/event-stream; charset=utf-8');
    expect($res->headers->get('Cache-Control'))->toBe('no-cache');
    $t = microtime(true);
    $body = streamedBody($res->baseResponse);
    expect(microtime(true) - $t)->toBeLessThan(1.0);
    expect($body)->toMatch('/^retry: (\d+)\n\n$/D');
    $ms = (int) substr($body, 7);
    expect($ms)->toBeGreaterThanOrEqual(5000)->toBeLessThanOrEqual(15000);
    expect(apcu_fetch(StreamAdmission::KEY))->toBe(3); // the refused stream holds no place
})->group('integration');

it('caps the streams of one user too: past it nothing is held, and other users still get in', function () {
    $mine = [new StreamAdmission(10, 'u1', 2), new StreamAdmission(10, 'u1', 2)];
    foreach ($mine as $a) {
        expect($a->enter())->toBeTrue();
    }
    $third = new StreamAdmission(10, 'u1', 2);
    expect($third->enter())->toBeFalse();
    expect($third->openOfUser())->toBe(2);
    expect($third->open())->toBe(2);
    $other = new StreamAdmission(10, 'u2', 2);
    expect($other->enter())->toBeTrue();
    expect($other->open())->toBe(3);
    // The global cap refuses after the user's place was taken: that place is given back.
    $full = new StreamAdmission(3, 'u3', 2);
    expect($full->enter())->toBeFalse();
    expect($full->openOfUser())->toBe(0);
    expect($full->open())->toBe(3);
    $mine[0]->leave();
    $mine[0]->leave();
    expect($third->enter())->toBeTrue();
    foreach ([$mine[1], $third, $other] as $a) {
        $a->leave();
    }
    expect($other->open())->toBe(0);
    expect($third->openOfUser())->toBe(0);
    expect($other->openOfUser())->toBe(0);
});

it('answers a user past their own cap with the same immediate `retry:`', function () {
    config([
        'agrotrace.jwt_secret' => 'jwt_test_secret_of_at_least_32_bytes!!',
        'agrotrace.rate_limit_overrides' => '{"user":100000}',
        'agrotrace.sse_max_streams' => 200,
        'agrotrace.sse_max_streams_per_user' => 2,
    ]);
    $user = '11111111-1111-4111-8111-'.bin2hex(random_bytes(6));
    apcu_store(StreamAdmission::KEY.':'.$user, 2);
    $token = Jwt::issue($user, '22222222-2222-4222-8222-222222222222', ['FARMER'], false);
    $res = $this->raw('GET', '/api/v1/events/stream?access_token='.$token);
    expect($res->getStatusCode())->toBe(200);
    expect(streamedBody($res->baseResponse))->toMatch('/^retry: \d+\n\n$/D');
    expect(apcu_fetch(StreamAdmission::KEY.':'.$user))->toBe(2);
    expect((int) apcu_fetch(StreamAdmission::KEY))->toBe(0);
})->group('integration');
