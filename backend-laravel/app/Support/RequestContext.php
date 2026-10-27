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

    /** @var list<string> */
    private array $pendingNotifications = [];

    private ?string $eventRequestId = null;

    private bool $clientGone = false;

    /** App\Http\ClientConnection saw the client go away during this request (the metrics' 499, P54). */
    public function markClientGone(): void
    {
        $this->clientGone = true;
    }

    public function clientGone(): bool
    {
        return $this->clientGone;
    }

    private ?int $sentAt = null;

    /** EndOfRequest: the response has been sent (hrtime ns) — before any after-response work; the first call wins. */
    public function markSent(): void
    {
        $this->sentAt ??= hrtime(true);
    }

    /** When the response was sent (hrtime ns), null before EndOfRequest ran — the end of the metrics' duration. */
    public function sentAt(): ?int
    {
        return $this->sentAt;
    }

    public function begin(?string $requestId, ?string $clientIp): void
    {
        $this->requestId = $requestId;
        $this->clientIp = $clientIp;
    }

    /**
     * A worker handling an event: its envelope's requestId tags the log lines and the events the handler enqueues
     * (envelope: "an event published by a worker copies the requestId of the event being handled"); audit rows stay
     * system ones (request_id null), as in Express.
     */
    public function beginEvent(?string $eventRequestId): void
    {
        $this->requestId = null;
        $this->clientIp = null;
        $this->eventRequestId = $eventRequestId;
    }

    public function eventRequestId(): ?string
    {
        return $this->eventRequestId;
    }

    /** The id log lines carry: the request's, else the handled event's. */
    public function logRequestId(): ?string
    {
        return $this->requestId ?? $this->eventRequestId;
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

    /**
     * The committed event ids, removed from the context (the relay hand-off runs once).
     *
     * @return list<string>
     */
    public function takeEventIds(): array
    {
        $out = $this->eventIds;
        $this->eventIds = [];

        return $out;
    }

    /**
     * PENDING EMAIL/TELEGRAM notification rows a handler committed (Notifications\Insert, after the commit): the
     * consumer sends them once the delivery is acknowledged (Notifications\Delivery::sendOwn).
     *
     * @param  list<string>  $ids
     */
    public function addPendingNotifications(array $ids): void
    {
        array_push($this->pendingNotifications, ...$ids);
    }

    /** @return list<string> */
    public function takePendingNotifications(): array
    {
        $out = $this->pendingNotifications;
        $this->pendingNotifications = [];

        return $out;
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
