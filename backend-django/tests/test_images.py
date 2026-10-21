"""The image pipeline (FR-FILE-02/04): the type by signature, WebP 96/480 never enlarged, undecodable or oversized
images refused (→ 415 by the caller)."""

import io
import os
import threading
import time

import pytest
from PIL import Image

from agrotrace.infra.images import render, sniff


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
    out = render(png(640, 320), "image/png")
    assert out is not None
    assert webp_size(out["480"]) == (480, 240) and webp_size(out["96"]) == (96, 48)
    tiny = render(png(40, 20), "image/png")
    assert webp_size(tiny["96"]) == (40, 20) and webp_size(tiny["480"]) == (40, 20)


def test_broken_or_forged_images_are_refused():
    assert render(b"\x89PNG\r\n\x1a\nthis is text", "image/png") is None
    assert render(png(640, 320)[:200], "image/png") is None  # truncated
    assert render(png(10, 10), "image/jpeg") is None  # the signature says one format, the content another


def test_more_than_40_megapixels_is_refused():
    assert render(png(8000, 5001, mode="1"), "image/png") is None
    assert render(png(8000, 5000, mode="1"), "image/png") is not None


def jpeg(w, h) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 30)).save(buf, "JPEG", quality=85)
    return buf.getvalue()


def test_grey_and_jpeg_sources_keep_the_sharp_sizes():
    grey = render(png(6000, 6600, mode="L"), "image/png")  # resized in mode L, converted only at the end
    assert webp_size(grey["480"]) == (436, 480) and webp_size(grey["96"]) == (87, 96)
    jp = render(jpeg(3000, 1500), "image/jpeg")  # decoded at a reduced scale (draft)
    assert webp_size(jp["480"]) == (480, 240) and webp_size(jp["96"]) == (96, 48)


def test_raster_work_is_bounded_to_two_children_and_runs_out_of_process():
    """Ruling Q8: 8 parallel uploads → at most 2 decodes at a time (the rest queue), every one served."""
    from agrotrace.infra import images

    lane = images.lane()
    assert lane.max_running == 2
    data = png(3000, 3000, mode="L")
    results, peak = [], [0]
    stop = threading.Event()

    def sample():
        while not stop.is_set():
            with lane._cv:
                peak[0] = max(peak[0], lane._running)
            time.sleep(0.005)

    sampler = threading.Thread(target=sample)
    sampler.start()
    threads = [threading.Thread(target=lambda: results.append(images.variants(data, "image/png",
                                                                             cancelled=lambda: False)))
               for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    stop.set()
    sampler.join()
    assert len(results) == 8 and all(r is not None and webp_size(r["480"]) == (480, 480) for r in results)
    assert peak[0] == 2  # bounded, and the lane really ran two at once
    ex, _ = lane._engine()
    assert all(p.pid != os.getpid() for p in ex._processes.values())


def test_a_crashed_decode_is_none_and_a_refusal_raises(monkeypatch):
    from agrotrace.infra import images
    from agrotrace.infra.lanes import Outcome

    class FakeLane:
        def __init__(self, outcome):
            self.outcome = outcome

        def run(self, *a, **k):
            return self.outcome

    monkeypatch.setattr(images, "lane", lambda: FakeLane(Outcome(False, reason="too-complex", cause="crashed")))
    assert images.variants(b"x", "image/png", cancelled=lambda: False) is None
    monkeypatch.setattr(images, "lane", lambda: FakeLane(Outcome(False, reason="too-complex", cause="busy")))
    with pytest.raises(images.RasterBusy):
        images.variants(b"x", "image/png", cancelled=lambda: False)
