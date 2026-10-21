<?php

namespace App\Support;

use App\Security\Principal;

/**
 * Per-request context (the AsyncLocalStorage context of Express): request id, client IP, the principal, the ids of
 * the outbox events the request committed (published right after the response) and the after-response callbacks.
 * A `scoped` container binding (AppServiceProvider): Octane gives every request a fresh one, so nothing leaks into the
 * next request (Review Focus 4). Outside a request (worker, scheduler, tests) everything is null/empty; a worker sets
 * the handled event's requestId with `begin()`.
 */
final class RequestContext
{
    private ?string $requestId = null;

    private ?string $clientIp = null;

    private ?Principal $principal = null;

    /** @var list<string> */
    private array $eventIds = [];

    /** @var list<callable> */
    private array $afterResponse = [];

    public function begin(?string $requestId, ?string $clientIp): void
    {
        $this->requestId = $requestId;
        $this->clientIp = $clientIp;
    }

    public function requestId(): ?string
    {
        return $this->requestId;
    }

    public function clientIp(): ?string
    {
        return $this->clientIp;
    }

    public function principal(): ?Principal
    {
        return $this->principal;
    }

    public function setPrincipal(?Principal $principal): void
    {
        $this->principal = $principal;
    }

    /** An outbox event committed by this request (Tx::afterCommit of Outbox::enqueue) — the relay publishes it. */
    public function addEventId(string $id): void
    {
        $this->eventIds[] = $id;
    }

    /** @return list<string> */
    public function eventIds(): array
    {
        return $this->eventIds;
    }

    /** Runs after the response has been sent (App\Octane\EndOfRequest), before the DB connection is closed. */
    public function afterResponse(callable $callback): void
    {
        $this->afterResponse[] = $callback;
    }

    /**
     * The pending after-response callbacks, removed from the context (each runs once).
     *
     * @return list<callable>
     */
    public function takeAfterResponse(): array
    {
        $out = $this->afterResponse;
        $this->afterResponse = [];

        return $out;
    }
}
