<?php

namespace App\Infrastructure\Files;

/**
 * A checked upload ready to be stored: the `files` row (without `created_at`, set to Tx::now() on insert) and the
 * objects to write to MinIO first.
 */
final class PreparedFile
{
    /**
     * @param  array<string, mixed>  $row
     * @param  list<array{key: string, bytes: string, mime: string}>  $objects
     */
    public function __construct(public array $row, public readonly array $objects) {}

    public function id(): string
    {
        return $this->row['id'];
    }
}
