<?php

namespace Tests\Support;

use App\Http\Idempotency\IdemRecord;
use App\Http\Idempotency\IdemStore;
use App\Support\Json;

/** IdemStore in memory, with the semantics of the Redis one (claim = SET NX, complete/release = own pending only). */
final class MemoryIdemStore implements IdemStore
{
    /** @var array<string, string> raw JSON records */
    public array $records = [];

    /** @var list<string> */
    public array $calls = [];

    /** Expire the key right after the next failed claim (the "expired between SET NX and GET" race). */
    public bool $expireAfterFailedClaim = false;

    public function claim(string $key, string $fingerprint): bool
    {
        $this->calls[] = "claim {$key}";
        if (isset($this->records[$key])) {
            if ($this->expireAfterFailedClaim) {
                $this->expireAfterFailedClaim = false;
                unset($this->records[$key]);
            }

            return false;
        }
        $this->records[$key] = Json::encode(['fingerprint' => $fingerprint, 'state' => 'pending']);

        return true;
    }

    public function get(string $key): ?IdemRecord
    {
        $this->calls[] = "get {$key}";

        return isset($this->records[$key]) ? IdemRecord::fromJson($this->records[$key]) : null;
    }

    public function complete(string $key, string $fingerprint, int $status, mixed $body): bool
    {
        $this->calls[] = "complete {$key} {$status}";
        if (! $this->ownPending($key, $fingerprint)) {
            return false;
        }
        $this->records[$key] = Json::encode(['fingerprint' => $fingerprint, 'state' => 'done', 'status' => $status, 'body' => $body]);

        return true;
    }

    public function release(string $key, string $fingerprint): bool
    {
        $this->calls[] = "release {$key}";
        if (! $this->ownPending($key, $fingerprint)) {
            return false;
        }
        unset($this->records[$key]);

        return true;
    }

    public function state(string $key): ?string
    {
        $r = isset($this->records[$key]) ? IdemRecord::fromJson($this->records[$key]) : null;

        return $r === null ? null : (string) $r->state;
    }

    private function ownPending(string $key, string $fingerprint): bool
    {
        $r = isset($this->records[$key]) ? IdemRecord::fromJson($this->records[$key]) : null;

        return $r !== null && $r->fingerprint === $fingerprint && $r->state === 'pending';
    }
}
