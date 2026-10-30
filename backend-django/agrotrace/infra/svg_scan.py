"""
SVG logo pre-scan (spec 8.6, P15, P18), the port of `scanSvg` in backend-express/src/infra/svg.ts: a streaming
tokenizer, linear in the input, with no backtracking regular expression, that runs BEFORE any DOM:

- no DOCTYPE or other `<!…>` declarations (hence no entities); comments, processing instructions and CDATA terminated;
  tags balanced;
- element names from the allowlist `SVG_ELEMENTS` only (case-sensitive, no prefixes) — anything else is refused, not
  sanitized;
- complexity limits: nesting ≤ 64, ≤ 5 000 elements, ≤ 100 attributes per element, ≤ 20 000 attributes in all,
  ≤ 32 namespace declarations (`xmlns`, `xmlns:*`), every attribute value ≤ 64 KiB.
A limit breach is `too_complex` (415 `{reason: svg-too-complex}`), anything else malformed is a plain refusal (415).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SVG_MAX_DEPTH = 64
SVG_MAX_ELEMENTS = 5000
SVG_MAX_ATTRS_PER_ELEMENT = 100
SVG_MAX_ATTRS = 20_000
SVG_MAX_NAMESPACES = 32
SVG_MAX_ATTR_VALUE = 64 * 1024

SVG_ELEMENTS = frozenset({
    "svg", "g", "defs", "desc", "title", "metadata", "symbol", "switch", "a",
    "circle", "ellipse", "line", "path", "polygon", "polyline", "rect",
    "text", "tspan", "textPath", "image",
    "clipPath", "mask", "pattern", "marker", "linearGradient", "radialGradient", "stop",
    "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix",
    "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB",
    "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
    "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
})

#: JS `/[A-Za-z_][\w.:-]*/y` (`\w` is ASCII in JS) — a possessive-free, linear match.
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.:-]*")
_SPACE = " \t\r\n"


@dataclass(frozen=True)
class ScanResult:
    ok: bool
    too_complex: bool = False
    why: str = ""


OK = ScanResult(True)


def _refuse(why: str) -> ScanResult:
    return ScanResult(False, False, why)


def _too_complex(why: str) -> ScanResult:
    return ScanResult(False, True, why)


def scan(text: str) -> ScanResult:
    n = len(text)
    i = depth = elements = attrs = namespaces = 0
    while True:
        lt = text.find("<", i)
        if lt < 0:
            if elements == 0:
                return _refuse("no element")
            return OK if depth == 0 else _refuse("unclosed element")
        if text.startswith("<!--", lt):
            end = text.find("-->", lt + 4)
            if end < 0:
                return _refuse("unterminated comment")
            i = end + 3
            continue
        if text.startswith("<![CDATA[", lt):
            end = text.find("]]>", lt + 9)
            if end < 0:
                return _refuse("unterminated CDATA")
            i = end + 3
            continue
        if text.startswith("<?", lt):
            end = text.find("?>", lt + 2)
            if end < 0:
                return _refuse("unterminated processing instruction")
            i = end + 2
            continue
        nxt = text[lt + 1: lt + 2]
        if nxt == "!":
            return _refuse("declaration (DOCTYPE/ENTITY)")
        if nxt == "/":
            end = text.find(">", lt)
            if end < 0:
                return _refuse("unterminated end tag")
            depth -= 1
            if depth < 0:
                return _refuse("unbalanced end tag")
            i = end + 1
            continue

        m = _NAME.match(text, lt + 1)
        if not m:
            return _refuse("malformed start tag")
        name = m.group(0)
        if name not in SVG_ELEMENTS:
            return _refuse(f"element {name} is not allowed")
        elements += 1
        if elements > SVG_MAX_ELEMENTS:
            return _too_complex("too many elements")
        j = m.end()
        own = 0
        self_closing = False
        while True:
            while j < n and text[j] in _SPACE:
                j += 1
            if j >= n:
                return _refuse("unterminated start tag")
            if text[j] == ">":
                break
            if text[j] == "/" and text[j + 1: j + 2] == ">":
                self_closing = True
                j += 1
                break
            am = _NAME.match(text, j)
            if not am:
                return _refuse("malformed attribute")
            attr = am.group(0)
            j = am.end()
            while j < n and text[j] in _SPACE:
                j += 1
            if text[j: j + 1] != "=":
                return _refuse("attribute without a value")
            j += 1
            while j < n and text[j] in _SPACE:
                j += 1
            quote = text[j: j + 1]
            if quote not in ('"', "'"):
                return _refuse("unquoted attribute value")
            end = text.find(quote, j + 1)
            if end < 0:
                return _refuse("unterminated attribute value")
            if end - j - 1 > SVG_MAX_ATTR_VALUE:
                return _too_complex("attribute value too long")
            if text.find("<", j + 1, end) >= 0:
                return _refuse("`<` in an attribute value")
            j = end + 1
            own += 1
            attrs += 1
            if attr == "xmlns" or attr.startswith("xmlns:"):
                namespaces += 1
            if own > SVG_MAX_ATTRS_PER_ELEMENT:
                return _too_complex("too many attributes on an element")
            if attrs > SVG_MAX_ATTRS:
                return _too_complex("too many attributes")
            if namespaces > SVG_MAX_NAMESPACES:
                return _too_complex("too many namespace declarations")
        if not self_closing:
            depth += 1
            if depth > SVG_MAX_DEPTH:
                return _too_complex("nested too deeply")
        i = j + 1
