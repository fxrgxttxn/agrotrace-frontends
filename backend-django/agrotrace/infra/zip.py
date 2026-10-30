"""
ZIP archives read in memory with hard limits (P23), the port of backend-express/src/infra/zip.ts — the XLSX import
never writes a temporary file and never inflates more than it allows. The central directory is the source of truth: at
most `max_entries` entries, a declared uncompressed size of at most `max_entry_bytes` per entry and `max_total_bytes`
in all; each entry is inflated to at most its declared size + 1 byte, so the bytes actually produced are bounded too
(an entry that inflates to more than it declares is `too_large`, to less — or with a wrong CRC-32 — `invalid`). Only
the methods `stored` (0) and `deflate` (8) are read; encrypted entries, ZIP64 and multi-disk archives are refused.

Standard library only: it runs inside the XLSX Lane's child process.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from typing import Literal

EOCD = 0x06054B50
CENTRAL = 0x02014B50
LOCAL = 0x04034B50


@dataclass(frozen=True)
class ZipLimits:
    max_entries: int
    max_entry_bytes: int
    max_total_bytes: int


class ZipError(Exception):
    """The archive breaks a limit (`too_large`) or is not a readable ZIP (`invalid`)."""

    def __init__(self, kind: Literal["too_large", "invalid"]):
        super().__init__(f"zip: {kind}")
        self.kind = kind


@dataclass(frozen=True)
class CentralEntry:
    name: str
    method: int
    flags: int
    crc: int
    compressed_size: int
    size: int
    local_offset: int


def _u16(b: bytes, p: int) -> int:
    return struct.unpack_from("<H", b, p)[0]


def _u32(b: bytes, p: int) -> int:
    return struct.unpack_from("<I", b, p)[0]


def directory(b: bytes, limits: ZipLimits) -> list[CentralEntry]:
    """The central directory entries (names and declared sizes), limits checked; nothing is inflated."""
    if len(b) < 22:
        raise ZipError("invalid")
    eocd = b.rfind(struct.pack("<I", EOCD), max(0, len(b) - 22 - 65_535), len(b) - 18)
    if eocd < 0 or eocd > len(b) - 22:
        raise ZipError("invalid")
    if _u16(b, eocd + 4) != 0 or _u16(b, eocd + 6) != 0:
        raise ZipError("invalid")  # multi-disk
    count = _u16(b, eocd + 10)
    if count == 0xFFFF:
        raise ZipError("invalid")  # ZIP64
    if count > limits.max_entries:
        raise ZipError("too_large")
    p = _u32(b, eocd + 16)
    out: list[CentralEntry] = []
    total = 0
    for _ in range(count):
        if p + 46 > len(b) or _u32(b, p) != CENTRAL:
            raise ZipError("invalid")
        name_len, extra, comment = _u16(b, p + 28), _u16(b, p + 30), _u16(b, p + 32)
        if p + 46 + name_len > len(b):
            raise ZipError("invalid")
        e = CentralEntry(
            flags=_u16(b, p + 8),
            method=_u16(b, p + 10),
            crc=_u32(b, p + 16),
            compressed_size=_u32(b, p + 20),
            size=_u32(b, p + 24),
            local_offset=_u32(b, p + 42),
            # Node's `toString('utf8')`: invalid sequences become U+FFFD.
            name=b[p + 46: p + 46 + name_len].decode("utf-8", "replace"),
        )
        if e.size == 0xFFFFFFFF or e.compressed_size == 0xFFFFFFFF:
            raise ZipError("invalid")  # ZIP64
        if e.size > limits.max_entry_bytes:
            raise ZipError("too_large")
        total += e.size
        if total > limits.max_total_bytes:
            raise ZipError("too_large")
        out.append(e)
        p += 46 + name_len + extra + comment
    return out


def unzip(b: bytes, limits: ZipLimits) -> dict[str, bytes]:
    """Inflates EVERY entry in directory order — each bounded by its declared size, so an entry nobody reads cannot
    hide a bomb either (P24) — and returns them by name (the first entry of a repeated name wins, as a lookup in
    directory order would find it)."""
    out: dict[str, bytes] = {}
    for e in directory(b, limits):
        if e.flags & 0x1:
            raise ZipError("invalid")  # encrypted
        p = e.local_offset
        if p + 30 > len(b) or _u32(b, p) != LOCAL:
            raise ZipError("invalid")
        start = p + 30 + _u16(b, p + 26) + _u16(b, p + 28)
        end = start + e.compressed_size
        if end > len(b):
            raise ZipError("invalid")
        raw = b[start:end]
        if e.method == 0:
            data = raw
        elif e.method == 8:
            d = zlib.decompressobj(-15)
            try:
                # One byte more than declared tells "inflates to more than it says" apart from "exactly as declared".
                data = d.decompress(raw, e.size + 1)
            except zlib.error:
                raise ZipError("invalid") from None
            if len(data) > e.size:
                raise ZipError("too_large")
            if not d.eof:
                raise ZipError("invalid")  # a truncated stream (Node: "unexpected end of file")
        else:
            raise ZipError("invalid")
        if len(data) > e.size:
            raise ZipError("too_large")
        if len(data) != e.size or (zlib.crc32(data) & 0xFFFFFFFF) != e.crc:
            raise ZipError("invalid")
        out.setdefault(e.name, data)
    return out


def stored_zip(entries: list[tuple[str, bytes]]) -> bytes:
    """A ZIP of stored (uncompressed) entries in the given order (tests)."""
    locals_: list[bytes] = []
    centrals: list[bytes] = []
    offset = 0
    for name, data in entries:
        nb = name.encode("utf-8")
        crc = zlib.crc32(data) & 0xFFFFFFFF
        local = struct.pack("<IHHHHHIIIHH", LOCAL, 20, 0x0800, 0, 0, 0, crc, len(data), len(data), len(nb), 0)
        central = struct.pack("<IHHHHHHIIIHHHHHII", CENTRAL, 20, 20, 0x0800, 0, 0, 0, crc, len(data), len(data),
                              len(nb), 0, 0, 0, 0, 0, offset)
        locals_ += [local, nb, data]
        centrals += [central, nb]
        offset += 30 + len(nb) + len(data)
    cd = b"".join(centrals)
    end = struct.pack("<IHHHHIIH", EOCD, 0, 0, len(entries), len(entries), len(cd), offset, 0)
    return b"".join(locals_) + cd + end
