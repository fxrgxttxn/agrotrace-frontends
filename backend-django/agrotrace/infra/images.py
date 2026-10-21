"""
Uploaded file types and the image pipeline (FR-FILE-02, FR-FILE-04, spec 8.6), the port of backend-express/src/infra/
images.ts (sharp → Pillow).

The type is decided by the content only (magic bytes), never by the file name or the part's Content-Type: JPEG
`FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF????WEBP`, PDF `%PDF-`, SVG — text without NUL whose first element
(after an optional BOM, XML declaration, comments and doctype) is `<svg`. Raster images become WebP variants of 96 and
480 px on the longer side (auto-rotated by EXIF, never enlarged — decision 4 of Express Task 3, quality 80), each with
its own sha256 and size (`files.variants`, R34). A signature the content does not decode as (a forged signature, a
truncated image, more than 40 megapixels) → None, which the caller answers 415 (decision 5).
"""

from __future__ import annotations

import hashlib
import io
import re
import warnings

from PIL import Image, ImageOps

RASTER_TYPES = ("image/jpeg", "image/png", "image/webp")
SIZES = (96, 480)
MAX_PIXELS = 40_000_000
_FORMAT = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
_PNG = b"\x89PNG\r\n\x1a\n"

# Pillow's own bomb guard is replaced by MAX_PIXELS (checked before decoding).
Image.MAX_IMAGE_PIXELS = None

_JS_WS = "\t\n\v\f\r    -     　﻿"
_PROLOG = re.compile(
    rf"(?:[{_JS_WS}]+|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^\[>]*(?:\[[\s\S]*?\])?[{_JS_WS}]*>)", re.I
)
_SVG_ROOT = re.compile(rf"<svg[{_JS_WS}>/]")


def _looks_like_svg(b: bytes) -> bool:
    if b"\x00" in b:
        return False
    s = b[:4096].decode("utf-8", errors="replace")
    if s.startswith("﻿"):
        s = s[1:]
    while True:
        m = _PROLOG.match(s)
        if not m or not m.group(0):
            break
        s = s[m.end():]
    return _SVG_ROOT.match(s) is not None


def sniff(data: bytes) -> str | None:
    """The MIME type by signature, or None."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == _PNG:
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:5] == b"%PDF-":
        return "application/pdf"
    if _looks_like_svg(data):
        return "image/svg+xml"
    return None


def sha256hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _fit(w: int, h: int, box: int) -> tuple[int, int]:
    """sharp `resize(box, box, {fit: 'inside', withoutEnlargement: true})`."""
    if w <= box and h <= box:
        return w, h
    if w >= h:
        return box, max(1, round(h * box / w))
    return max(1, round(w * box / h)), box


def render(data: bytes, mime: str) -> dict[str, bytes] | None:
    """`{'96': webp, '480': webp}` of a raster image whose signature said `mime`; None when it does not decode.
    The Lane's child job. Memory-lean, like sharp's shrink-on-load: a JPEG is decoded at a reduced scale (`draft`),
    the image is resized in its own mode (an 8-bit grey 40 MP image stays 40 MB instead of becoming 120 MB RGB), the
    480 variant uses `reducing_gap`, and the 96 variant is made from the 480 one."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            img = Image.open(io.BytesIO(data))
            if img.format != _FORMAT[mime]:
                return None
            w, h = img.size
            if w <= 0 or h <= 0 or w * h > MAX_PIXELS:
                return None
            if img.getexif().get(0x0112, 1) in (5, 6, 7, 8):  # EXIF orientation swaps the sides
                w, h = h, w
            if img.format == "JPEG":
                img.draft(img.mode, (max(SIZES), max(SIZES)))
            img.load()
            img = ImageOps.exif_transpose(img) or img
            transparent = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
            if img.mode not in ("L", "LA", "RGB", "RGBA"):
                img = img.convert("RGBA" if transparent else "RGB")
            out: dict[str, bytes] = {}
            source = img
            for box in sorted(SIZES, reverse=True):
                size = _fit(w, h, box)
                if size != source.size:
                    source = source.resize(size, Image.Resampling.LANCZOS, reducing_gap=3.0)
                final = source if source.mode in ("RGB", "RGBA") else source.convert("RGBA" if transparent else "RGB")
                buf = io.BytesIO()
                final.save(buf, "WEBP", quality=80)
                out[str(box)] = buf.getvalue()
            return {str(b): out[str(b)] for b in SIZES}
    except Exception:
        return None


# ── the bound (Ruling Q8): raster work runs in a Lane of 2 child processes ───────────────────────────────────────

#: Two decodes at a time per api process (more is useless under the GIL and multiplies memory); the queue is deep —
#: Express queues raster work on libuv's pool and never refuses a burst, so neither does this one in practice.
RASTER_RUNNING = 2
RASTER_WAITING = 256
RASTER_DEADLINE_S = 120.0
RASTER_MEMORY_MB = 1024


class RasterBusy(Exception):
    """The raster lane could not take or finish the job in time (queue full / deadline / client gone)."""


_lane = None


def lane():
    global _lane
    if _lane is None:
        from agrotrace.infra.lanes import Lane

        _lane = Lane("raster", max_waiting=RASTER_WAITING, deadline_s=RASTER_DEADLINE_S, memory_mb=RASTER_MEMORY_MB,
                     max_running=RASTER_RUNNING)
    return _lane


def variants(data: bytes, mime: str, cancelled=None) -> dict[str, bytes] | None:
    """`render` in the raster Lane (out of the api process, at most 2 at once). None — the image does not decode (a
    crashed child, e.g. over RLIMIT_AS, counts as that: 415); RasterBusy — refused or timed out."""
    from agrotrace.core.context import client_gone

    out = lane().run(render, data, mime, cancelled=cancelled or client_gone)
    if out.ok:
        return out.value
    if out.cause == "crashed":
        return None
    raise RasterBusy(out.cause or out.reason)
