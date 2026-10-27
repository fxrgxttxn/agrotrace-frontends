<?php

/*
 * P8 (final review I1): the bot token is part of every Telegram URL (`/bot<token>/<method>`), and Guzzle appends
 * `for <uri>` to every cURL error — the token must never reach a TelegramError message (logged by the poller and the
 * delivery as `err`) nor its exception chain. Express's fetch errors carry no URL (`fetch failed`).
 */

use App\Infrastructure\Telegram\Telegram;
use App\Infrastructure\Telegram\TelegramError;
use App\Support\Logging\JsonLineFormatter;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\Psr7\Response;
use Monolog\Level;
use Monolog\LogRecord;
use Tests\TestCase;

uses(TestCase::class);

const TG_TOKEN = '123456:SECRET-TOKEN_value';

/** @return TelegramError the error of one sendMessage */
function tgError(Telegram $tg): TelegramError
{
    try {
        $tg->sendMessage('42', 'hi', 1.0);
    } catch (TelegramError $e) {
        return $e;
    }
    throw new RuntimeException('no TelegramError');
}

function assertNoToken(TelegramError $e): void
{
    for ($x = $e; $x !== null; $x = $x->getPrevious()) {
        expect($x->getMessage())->not->toContain(TG_TOKEN)->not->toContain('SECRET');
    }
    $line = (new JsonLineFormatter)->format(new LogRecord(new DateTimeImmutable, 'app', Level::Warning,
        'notification send failed', ['err' => $e->getMessage(), 'e' => $e]));
    expect($line)->not->toContain('SECRET');
}

it('a refused connection is "fetch failed", without the URL and its token', function () {
    $e = tgError(new Telegram(TG_TOKEN, 'http://127.0.0.1:1'));
    expect($e->getMessage())->toBe('telegram sendMessage: fetch failed');
    assertNoToken($e);
});

it('a timeout says so, without the URL', function () {
    $tg = new Telegram(TG_TOKEN, 'http://10.255.255.1:81'); // unroutable: the connect times out, unless the network refuses it at once
    $t0 = microtime(true);
    $e = tgError($tg);
    expect(microtime(true) - $t0)->toBeLessThan(3.0);
    expect($e->getMessage())->toBeIn(['telegram sendMessage: timeout', 'telegram sendMessage: fetch failed']);
    assertNoToken($e);
});

it('an API answer that echoes the token is masked too', function () {
    $mock = new MockHandler([new Response(401, [], json_encode(['ok' => false, 'description' => 'Unauthorized bot'.TG_TOKEN]))]);
    $e = tgError(new Telegram(TG_TOKEN, 'http://telegram.test', $mock));
    expect($e->getMessage())->toBe('telegram sendMessage: 401 Unauthorized bot***');
    assertNoToken($e);
});
