"""
SVG logo sanitization (spec 8.6, Review Focus #5, P15/P17/P18/P20/P21), the port of backend-express/src/infra/svg.ts
(`sanitizeSvg`) and svg-sanitize.ts (jsdom + DOMPurify → the standard library's expat-based ElementTree).

`sanitize(data, cancelled=…)`:
1. UTF-8 (strict; a BOM is dropped, as TextDecoder does);
2. the streaming pre-scan (infra.svg_scan) — linear, before any DOM; DOCTYPE/entities never reach the parser;
3. the DOM work runs in a child process behind one of two bounded Lanes — documents up to 64 KiB and larger ones —
   1 running + 8 waiting each, a 3 s deadline counted from the moment the job is queued; a full lane or a missed
   deadline is `too-complex`; a client that went away drops its waiting job (D-I7).

`sanitize_text(text)` (the child's job; standard library only, so the forkserver child stays light):
- well-formed XML whose root is `svg` in the SVG namespace; elements outside the SVG namespace are removed;
- attributes: DOMPurify's SVG/SVG-filter allowlist (+ `data-*`, `aria-*`, xlink:href/title, xml:space/id), so event
  handlers (`on*`) and unknown attributes go; `style` keeps only allowlisted presentation properties with plain values
  (P17: no `url(`, `\\`, `image-set`, `@`, `expression(`); `fill`/`stroke`/`filter`/`mask`/`clip-path`/`marker-*` are
  dropped with `\\` or any `url(…)` other than `url(#id)` (P20); `href`/`xlink:href` must point inside the document
  (`#id`) — except a raster `data:` URI in `<image>`; any value with a non-local `url(…)`, `@import`, `expression(` or
  `javascript:` is dropped;
- serialized as XML (no declaration — the document starts with `<svg`) and parsed again to prove it well-formed.
The stored file is the sanitized document; its bytes differ from DOMPurify's (accepted: a file is stored once).
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from collections.abc import Callable
from typing import Literal

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
XML_NS = "http://www.w3.org/XML/1998/namespace"

SVG_SMALL_LANE_BYTES = 64 * 1024
QUEUE_WAITING = 8
DEADLINE_S = 3.0
MEMORY_MB = 256

# DOMPurify attrs.svg + attrs.svgFilters (lower case, as DOMPurify compares them).
SVG_ATTRS = frozenset("""
accent-height accumulate additive alignment-baseline amplitude ascent attributename attributetype azimuth basefrequency
baseline-shift begin bias by class clip clippathunits clip-path clip-rule color color-interpolation
color-interpolation-filters color-profile color-rendering cx cy d dx dy diffuseconstant direction display divisor dur
edgemode elevation end exponent fill fill-opacity fill-rule filter filterunits flood-color flood-opacity font-family
font-size font-size-adjust font-stretch font-style font-variant font-weight fx fy g1 g2 glyph-name glyphref
gradientunits gradienttransform height href id image-rendering in in2 intercept k k1 k2 k3 k4 kerning keypoints
keysplines keytimes lang lengthadjust letter-spacing kernelmatrix kernelunitlength lighting-color local marker-end
marker-mid marker-start markerheight markerunits markerwidth maskcontentunits maskunits max mask media method mode min
name numoctaves offset operator opacity order orient orientation origin overflow paint-order path pathlength
patterncontentunits patterntransform patternunits points preservealpha preserveaspectratio primitiveunits r rx ry
radius refx refy repeatcount repeatdur restart result rotate scale seed shape-rendering slope specularconstant
specularexponent spreadmethod startoffset stddeviation stitchtiles stop-color stop-opacity stroke-dasharray
stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke stroke-width style
surfacescale systemlanguage tabindex tablevalues targetx targety transform transform-origin text-anchor
text-decoration text-rendering textlength type u1 u2 unicode values viewbox visibility version vert-adv-y
vert-origin-x vert-origin-y width word-spacing wrap writing-mode xchannelselector ychannelselector x x1 x2 xmlns y y1
y2 z zoomandpan
""".split())
XML_ATTRS = frozenset({"xlink:href", "xml:id", "xlink:title", "xml:space"})
_DATA_ARIA = re.compile(r"^(data|aria)-[-\w.·-￿]+$")

STYLE_PROPERTIES = frozenset({"fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity",
                              "text-anchor", "display", "visibility"})
_FONT_PROP = re.compile(r"^font-[a-z-]+$")
_STYLE_FORBIDDEN = re.compile(r"url\s*\(|\\|image-set|@|expression\s*\(", re.I)
_CSS_ATTRIBUTE = re.compile(r"^(fill|stroke|filter|mask|clip-path|marker-start|marker-mid|marker-end|marker)$")
_LOCAL_URL = re.compile(r"url\(\s*#[A-Za-z_][\w.-]*\s*\)", re.I)
_ANY_URL = re.compile(r"url\s*\(", re.I)
_URL_TARGET = re.compile(r"url\s*\(\s*(['\"]?)([^'\")]*)", re.I)
_RASTER_DATA_URI = re.compile(r"^\s*data:image/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$", re.I)
_DANGEROUS = re.compile(r"@import|expression\s*\(|javascript:", re.I)
_LOCAL_REF = re.compile(r"^\s*#")


def safe_css_attribute(value: str) -> bool:
    """P20: kept only without `\\` and `expression(`, and with every `url(` a plain `url(#id)`."""
    if "\\" in value or re.search(r"expression\s*\(", value, re.I):
        return False
    return len(_ANY_URL.findall(value)) == len(_LOCAL_URL.findall(value))


def clean_style(style: str) -> str:
    """P17: the declarations that are allowlisted presentation properties with plain values."""
    kept = []
    for decl in style.split(";"):
        colon = decl.find(":")
        if colon < 0:
            continue
        prop = decl[:colon].strip().lower()
        value = decl[colon + 1:].strip()
        if not (prop in STYLE_PROPERTIES or _FONT_PROP.match(prop)):
            continue
        if value == "" or _STYLE_FORBIDDEN.search(value) or re.search(r'[<>"]', value):
            continue
        kept.append(f"{prop}: {value}")
    return "; ".join(kept)


def _attr_name(qname: str) -> str | None:
    if qname.startswith("{"):
        ns, _, local = qname[1:].partition("}")
        if ns == XLINK_NS:
            return f"xlink:{local}"
        if ns == XML_NS:
            return f"xml:{local}"
        return None
    return qname


def _keep_attr(element_local: str, name: str, value: str) -> str | None:
    """The (possibly rewritten) value to keep, or None to drop the attribute."""
    lower = name.lower()
    if not (lower in SVG_ATTRS or lower in XML_ATTRS or _DATA_ARIA.match(lower)):
        return None
    if lower == "style":
        cleaned = clean_style(value)
        return cleaned or None
    if _CSS_ATTRIBUTE.match(lower) and not safe_css_attribute(value):
        return None
    if lower in ("href", "xlink:href"):
        data_image = element_local.lower() == "image" and _RASTER_DATA_URI.match(value) is not None
        if not _LOCAL_REF.match(value) and not data_image:
            return None
    if any(not _LOCAL_REF.match(m.group(2)) for m in _URL_TARGET.finditer(value)) or _DANGEROUS.search(value):
        return None
    return value


def _clean(el: ET.Element) -> None:
    local = el.tag.partition("}")[2] if el.tag.startswith("{") else el.tag
    for qname in list(el.attrib):
        name = _attr_name(qname)
        kept = None if name is None else _keep_attr(local, name, el.attrib[qname])
        if kept is None:
            del el.attrib[qname]
        else:
            el.attrib[qname] = kept
    for child in list(el):
        if not isinstance(child.tag, str) or not child.tag.startswith("{" + SVG_NS + "}"):
            # Comments, processing instructions and elements outside the SVG namespace go, with their content.
            tail = child.tail
            el.remove(child)
            if tail:
                _append_text(el, tail)
            continue
        _clean(child)


def _append_text(el: ET.Element, text: str) -> None:
    if len(el):
        last = el[-1]
        last.tail = (last.tail or "") + text
    else:
        el.text = (el.text or "") + text


def _parse(text: str) -> ET.Element | None:
    try:
        root = ET.fromstring(text.encode("utf-8"))
    except ET.ParseError:
        return None
    return root if root.tag == "{" + SVG_NS + "}svg" else None


def sanitize_text(text: str) -> str | None:
    """The sanitized document, or None when it is not an acceptable SVG (runs in the Lane's child process)."""
    ET.register_namespace("", SVG_NS)
    ET.register_namespace("xlink", XLINK_NS)
    root = _parse(text)
    if root is None:
        return None
    _clean(root)
    out = ET.tostring(root, encoding="unicode", short_empty_elements=True)
    return out if _parse(out) is not None else None


# ── the orchestration in the api process ──────────────────────────────────────────────────────────────────────────

Reason = Literal["invalid", "too-complex", "aborted"]
_lanes: dict[str, object] = {}


def _lane(kind: str):
    from agrotrace.infra.lanes import Lane

    lane = _lanes.get(kind)
    if lane is None:
        lane = _lanes.setdefault(kind, Lane(f"svg-{kind}", max_waiting=QUEUE_WAITING, deadline_s=DEADLINE_S,
                                            memory_mb=MEMORY_MB))
    return lane


def sanitize(data: bytes, cancelled: Callable[[], bool] | None = None) -> tuple[str | None, Reason | None]:
    """(sanitized document, None) or (None, why): decode → pre-scan → the Lane of the document's size."""
    from agrotrace.core.context import client_gone
    from agrotrace.infra import svg_scan

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None, "invalid"
    if text.startswith("﻿"):
        text = text[1:]
    scan = svg_scan.scan(text)
    if not scan.ok:
        return None, "too-complex" if scan.too_complex else "invalid"
    lane = _lane("small" if len(data) <= SVG_SMALL_LANE_BYTES else "large")
    out = lane.run(sanitize_text, text, cancelled=cancelled or client_gone)  # type: ignore[attr-defined]
    if not out.ok:
        return None, out.reason
    return (out.value, None) if out.value is not None else (None, "invalid")
