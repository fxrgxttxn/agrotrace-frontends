"""
Contract patterns in Python (D-I1). The contract's `pattern`s are ECMA-262 regular expressions with JSON Schema
semantics: an UNANCHORED search (`\\S` of NameString = "contains a non-space", `^otpauth://totp/` = a prefix). In
Python they are compiled only through `ecma()` and applied with `.search()`. The translation keeps JavaScript's
meaning where Python's `re` differs:

- `\\d` → `[0-9]`, `\\w` → `[A-Za-z0-9_]`, `\\b`/`\\B` over that ASCII word class (Python's are Unicode-aware);
- `\\s`/`\\S` → JavaScript's white space + line terminators (ASCII spaces, U+00A0, U+1680, U+2000–200A, U+2028,
  U+2029, U+202F, U+205F, U+3000, U+FEFF) and its complement;
- `.` → `[^\\n\\r\\u2028\\u2029]` (flag `s`: any character);
- `$` → `\\Z`: Python's `$` also matches before a trailing `\\n` (`'1\\n'` would pass `^\\d+$`);
- `(?<name>` → `(?P<name>`, `\\u{…}` → `\\U…`.
Flags: `i`, `u`, `s`. `m` and `g`/`y` are not used by the contract and are refused.
"""

from __future__ import annotations

import re
from functools import lru_cache

_JS_SPACE = "\\t\\n\\x0b\\x0c\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
_DIGIT = "0-9"
_WORD = "A-Za-z0-9_"
_LINE_END = "\\n\\r\\u2028\\u2029"
_WB = f"(?:(?<=[{_WORD}])(?![{_WORD}])|(?<![{_WORD}])(?=[{_WORD}]))"
_NWB = f"(?:(?<=[{_WORD}])(?=[{_WORD}])|(?<![{_WORD}])(?![{_WORD}]))"

_CLASS_IN = {"d": _DIGIT, "w": _WORD, "s": _JS_SPACE}
_NEGATED = {"D": "d", "W": "w", "S": "s"}


def _translate(src: str, dotall: bool) -> str:
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "\\":
            if i + 1 >= n:
                raise ValueError("pattern ends with a backslash")
            e = src[i + 1]
            if e in _CLASS_IN:
                out.append(f"[{_CLASS_IN[e]}]")
            elif e in _NEGATED:
                out.append(f"[^{_CLASS_IN[_NEGATED[e]]}]")
            elif e == "b":
                out.append(_WB)
            elif e == "B":
                out.append(_NWB)
            elif e == "u" and i + 2 < n and src[i + 2] == "{":
                end = src.index("}", i + 3)
                out.append(f"\\U{int(src[i + 3:end], 16):08x}")
                i = end + 1
                continue
            else:
                out.append("\\" + e)
            i += 2
            continue
        if c == "[":
            j = i + 1
            negated = j < n and src[j] == "^"
            if negated:
                j += 1
            parts: list[str] = []
            extra: list[str] = []  # negated shorthands inside a class: alternatives
            while j < n and src[j] != "]":
                ch = src[j]
                if ch == "\\":
                    e = src[j + 1]
                    if e in _CLASS_IN:
                        parts.append(_CLASS_IN[e])
                    elif e in _NEGATED:
                        if negated:
                            raise ValueError("a negated shorthand inside a negated class is not supported")
                        extra.append(f"[^{_CLASS_IN[_NEGATED[e]]}]")
                    elif e == "u" and j + 2 < n and src[j + 2] == "{":
                        end = src.index("}", j + 3)
                        parts.append(f"\\U{int(src[j + 3:end], 16):08x}")
                        j = end + 1
                        continue
                    elif e == "b":
                        parts.append("\\x08")
                    else:
                        parts.append("\\" + e)
                    j += 2
                    continue
                if ch == "[":
                    parts.append("\\[")
                else:
                    parts.append(ch)
                j += 1
            if j >= n:
                raise ValueError("unterminated character class")
            body = "".join(parts)
            if not body and not extra:
                out.append("[\\s\\S]" if negated else "(?!)")  # JS [^] = any, [] = nothing
            elif extra:
                alts = ([f"[{body}]"] if body else []) + extra
                out.append("(?:" + "|".join(alts) + ")")
            else:
                out.append(f"[{'^' if negated else ''}{body}]")
            i = j + 1
            continue
        if c == ".":
            out.append("[\\s\\S]" if dotall else f"[^{_LINE_END}]")
        elif c == "$":
            out.append("\\Z")
        elif c == "(" and src.startswith("(?<", i) and i + 3 < n and src[i + 3] not in "=!":
            out.append("(?P<")
            i += 3
            continue
        else:
            out.append(c)
        i += 1
    return "".join(out)


@lru_cache(maxsize=512)
def ecma(pattern: str, flags: str = "") -> re.Pattern[str]:
    """The ECMA-262 `pattern` (with `flags`) as a Python regex; apply it with `.search()`."""
    py = 0
    for f in flags:
        if f == "i":
            py |= re.IGNORECASE
        elif f in ("u", "s"):
            continue
        else:
            raise ValueError(f"unsupported regex flag {f!r}")
    if py & re.IGNORECASE and pattern.isascii():
        # JS /i (without u) never folds a non-ASCII character onto an ASCII one; Python's Unicode folding would
        # (`K` KELVIN SIGN ~ `k`, `ſ` ~ `s`). An ASCII-only pattern keeps JS semantics with re.ASCII.
        py |= re.ASCII
    return re.compile(_translate(pattern, "s" in flags), py)
