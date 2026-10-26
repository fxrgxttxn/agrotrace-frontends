<?php

/*
 * The Telegram poller (contract info.description, shared Redis keys `tg:poller`, `tgcode:{code}`; Express
 * infra/telegram.ts) on the stand's Redis with a fake Bot API:
 * - RENEW is the contract's compare-and-PEXPIRE text byte for byte;
 * - only the holder of the key polls; the offset moves past an update once it was handled, and a failed link is seen
 *   again; an immediately empty answer is followed by a 1 s pause;
 * - a renewal that returns 0 (the key went to another instance) aborts the long poll in flight at once and polling
 *   stops; stop() aborts it too and hands the key over;
 * - `/start <code>` (also `/start@bot`) links through GETDEL, once; anything else is ignored.
 */

use App\Infrastructure\Redis\SharedRedis;
use App\Infrastructure\Telegram\Poller;
use App\Infrastructure\Telegram\UpdatesPort;
use GuzzleHttp\Promise\Promise;
use GuzzleHttp\Promise\PromiseInterface;
use GuzzleHttp\Promise\Utils;
use Illuminate\Support\Facades\DB;
use Tests\Support\EngFixture;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

final class FakeBot implements UpdatesPort
{
    /** @var list<array{offset: ?int, timeout: int}> */
    public array $polls = [];

    /** @var list<list<array<string, mixed>>|Throwable|'hang'> answers, one per poll ('hang': never answers) */
    public array $answers = [];

    public ?Promise $hanging = null;

    public bool $cancelled = false;

    /** @var null|Closure(): void */
    public ?Closure $onTick = null;

    public function configured(): bool
    {
        return true;
    }

    public function getUpdatesAsync(?int $offset, int $timeoutSec): PromiseInterface
    {
        $this->polls[] = ['offset' => $offset, 'timeout' => $timeoutSec];
        $a = array_shift($this->answers) ?? 'hang';
        if ($a === 'hang') {
            $this->hanging = new Promise(null, function () {
                $this->cancelled = true;
            });

            return $this->hanging;
        }
        $p = new Promise;
        $a instanceof Throwable ? $p->reject($a) : $p->resolve($a);

        return $p;
    }

    public function tick(): void
    {
        Utils::queue()->run();
        if ($this->onTick !== null) {
            ($this->onTick)();
        }
        usleep(10_000);
    }
}

beforeEach(function () {
    $this->key = 'tg:poller:test:'.bin2hex(random_bytes(4));
    $this->redis = SharedRedis::client();
});

afterEach(function () {
    $this->redis->del($this->key);
});

it('renews with the contract\'s Lua text', function () {
    $contract = (string) file_get_contents(dirname(__DIR__, 4).'/contracts/openapi.yaml');
    expect($contract)->toContain('compare-and-PEXPIRE: `'.Poller::RENEW.'`');
});

it('matches /start <code> as the JavaScript pattern does', function () {
    foreach (['/start abc' => 'abc', '/start@agrotrace_bot  X-1 ' => 'X-1', "/start\u{00A0}k\u{3000}" => 'k', "/start a\n" => 'a'] as $text => $code) {
        expect(preg_match(Poller::START, $text, $m))->toBe(1, $text);
        expect($m[1])->toBe($code);
    }
    foreach (['/start', '/start ', 'start abc', '/start a b', '/startabc', '/start@bot-x abc', ' /start abc'] as $text) {
        expect(preg_match(Poller::START, $text))->toBe(0, $text);
    }
});

it('polls only while holding the key; the offset moves past handled updates only; an empty answer pauses 1 s', function () {
    $bot = new FakeBot;
    $linked = [];
    $failOnce = true;
    $bot->answers = [
        [['update_id' => 7, 'message' => ['text' => '/start c1', 'chat' => ['id' => 42]]], ['update_id' => 8, 'message' => ['text' => 'hello']]],
        [['update_id' => 9, 'message' => ['text' => '/start c2', 'chat' => ['id' => 43]]]], // its link fails once
        [['update_id' => 9, 'message' => ['text' => '/start c2', 'chat' => ['id' => 43]]]],
        [],
    ];
    $poller = new Poller($bot, $this->redis, 'test-instance', idleSec: 0.05, key: $this->key,
        link: function (string $code, string $chat) use (&$linked, &$failOnce): bool {
            if ($code === 'c2' && $failOnce) {
                $failOnce = false;
                throw new RuntimeException('db down');
            }
            $linked[] = "{$code}:{$chat}";

            return true;
        });
    $started = null;
    $bot->onTick = function () use ($bot, $poller, &$started) {
        if (count($bot->polls) === 5) {
            $started ??= microtime(true);
            $poller->stop();
        }
    };
    $t = microtime(true);
    $poller->run();
    expect($linked)->toBe(['c1:42', 'c2:43']);
    expect(array_column($bot->polls, 'offset'))->toBe([null, 9, 9, 10, 10]);
    expect(array_column($bot->polls, 'timeout'))->toBe([25, 25, 25, 25, 25]);
    expect(microtime(true) - $t)->toBeGreaterThan(1.0); // the pause after the empty answer
    expect($bot->cancelled)->toBeTrue(); // stop() aborted the long poll in flight
    expect($this->redis->get($this->key))->toBeFalse(); // handed over
});

it('another holder of the key: no poll at all', function () {
    $this->redis->set($this->key, 'someone-else', ['ex' => 30]);
    $bot = new FakeBot;
    $poller = new Poller($bot, $this->redis, 'test-instance', idleSec: 0.05, key: $this->key);
    $stopAt = microtime(true) + 0.4;
    $bot->onTick = fn () => null;
    pcntl_async_signals(true);
    pcntl_signal(SIGALRM, fn () => $poller->stop());
    pcntl_alarm(1);
    $poller->run();
    pcntl_signal(SIGALRM, SIG_DFL);
    expect($bot->polls)->toBe([]);
    expect($this->redis->get($this->key))->toBe('someone-else'); // never deleted a key that is not ours
    expect(microtime(true))->toBeGreaterThan($stopAt);
});

it('a renewal that returns 0 aborts the long poll in flight at once and stops polling', function () {
    $bot = new FakeBot;
    $bot->answers = ['hang'];
    $poller = new Poller($bot, $this->redis, 'test-instance', idleSec: 0.05, key: $this->key, renewEverySec: 0.2);
    $lostAt = null;
    $abortedAt = null;
    $bot->onTick = function () use ($bot, &$lostAt, &$abortedAt) {
        if ($lostAt === null && $this->redis->get($this->key) === 'test-instance') {
            $this->redis->set($this->key, 'new-owner', ['ex' => 30]); // the key expired and was taken
            $lostAt = microtime(true);
        }
        if ($bot->cancelled && $abortedAt === null) {
            $abortedAt = microtime(true);
        }
    };
    // Ends the run: after the loss the poller only competes for the key again.
    pcntl_async_signals(true);
    pcntl_signal(SIGALRM, fn () => $poller->stop());
    pcntl_alarm(2);
    $t = microtime(true);
    $poller->run();
    pcntl_alarm(0);
    pcntl_signal(SIGALRM, SIG_DFL);
    expect($bot->cancelled)->toBeTrue();
    expect($abortedAt - $lostAt)->toBeLessThan(0.5); // at the next renewal (every 0.2 s here)
    expect($bot->polls)->toHaveCount(1);
    expect($this->redis->get($this->key))->toBe('new-owner'); // the new owner's key is left alone
    expect(microtime(true) - $t)->toBeLessThan(3.0); // then it only competes for the key (the alarm stops it)
});

it('links a chat through GETDEL tgcode:{code}, once', function () {
    $this->requireDatabase();
    $fx = new EngFixture;
    try {
        $user = $fx->user($fx->org('FARM'), 'FARMER');
        $code = 'test'.bin2hex(random_bytes(4));
        $this->redis->set("tgcode:{$code}", json_encode(['userId' => $user]), ['ex' => 60]);
        expect(Poller::linkByCode($this->redis, $code, '987654321'))->toBeTrue();
        expect(DB::selectOne('SELECT telegram_chat_id::text AS c FROM users WHERE id = ?', [$user])->c)->toBe('987654321');
        expect(Poller::linkByCode($this->redis, $code, '1'))->toBeFalse(); // one-time
        expect($this->redis->exists("tgcode:{$code}"))->toBe(0);
        $this->redis->set("tgcode:{$code}x", 'not json', ['ex' => 60]);
        expect(Poller::linkByCode($this->redis, $code.'x', '1'))->toBeFalse();
    } finally {
        $fx->cleanup();
    }
});
