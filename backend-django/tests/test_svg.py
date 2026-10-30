"""SVG logos (P15, P17, P18, P20, P21): the streaming pre-scan's limits and allowlist, the sanitizer's attribute and
CSS rules, and the end-to-end `sanitize` through the Lanes."""

import pytest

from agrotrace.infra import svg_sanitize, svg_scan

NS = 'xmlns="http://www.w3.org/2000/svg"'


def nested(n):
    return f"<svg {NS}>" + "<g>" * (n - 1) + "</g>" * (n - 1) + "</svg>"


def flat(n):
    return f"<svg {NS}>" + '<rect width="1" height="1"/>' * (n - 1) + "</svg>"


def test_depth_limit():
    assert svg_scan.scan(nested(64)).ok
    r = svg_scan.scan(nested(65))
    assert not r.ok and r.too_complex


def test_element_limit():
    assert svg_scan.scan(flat(5000)).ok
    r = svg_scan.scan(flat(5001))
    assert not r.ok and r.too_complex


@pytest.mark.parametrize("body", ["<script>alert(1)</script>", "<foreignObject/>", '<use href="#a"/>',
                                  "<style>a{}</style>", '<set attributeName="x"/>'])
def test_elements_outside_the_allowlist_are_refused(body):
    r = svg_scan.scan(f"<svg {NS}>{body}</svg>")
    assert not r.ok and not r.too_complex


def test_doctype_and_prefixed_root_are_refused():
    r = svg_scan.scan('<!DOCTYPE svg [<!ENTITY a "x">]><svg/>')
    assert not r.ok and not r.too_complex
    assert not svg_scan.scan('<s:svg xmlns:s="http://www.w3.org/2000/svg"/>').ok


def test_attribute_limits():
    many = "".join(f' data-a{i}="1"' for i in range(101))
    assert svg_scan.scan(f"<svg {NS}><rect{many}/></svg>").too_complex
    assert svg_scan.scan(f'<svg {NS}><path d="{"M0 0 " * 13_200}"/></svg>').too_complex
    ns = "".join(f' xmlns:n{i}="u{i}"' for i in range(33))
    assert svg_scan.scan(f"<svg {NS}{ns}/>").too_complex


def test_style_and_css_attributes():
    out = svg_sanitize.sanitize_text(
        f'<svg {NS}><rect style="fill:url(http://x); stroke: #000" fill="url(#g)" stroke="u\\72l(http://y)" '
        'mask="url(http://m)" onclick="x()" id="keep"/></svg>')
    assert out is not None
    assert 'style="stroke: #000"' in out and 'fill="url(#g)"' in out and 'id="keep"' in out
    for bad in ("http://x", "http://y", "http://m", "onclick", "mask=", "\\"):
        assert bad not in out


def test_links_must_stay_inside_the_document():
    out = svg_sanitize.sanitize_text(
        f'<svg {NS} xmlns:xlink="http://www.w3.org/1999/xlink"><a href="javascript:alert(1)"><rect/></a>'
        '<a xlink:href="#ok"><circle r="1"/></a><image href="data:image/png;base64,AAAA" width="1"/>'
        '<image href="http://evil/x.png"/></svg>')
    assert "javascript" not in out and "evil" not in out
    assert 'xlink:href="#ok"' in out and 'href="data:image/png;base64,AAAA"' in out
    assert out.startswith("<svg")


def test_a_root_outside_the_svg_namespace_is_refused():
    assert svg_sanitize.sanitize_text('<svg xmlns="http://example.org/other"/>') is None
    assert svg_sanitize.sanitize_text("<svg/>") is None


def test_sanitize_end_to_end():
    clean, why = svg_sanitize.sanitize(f'<svg {NS} viewBox="0 0 1 1"><text>ТЛ</text></svg>'.encode(),
                                       cancelled=lambda: False)
    assert why is None and clean.startswith("<svg") and "ТЛ" in clean and 'viewBox="0 0 1 1"' in clean
    assert svg_sanitize.sanitize(nested(65).encode(), cancelled=lambda: False) == (None, "too-complex")
    assert svg_sanitize.sanitize(b"<svg \xff/>", cancelled=lambda: False) == (None, "invalid")
    assert svg_sanitize.sanitize(f"<svg {NS}><g></svg>".encode(), cancelled=lambda: False) == (None, "invalid")
