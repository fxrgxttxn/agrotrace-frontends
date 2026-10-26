<?php

namespace App\Sse;

/** The client side of one SSE stream (ClientSocketIo in api-laravel; a fake in the tests). */
interface StreamIo
{
    /** Writes and flushes; false — the client is gone (the write failed or the connection is aborted). */
    public function write(string $bytes): bool;

    /** Whether the client closed its connection (checked between events). */
    public function gone(): bool;

    /** Bytes written but not yet taken by the client, as far as this host sees them; null — unknown. */
    public function backlog(): ?int;
}
