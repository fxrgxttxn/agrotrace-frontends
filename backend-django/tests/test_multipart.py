"""multipart/form-data with one `file` part (P14, P17, P20, decision 7 of Express Task 3): the form's 400s before the
413; the stored name is the base name; the size limit is inclusive."""

from types import SimpleNamespace

import pytest

from agrotrace.core.multipart import read_single_file
from agrotrace.core.problem import AppProblem

B = "----agrotraceTEST"


def part(name, data=b"", filename=None, raw_filename=None, content_type="application/octet-stream"):
    head = f'--{B}\r\nContent-Disposition: form-data; name="{name}"'
    if raw_filename is not None:
        head += f"; filename={raw_filename}"
    elif filename is not None:
        head += f'; filename="{filename}"'
    head += "\r\n"
    if filename is not None or raw_filename is not None:
        head += f"Content-Type: {content_type}\r\n"
    return head.encode() + b"\r\n" + data + b"\r\n"


def req(*parts, ct=f"multipart/form-data; boundary={B}"):
    body = b"".join(parts) + f"--{B}--\r\n".encode()
    return SimpleNamespace(META={"CONTENT_TYPE": ct}, body=body)


def errors_of(request, max_bytes=100):
    with pytest.raises(AppProblem) as e:
        read_single_file(request, max_bytes=max_bytes)
    return e.value.status, e.value.errors, e.value.params


def test_one_file_part():
    up = read_single_file(req(part("file", b"abc", filename="a.png")), max_bytes=100)
    assert (up.name, up.data) == ("a.png", b"abc")


def test_a_second_file_part_is_duplicate():
    assert errors_of(req(part("file", b"a", "a.png"), part("file", b"b", "b.png")))[1] == {
        "file": ["validation.duplicate"]}


def test_a_foreign_part_is_unknown_field():
    assert errors_of(req(part("file", b"a", "a.png"), part("caption", b"hello")))[1] == {
        "caption": ["validation.unknownField"]}
    assert errors_of(req(part("file", b"a", "a.png"), part("image", b"x", "b.png")))[1] == {
        "image": ["validation.unknownField"]}


def test_missing_or_empty_file_or_not_multipart_is_required():
    assert errors_of(req(part("caption", b"x")))[1] == {"caption": ["validation.unknownField"],
                                                        "file": ["validation.required"]}
    assert errors_of(req(part("file", b"", "a.png")))[1] == {"file": ["validation.required"]}
    json_req = SimpleNamespace(META={"CONTENT_TYPE": "application/json"}, body=b'{"file":"x"}')
    assert errors_of(json_req)[1] == {"file": ["validation.required"]}


def test_a_broken_body_is_root_invalid():
    broken = SimpleNamespace(META={"CONTENT_TYPE": f"multipart/form-data; boundary={B}"},
                             body=part("file", b"abc", "a.png"))  # no closing delimiter
    assert errors_of(broken)[1] == {"_root": ["validation.invalid"]}
    assert errors_of(req(part("file", b"a", "a.png"), ct="multipart/form-data"))[1] == {
        "_root": ["validation.invalid"]}


def test_path_segments_are_dropped_and_quoted_strings_unescaped():
    assert read_single_file(req(part("file", b"a", raw_filename=r'"a/b\\c.png"')), max_bytes=10).name == "c.png"
    assert read_single_file(req(part("file", b"a", raw_filename=r'"say \"cheese\".png"')), max_bytes=10).name == (
        'say "cheese".png')
    utf8 = part("file", b"a", filename="x").replace(b'filename="x"', 'filename="Моё фото.png"'.encode())
    assert read_single_file(req(utf8), max_bytes=10).name == "Моё фото.png"


def test_the_base_name_length_is_counted_in_code_points():
    ok = "я" * 251 + ".png"
    assert read_single_file(req(part("file", b"a", filename=ok)), max_bytes=10).name == ok
    too_long = "я" * 252 + ".png"
    assert errors_of(req(part("file", b"a", filename=too_long)))[1] == {"file": ["validation.maxLength"]}
    # after the path segments are dropped (P20)
    assert read_single_file(req(part("file", b"a", filename="d/" * 200 + "x.png")), max_bytes=10).name == "x.png"


def test_the_limit_is_inclusive_and_400_comes_before_413():
    assert len(read_single_file(req(part("file", b"x" * 100, "a.png")), max_bytes=100).data) == 100
    status, _, params = errors_of(req(part("file", b"x" * 101, "a.png")), max_bytes=100)
    assert (status, params) == (413, {"maxBytes": 100})
    status, errors, _ = errors_of(req(part("file", b"x" * 101, "a.png"), part("caption", b"x")), max_bytes=100)
    assert (status, errors) == (400, {"caption": ["validation.unknownField"]})
