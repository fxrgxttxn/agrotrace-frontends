<?php

namespace App\Sse;

/**
 * The SQL of one SSE stream (PgStreamStore; Express sse/hub.ts). Rows are Notification views (contract), ordered by
 * seq. Every method may take a DB slot; release() gives it back (between events a stream holds none).
 */
interface StreamStore
{
    /** The user's highest IN_APP seq (0 without rows). */
    public function maxSeq(string $userId): int;

    /**
     * The replay for L (contract text): rows with seq > L plus unread rows with seq < L created at most 60 s before
     * row L (none of those without row L) — seq > $after only, at most $limit rows (keyset paging).
     *
     * @return list<array{id: string, seq: int, type: string, payload: mixed, isRead: bool, createdAt: string}>
     */
    public function replay(string $userId, int $lastSeq, int $after, int $limit): array;

    /**
     * After a lost LISTEN session or subscription: rows with seq > W plus unread rows with seq < W created no earlier
     * than 60 s before $sinceIso — seq > $after only, at most $limit rows.
     *
     * @return list<array{id: string, seq: int, type: string, payload: mixed, isRead: bool, createdAt: string}>
     */
    public function catchUp(string $userId, int $watermark, string $sinceIso, int $after, int $limit): array;

    /**
     * One IN_APP row of the user by id, or null.
     *
     * @return null|array{id: string, seq: int, type: string, payload: mixed, isRead: bool, createdAt: string}
     */
    public function row(string $userId, string $id): ?array;

    public function unread(string $userId): int;

    public function release(): void;
}
