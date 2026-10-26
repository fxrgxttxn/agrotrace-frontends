<?php

namespace App\Infrastructure\Telegram;

use Closure;
use GuzzleHttp\Promise\PromiseInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Redis;
use Throwable;

/**
 * The Telegram poller of the worker (`agrotrace:telegram-poll`; contract info.description, shared Redis keys
 * `tg:poller` and `tgcode:{code}`; Express infra/telegram.ts startTelegramPoller line by line):
 *
 * - only the holder of `tg:poller` polls: `SET tg:poller <laravel:host:pid> NX EX 30`; the owner renews it every 10 s
 *   with the contract's compare-and-PEXPIRE script (RENEW, verbatim); 0 → ownership lost: the long poll in flight is
 *   aborted at once and the process competes for the key again (every 10 s); a Redis error while renewing keeps it;
 * - `getUpdates` long polls 25 s; `/start <code>` (also `/start@bot <code>`) → GETDEL `tgcode:{code}` →
 *   `users.telegram_chat_id`; the offset (`update_id + 1`) moves past an update only once it was handled, so a failed
 *   link is seen again, and it starts afresh with every ownership period (Telegram keeps the confirmed offset);
 * - an empty answer that came back within 1 s is followed by a 1 s pause (a stub must not spin the loop); a failed
 *   poll by a 10 s pause;
 * - stop(): the long poll is aborted, the key handed over (DEL, only while ours); without a token nothing runs.
 */
final class Poller
{
    /** The contract's renewal script (shared Redis keys table, `tg:poller`). */
    public const RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], 30000) end return 0";

    public const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

    /** JavaScript `/^\/start(?:@\w+)?\s+(\S+)\s*$/` — \s is ECMAScript white space, \w ASCII, `$` the end of input. */
    public const START = '/^\/start(?:@[A-Za-z0-9_]+)?[\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+'
        .'([^\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+)'
        .'[\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]*$/uD';

    public const LONG_POLL_SEC = 25;

    public const RENEW_EVERY_SEC = 10.0;

    private bool $stopping = false;

    private ?PromiseInterface $inFlight = null;

    private bool $owner = false;

    private float $nextRenew = 0.0;

    /** @var Closure(string, string): bool */
    private readonly Closure $link;

    /**
     * @param  null|Closure(string, string): bool  $link  code, chatId → linked (default linkByCode)
     */
    public function __construct(
        private readonly UpdatesPort $telegram,
        private readonly Redis $redis,
        public readonly string $instance,
        private readonly float $idleSec = 10.0,
        ?Closure $link = null,
        private readonly string $key = 'tg:poller',
        private readonly float $renewEverySec = self::RENEW_EVERY_SEC,
    ) {
        $this->link = $link ?? fn (string $code, string $chatId): bool => self::linkByCode($this->redis, $code, $chatId);
    }

    public static function instanceId(): string
    {
        return 'laravel:'.gethostname().':'.getmypid();
    }

    public function stop(): void
    {
        $this->stopping = true;
        $this->inFlight?->cancel();
    }

    /** Polls until stop(); returns after handing the key over. */
    public function run(): void
    {
        if (! $this->telegram->configured()) {
            return;
        }
        try {
            while (! $this->stopping) {
                try {
                    if ($this->redis->set($this->key, $this->instance, ['nx', 'ex' => 30]) === true) {
                        $this->ownLoop();
                    }
                } catch (Throwable $e) {
                    Log::warning('telegram poller lock failed', ['err' => $e->getMessage()]);
                }
                if (! $this->stopping) {
                    $this->pause($this->idleSec, null);
                }
            }
        } finally {
            try {
                $this->redis->eval(self::RELEASE, [$this->key, $this->instance], 1);
            } catch (Throwable) {
                // The key expires by itself within 30 s.
            }
        }
    }

    private function ownLoop(): void
    {
        $this->owner = true;
        $this->nextRenew = microtime(true) + $this->renewEverySec;
        $renew = fn () => $this->renew();
        $offset = null; // per ownership period, as Express's `let offset` in ownLoop
        while (! $this->stopping && $this->owner) {
            $started = microtime(true);
            try {
                $this->inFlight = $this->telegram->getUpdatesAsync($offset, self::LONG_POLL_SEC);
                while ($this->inFlight->getState() === PromiseInterface::PENDING) {
                    $this->telegram->tick();
                    $this->renew();
                }
                /** @var mixed $updates */
                $updates = $this->inFlight->wait();
                $this->inFlight = null;
                if (! $this->owner) {
                    break; // the answer of a poll that outlived its ownership is dropped
                }
                $updates = is_array($updates) ? $updates : [];
                foreach ($updates as $u) {
                    $text = $u['message']['text'] ?? '';
                    $chat = $u['message']['chat']['id'] ?? null;
                    if (is_string($text) && (is_int($chat) || is_string($chat)) && preg_match(self::START, $text, $m) === 1) {
                        ($this->link)($m[1], (string) $chat);
                    }
                    // The offset moves past an update only once it was handled (a failed link is seen again).
                    $offset = (int) $u['update_id'] + 1;
                    $this->renew();
                }
                if ($updates === [] && microtime(true) - $started < 1.0) {
                    $this->pause(1.0, $renew);
                }
            } catch (Throwable $e) {
                $this->inFlight = null;
                if ($this->stopping || ! $this->owner) {
                    break;
                }
                Log::warning('telegram poll failed', ['err' => $e->getMessage()]);
                $this->pause($this->idleSec, $renew);
            }
        }
    }

    /** Every 10 s while owner: the contract's compare-and-PEXPIRE; 0 → ownership lost, the poll in flight aborted. */
    private function renew(): void
    {
        if (microtime(true) < $this->nextRenew) {
            return;
        }
        $this->nextRenew += $this->renewEverySec;
        try {
            if ((int) $this->redis->eval(self::RENEW, [$this->key, $this->instance], 1) === 0) {
                $this->owner = false;
                $this->inFlight?->cancel();
            }
        } catch (Throwable) {
            // A Redis error keeps ownership (Express).
        }
    }

    /** Sleeps $sec in short steps (renewing while owner), ending early on stop(). */
    private function pause(float $sec, ?Closure $renew): void
    {
        $until = microtime(true) + $sec;
        while (! $this->stopping && microtime(true) < $until) {
            usleep((int) min(100_000, max(0, ($until - microtime(true)) * 1_000_000)));
            if ($renew !== null) {
                $renew();
            }
        }
    }

    /** `GETDEL tgcode:{code}` (one-time) → `users.telegram_chat_id`; false when the code is unknown or the user gone. */
    public static function linkByCode(Redis $redis, string $code, string $chatId): bool
    {
        $raw = $redis->rawCommand('GETDEL', "tgcode:{$code}");
        if (! is_string($raw)) {
            return false;
        }
        $data = json_decode($raw, true);
        $userId = is_array($data) ? ($data['userId'] ?? null) : null;
        if (! is_string($userId) || preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iD', $userId) !== 1) {
            return false;
        }
        try {
            $n = DB::update('UPDATE users SET telegram_chat_id = ?::bigint WHERE id = ?::uuid AND deleted_at IS NULL', [$chatId, $userId]);
        } finally {
            // The poller holds no connection between links (one in the worker's budget, P61).
            DB::disconnect();
        }
        if ($n === 0) {
            return false;
        }
        Log::info('telegram linked', ['userId' => $userId]);

        return true;
    }
}
