"""
`multipart/form-data` uploads with exactly one file part `file` (contract ImageUpload / LogoUpload / ProtocolUpload /
ImportUpload: `required: [file]`, `additionalProperties: false`), the port of backend-express/src/http/multipart.ts
(busboy with `defParamCharset: 'utf8'`). Django's own parser is never used (it would answer HTML 400s and has other
rules for names); the ASGI handler has already buffered the body.

Problems, in this order (P14, decision 7 of Express Task 3):
- 400 VALIDATION for the form — `errors.file: [validation.required]` (no file part, an empty one, a text part named
  `file`, or no multipart body at all), `validation.duplicate` (a second `file`), `validation.unknownField` (any other
  part), `validation.maxLength` (a base name over 255 code points, P20), `_root: [validation.invalid]` (a malformed
  multipart body, a missing boundary, more than 20 parts or 20 text fields);
- then 413 FILE_TOO_LARGE `{maxBytes}` (the limit is inclusive: size ≤ max_bytes is accepted); a body beyond the
  gateway's 12 MiB (only possible by calling the backend directly) is 413 at once with `Connection: close`.
The file name is kept only as `originalName`: its base name, every `/` or `\\` path segment dropped (P17) — never used
for the type or the storage key.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote_to_bytes

from agrotrace.core.problem import JSON_BODY_LIMIT_BYTES, AppProblem, validation_problem

FIELD = "file"
MAX_PARTS = 20
MAX_FIELDS = 20
MAX_HEADER_PAIRS = 50


@dataclass(frozen=True)
class Upload:
    name: str
    data: bytes


class _Malformed(Exception):
    pass


_TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")


def _params(value: str) -> tuple[str, dict[str, str]]:
    """`form-data; name="x"; filename*=utf-8''%D0%A4` → ('form-data', {...}); quoted-strings unescaped."""
    n = len(value)
    i = value.find(";")
    if i < 0:
        i = n
    disposition = value[:i].strip().lower()
    out: dict[str, str] = {}
    while i < n:
        while i < n and value[i] in " \t":
            i += 1
        if i >= n:
            break
        if value[i] != ";":
            raise _Malformed("parameter separator")
        i += 1
        while i < n and value[i] in " \t":
            i += 1
        m = _TOKEN.match(value, i)
        if not m:
            break
        key = m.group(0).lower()
        i = m.end()
        while i < n and value[i] in " \t":
            i += 1
        if i >= n or value[i] != "=":
            out.setdefault(key, "")
            continue
        i += 1
        while i < n and value[i] in " \t":
            i += 1
        if i < n and value[i] == '"':
            i += 1
            buf = []
            while i < n and value[i] != '"':
                if value[i] == "\\" and i + 1 < n:
                    i += 1
                buf.append(value[i])
                i += 1
            if i >= n:
                raise _Malformed("unterminated quoted-string")
            i += 1
            v = "".join(buf)
        else:
            j = i
            while j < n and value[j] not in "; \t":
                j += 1
            v = value[i:j]
            i = j
        out[key] = v
    return disposition, out


def _from_latin1(s: str) -> str:
    """busboy reads header bytes as latin1 and re-decodes parameters with the default charset (utf8)."""
    try:
        return s.encode("latin-1").decode("utf-8", errors="replace")
    except UnicodeEncodeError:
        return s


def _ext_value(v: str) -> str | None:
    """RFC 5987 `charset'lang'pct-encoded`."""
    parts = v.split("'", 2)
    if len(parts) != 3:
        return None
    charset = parts[0].lower() or "utf-8"
    try:
        return unquote_to_bytes(parts[2]).decode(charset if charset in ("utf-8", "iso-8859-1", "latin1") else "utf-8",
                                                 errors="replace")
    except LookupError:
        return None


def _boundary(content_type: str) -> str | None:
    try:
        _, params = _params(content_type)
    except _Malformed:
        return None
    b = params.get("boundary")
    return b if b and len(b) <= 70 else None


@dataclass
class _Part:
    name: str | None
    filename: str | None
    data: bytes


def _parts(body: bytes, boundary: bytes) -> list[_Part]:
    delim = b"--" + boundary
    pos = body.find(delim)
    if pos < 0 or (pos > 0 and body[pos - 2: pos] != b"\r\n"):
        raise _Malformed("no opening boundary")
    pos += len(delim)
    parts: list[_Part] = []
    while True:
        if body[pos: pos + 2] == b"--":
            return parts
        while body[pos: pos + 1] in (b" ", b"\t"):
            pos += 1
        if body[pos: pos + 2] != b"\r\n":
            raise _Malformed("boundary line")
        pos += 2
        nxt = body.find(b"\r\n" + delim, pos)
        if nxt < 0:
            raise _Malformed("unexpected end of form")
        raw = body[pos:nxt]
        if raw.startswith(b"\r\n"):
            head, content = b"", raw[2:]
        else:
            sep = raw.find(b"\r\n\r\n")
            if sep < 0:
                raise _Malformed("part headers")
            head, content = raw[:sep], raw[sep + 4:]
        lines = head.decode("latin-1").split("\r\n") if head else []
        if len(lines) > MAX_HEADER_PAIRS:
            raise _Malformed("too many header pairs")
        name = filename = None
        star_name = star_file = None
        for line in lines:
            k, colon, v = line.partition(":")
            if not colon:
                raise _Malformed("header line")
            if k.strip().lower() != "content-disposition":
                continue
            disposition, params = _params(v.strip())
            if disposition != "form-data":
                continue
            if "name" in params:
                name = _from_latin1(params["name"])
            if "name*" in params:
                star_name = _ext_value(params["name*"])
            if "filename" in params:
                filename = _from_latin1(params["filename"])
            if "filename*" in params:
                star_file = _ext_value(params["filename*"])
        name = star_name if star_name is not None else name
        filename = star_file if star_file is not None else filename
        if name is not None or filename is not None or lines:
            parts.append(_Part(name, filename, content))
        pos = nxt + 2 + len(delim)


def _base_name(filename: str) -> str:
    """busboy `basename()` (the part after the last `/` or `\\`; `.` and `..` become empty), as Express keeps it."""
    base = re.split(r"[\\/]", filename)[-1]
    return "" if base in (".", "..") else base


def read_single_file(request, *, max_bytes: int) -> Upload:
    content_type = request.META.get("CONTENT_TYPE") or ""
    if not content_type.lower().startswith("multipart/form-data"):
        raise validation_problem({FIELD: ["validation.required"]})
    body = request.body
    if len(body) > JSON_BODY_LIMIT_BYTES:
        raise AppProblem(413, "FILE_TOO_LARGE", params={"maxBytes": max_bytes}, headers={"Connection": "close"})
    boundary = _boundary(content_type)
    if boundary is None:
        raise validation_problem({"_root": ["validation.invalid"]})

    errors: dict[str, list[str]] = {}

    def add(field: str, key: str) -> None:
        keys = errors.setdefault(field, [])
        if key not in keys:
            keys.append(key)

    try:
        parts = _parts(body, boundary.encode("latin-1", errors="replace"))
    except _Malformed:
        raise validation_problem({"_root": ["validation.invalid"]}) from None

    file: _Part | None = None
    fields = 0
    for i, part in enumerate(parts):
        if i >= MAX_PARTS:
            add("_root", "validation.invalid")
            break
        name = part.name if part.name is not None else ""
        if part.filename is not None:
            if name != FIELD:
                add(name, "validation.unknownField")
            elif file is not None:
                add(FIELD, "validation.duplicate")
            else:
                file = part
        else:
            fields += 1
            if fields > MAX_FIELDS:
                add("_root", "validation.invalid")
                continue
            add(name, "validation.required" if name == FIELD else "validation.unknownField")

    too_large = file is not None and len(file.data) > max_bytes
    if file is not None and "validation.required" in errors.get(FIELD, []):
        # A text part named `file` next to a real file part: the text part is the extra one.
        errors[FIELD] = [k for k in errors[FIELD] if k != "validation.required"]
        add(FIELD, "validation.duplicate")
    if file is None or (len(file.data) == 0 and not too_large):
        add(FIELD, "validation.required")
    filename = _base_name(file.filename or "") if file is not None else ""
    if file is not None and len(filename) > 255:
        add(FIELD, "validation.maxLength")
    if errors:
        raise validation_problem(errors)
    if too_large:
        raise AppProblem(413, "FILE_TOO_LARGE", params={"maxBytes": max_bytes})
    assert file is not None
    return Upload(name=filename, data=file.data)
