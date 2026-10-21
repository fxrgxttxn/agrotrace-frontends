"""
Stored files (FR-FILE-01…05, spec 8.6, R34), the port of backend-express/src/modules/files/{service,download,access}.ts:
the `files` row, its MinIO objects, the contract's `FileRef`, serving and Bearer access.

Object keys: `{type}/{yyyy}/{mm}/{fileId}/{variant}` (spec 8.6), the upload under `original`, the WebP variants under
`96` and `480`; `files.variants` = `{"96": {key, sha256, size}, "480": {…}}` (the seed's layout). An SVG logo is stored
after sanitization — the sanitized document is the file (`size_bytes`, `sha256`), so the served bytes, their ETag and
`FileRef.sizeBytes` agree (decision 6). The objects are written BEFORE the transaction that inserts the row (a row
never points at a missing object; the transaction stays DB-only, P8).

Serving (R34, decision 8): the WebP variant (default 480) of a raster image, otherwise the stored file itself;
`ETag` = `"` + sha256 of the served bytes + `"` (from `files.variants` / `files.sha256`, so every backend sends the same
tag); `If-None-Match` (strong or weak, a list or `*`) → 304 without a body; `Content-Disposition` `inline;
filename="<ascii>"; filename*=UTF-8''<pct>` with the served type's extension; `Cache-Control` by access.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from django.http import HttpResponse

from agrotrace.core import sql
from agrotrace.core.multipart import Upload
from agrotrace.core.problem import AppProblem
from agrotrace.core.tx import Tx
from agrotrace.infra import file_urls, images, s3, svg_sanitize
from agrotrace.security.jwt import Principal

PUBLIC_KINDS = ("LOGO", "PRODUCT_IMAGE")
CACHE_PRIVATE = "private, max-age=0, must-revalidate"
CACHE_PUBLIC = "public, max-age=86400"
IMAGE_MAX_BYTES = 2 * 1024 * 1024

KEY_TYPE = {"AVATAR": "avatar", "LOGO": "logo", "PRODUCT_IMAGE": "product-image", "LAB_PROTOCOL": "lab-protocol",
            "QR": "qr", "REPORT": "report"}
EXTENSION = {"image/webp": "webp", "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg",
             "application/pdf": "pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx"}


@dataclass
class Prepared:
    id: str
    kind: str
    owner_id: str | None
    original_name: str
    mime: str
    original: bytes
    variants: dict[str, dict[str, Any]] = field(default_factory=dict)
    objects: list[tuple[str, bytes, str]] = field(default_factory=list)

    @property
    def object_key(self) -> str:
        return self.objects[0][0]

    @property
    def sha256(self) -> str:
        return images.sha256hex(self.original)


def object_key(kind: str, file_id: str, created_at: datetime, variant: str) -> str:
    return f"{KEY_TYPE[kind]}/{created_at.year:04d}/{created_at.month:02d}/{file_id}/{variant}"


def unsupported(allowed: Sequence[str], reason: str | None = None) -> AppProblem:
    params: dict[str, Any] = {"allowed": list(allowed)}
    if reason:
        params["reason"] = reason
    return AppProblem(415, "UNSUPPORTED_MEDIA_TYPE", params=params)


def prepare(upload: Upload, *, kind: str, owner_id: str | None, allowed: Sequence[str],
            cancelled: Callable[[], bool] | None = None) -> Prepared:
    """Checks the upload against `allowed` (by signature) and builds the row and objects: raster images → the original
    plus WebP 96/480; SVG → the sanitized document. 415 `{allowed}` for any other type, a forged signature or an SVG
    that cannot be accepted (`reason: svg-too-complex` for the limits, a full lane or a missed deadline)."""
    mime = images.sniff(upload.data)
    if mime is None or mime not in allowed:
        raise unsupported(allowed)
    file_id = str(uuid.uuid4())
    # The key's month: the DB clock (P43 — no process clock in written data), read before the objects are written.
    created = sql.scalar("SELECT now()")
    p = Prepared(id=file_id, kind=kind, owner_id=owner_id, original_name=upload.name, mime=mime, original=upload.data)
    extra: list[tuple[str, bytes, str]] = []
    if mime in images.RASTER_TYPES:
        # The raster Lane (Ruling Q8): 2 decodes at a time, out of process; the wait holds no pool connection.
        try:
            out = images.variants(upload.data, mime, cancelled)
        except images.RasterBusy:
            # Not reachable in practice (a 256-deep queue, 120 s); the contract's generic overload answer.
            raise AppProblem(503, "BACKEND_UNAVAILABLE", headers={"Retry-After": "1"}) from None
        if out is None:
            raise unsupported(allowed)
        for size, body in out.items():
            key = object_key(kind, file_id, created, size)
            p.variants[size] = {"key": key, "sha256": images.sha256hex(body), "size": len(body)}
            extra.append((key, body, "image/webp"))
    elif mime == "image/svg+xml":
        sql.release()  # the Lane wait (≤ 3 s) holds no pool connection
        clean, why = svg_sanitize.sanitize(upload.data, cancelled)
        if clean is None:
            raise unsupported(allowed, "svg-too-complex" if why == "too-complex" else None)
        p.original = clean.encode("utf-8")
    p.objects = [(object_key(kind, file_id, created, "original"), p.original, mime), *extra]
    return p


def store_objects(p: Prepared) -> None:
    for key, body, content_type in p.objects:
        s3.put(key, body, content_type)


def insert(tx: Tx, p: Prepared) -> None:
    """The files row; `created_at` = the transaction's instant (P43; the object key keeps the prepare-time month)."""
    tx.execute(
        "INSERT INTO files (id, bucket, object_key, original_name, mime, size_bytes, sha256, variants, kind, owner_id, "
        "created_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s)",
        [p.id, s3.bucket(), p.object_key, p.original_name, p.mime, len(p.original), p.sha256,
         json.dumps(p.variants, separators=(",", ":")), p.kind, p.owner_id, tx.now],
    )


def audit_view(p: Prepared) -> dict[str, Any]:
    """Audit view of a files row (API names, the seed's auditView of `files`, decision 15)."""
    return {"bucket": s3.bucket(), "objectKey": p.object_key, "originalName": p.original_name, "mime": p.mime,
            "sizeBytes": len(p.original), "sha256": p.sha256, "variants": p.variants, "kind": p.kind,
            "ownerId": p.owner_id}


def soft_delete(tx: Tx, file_id: str | None, now: datetime) -> bool:
    """Soft-deletes a file (its URLs answer 404 from now on); False — nothing to do."""
    if file_id is None:
        return False
    return tx.execute("UPDATE files SET deleted_at = %s WHERE id = %s AND deleted_at IS NULL", [now, file_id]) > 0


def file_url(kind: str, file_id: str) -> str:
    return file_urls.public_url(file_id) if kind in PUBLIC_KINDS else file_urls.signed(file_id)


def file_ref(p: Prepared) -> dict[str, Any]:
    """The contract's `FileRef`: original MIME/size/name; a public URL for public kinds, a signed one otherwise."""
    return {"id": p.id, "url": file_url(p.kind, p.id), "mime": p.mime, "sizeBytes": len(p.original),
            "originalName": p.original_name}


# ── reading ───────────────────────────────────────────────────────────────────────────────────────────────────────

_COLUMNS = ("id::text AS id, object_key, original_name, mime, size_bytes, sha256, variants, kind, "
            "owner_id::text AS owner_id")


def live_file(file_id: str) -> dict[str, Any] | None:
    return sql.one(f"SELECT {_COLUMNS} FROM files WHERE id = %s AND deleted_at IS NULL", [file_id])


def columns(alias: str) -> str:
    """The columns `live_file` reads, of the table aliased `alias` (joins: user avatar, organization logo)."""
    return ", ".join(f"{alias}.{c}" for c in _COLUMNS.split(", "))


def can_read(p: Principal, f: dict[str, Any]) -> bool:
    """Bearer access (п. 4.2: files inherit the rights of their entity); unreadable is indistinguishable from missing.
    AVATAR — any authenticated user; LOGO, PRODUCT_IMAGE — everybody; REPORT — its owner; LAB_PROTOCOL — INSPECTOR and
    ADMIN, a LAB for the tests of its own laboratory (participants through batch visibility — Task 6, when it exists);
    QR — INSPECTOR and ADMIN (participants through batch visibility — Task 6)."""
    kind = f["kind"]
    if kind in ("AVATAR", "LOGO", "PRODUCT_IMAGE"):
        return True
    if kind == "REPORT":
        return f["owner_id"] == p.user_id
    sees_all = "INSPECTOR" in p.roles or "ADMIN" in p.roles
    if kind == "LAB_PROTOCOL":
        if sees_all:
            return True
        if "LAB" not in p.roles:
            return False
        return bool(sql.scalar(
            "SELECT EXISTS (SELECT 1 FROM lab_tests t JOIN batches b ON b.id = t.batch_id "
            "WHERE t.protocol_file_id = %s AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND t.lab_org_id = %s)",
            [f["id"], p.org_id]))
    if kind == "QR":
        return sees_all
    return False


# ── serving ───────────────────────────────────────────────────────────────────────────────────────────────────────

_ATTR_CHAR = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$&+-.^_`|~")


def content_disposition(original_name: str, ext: str) -> str:
    """components.headers.ContentDisposition: originalName without its last extension (a leading dot is none) +
    `.` + the served extension; the ASCII form replaces every other code point (and `"`, `\\`) by `_`."""
    dot = original_name.rfind(".")
    name = f"{original_name[:dot] if dot > 0 else original_name}.{ext}"
    ascii_ = "".join(c if 0x20 <= ord(c) <= 0x7E and c not in '"\\' else "_" for c in name)
    pct = "".join(chr(b) if chr(b) in _ATTR_CHAR else f"%{b:02X}" for b in name.encode("utf-8", "surrogatepass"))
    return f"inline; filename=\"{ascii_}\"; filename*=UTF-8''{pct}"


def if_none_match(header: str | None, etag: str) -> bool:
    """RFC 9110: weak comparison against any listed tag; `*` matches any current representation."""
    if not header:
        return False
    bare = etag[2:] if etag.startswith("W/") else etag
    for t in (x.strip() for x in header.split(",")):
        if t == "*" or (t[2:] if t.startswith("W/") else t) == bare:
            return True
    return False


def served(f: dict[str, Any], variant: int) -> tuple[str, str, str]:
    """(object key, sha256, MIME) of the representation served for `variant`."""
    v = (sql.jsonb(f["variants"]) or {}).get(str(variant))
    if isinstance(v, dict):
        return v["key"], v["sha256"], "image/webp"
    return f["object_key"], f["sha256"].strip(), f["mime"]


def serve(request, f: dict[str, Any], variant: int, cache_control: str, disposition: str | None = None) -> HttpResponse:
    key, sha, mime = served(f, variant)
    etag = f'"{sha}"'
    if if_none_match(request.META.get("HTTP_IF_NONE_MATCH"), etag):
        res = HttpResponse(status=304)
        res["ETag"] = etag
        res["Cache-Control"] = cache_control
        return res
    body = s3.get(key)  # fetched before any header is set: a storage failure is still a clean problem
    res = HttpResponse(body, status=200, content_type=mime)
    res["Content-Length"] = str(len(body))
    res["Content-Disposition"] = disposition or content_disposition(f["original_name"], EXTENSION.get(mime, "bin"))
    res["ETag"] = etag
    res["Cache-Control"] = cache_control
    res["X-Content-Type-Options"] = "nosniff"
    if mime == "image/svg+xml":
        # Defence in depth for an SVG opened directly: no script, no external loads (it is sanitized anyway).
        res["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    return res
