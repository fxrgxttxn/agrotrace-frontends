"""The image pipeline (FR-FILE-02/04): the type by signature, WebP 96/480 never enlarged, undecodable or oversized
images refused (→ 415 by the caller)."""

import io

from PIL import Image

from agrotrace.infra.images import sniff, variants


def png(w, h, mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, (w, h), (10, 120, 200) if mode == "RGB" else 1).save(buf, "PNG")
    return buf.getvalue()


def webp_size(b: bytes) -> tuple[int, int]:
    img = Image.open(io.BytesIO(b))
    assert img.format == "WEBP"
    return img.size


def test_sniff_by_signature():
    assert sniff(png(4, 4)) == "image/png"
    assert sniff(b"\xff\xd8\xff\xe0rest") == "image/jpeg"
    assert sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert sniff(b"%PDF-1.7\n") == "application/pdf"
    assert sniff(b'<?xml version="1.0"?>\n<!-- c --><svg xmlns="http://www.w3.org/2000/svg"/>') == "image/svg+xml"
    assert sniff(b"\xef\xbb\xbf<svg>") == "image/svg+xml"
    assert sniff(b"hello <svg>") is None
    assert sniff(b"<svg\x00>") is None


def test_a_png_under_a_jpeg_name_is_png():
    # The name and Content-Type never matter: only the bytes reach sniff().
    assert sniff(png(10, 10)) == "image/png"


def test_variants_fit_the_longer_side_and_never_enlarge():
    out = variants(png(640, 320), "image/png")
    assert out is not None
    assert webp_size(out["480"]) == (480, 240) and webp_size(out["96"]) == (96, 48)
    tiny = variants(png(40, 20), "image/png")
    assert webp_size(tiny["96"]) == (40, 20) and webp_size(tiny["480"]) == (40, 20)


def test_broken_or_forged_images_are_refused():
    assert variants(b"\x89PNG\r\n\x1a\nthis is text", "image/png") is None
    assert variants(png(640, 320)[:200], "image/png") is None  # truncated
    assert variants(png(10, 10), "image/jpeg") is None  # the signature says one format, the content another


def test_more_than_40_megapixels_is_refused():
    assert variants(png(8000, 5001, mode="1"), "image/png") is None
    assert variants(png(8000, 5000, mode="1"), "image/png") is not None
