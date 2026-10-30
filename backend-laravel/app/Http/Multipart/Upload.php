<?php

namespace App\Http\Multipart;

/** The one `file` part of an upload: its bytes and its base name (P17) — the name is only ever `originalName`. */
final class Upload
{
    public function __construct(
        public readonly string $bytes,
        public readonly string $originalName,
        public readonly int $size,
    ) {}
}
