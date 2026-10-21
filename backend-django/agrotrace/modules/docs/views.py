"""
Swagger UI at /api/v1/docs (spec 8.3) over the bundled contract (served byte for byte). Every asset comes from
swagger-ui-dist in the image (no CDN) and the page has no inline script or event handler — it works under the
gateway's CSP `script-src 'self'` (R89/I6): the initializer is a static file, init.js. Not contract operations: any
method but GET/HEAD is 404, like Express's router.
"""

from __future__ import annotations

from functools import cache

from django.http import HttpResponse

from agrotrace.core import contract
from agrotrace.core.config import ROOT
from agrotrace.core.problem import AppProblem, problem_response

BASE = "/api/v1/docs"
DIST = ROOT / "assets" / "swagger-ui"

ASSETS: dict[str, tuple[str, str]] = {
    "swagger-ui.css": ("swagger-ui.css", "text/css; charset=utf-8"),
    "swagger-ui-bundle.js": ("swagger-ui-bundle.js", "text/javascript; charset=utf-8"),
    "swagger-ui-standalone-preset.js": ("swagger-ui-standalone-preset.js", "text/javascript; charset=utf-8"),
    "favicon-32x32.png": ("favicon-32x32.png", "image/png"),
}

INDEX_HTML = f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>AgroTrace API — Django</title>
<link rel="stylesheet" href="{BASE}/swagger-ui.css">
<link rel="icon" type="image/png" href="{BASE}/favicon-32x32.png">
</head>
<body>
<div id="swagger-ui"></div>
<script src="{BASE}/swagger-ui-bundle.js"></script>
<script src="{BASE}/swagger-ui-standalone-preset.js"></script>
<script src="{BASE}/init.js"></script>
</body>
</html>
"""

INIT_JS = f"""window.addEventListener('load', function () {{
  window.ui = SwaggerUIBundle({{
    url: '{BASE}/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
  }});
}});
"""

#: The page's own policy (also when reached without the gateway, which sets the same one).
CSP = ("default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; font-src 'self'; frame-ancestors 'none'")


@cache
def _asset(name: str) -> bytes:
    return (DIST / ASSETS[name][0]).read_bytes()


def _send(body: bytes | str, content_type: str, cache_control: str) -> HttpResponse:
    res = HttpResponse(body, content_type=content_type)
    res["Cache-Control"] = cache_control
    res["X-Content-Type-Options"] = "nosniff"
    return res


def _get_only(view):
    def wrapped(request, *args, **kwargs):
        if request.method not in ("GET", "HEAD"):
            return problem_response(AppProblem(404, "NOT_FOUND"))
        return view(request, *args, **kwargs)

    return wrapped


@_get_only
def page(request):
    res = _send(INDEX_HTML, "text/html; charset=utf-8", "no-cache")
    res["Content-Security-Policy"] = CSP
    return res


@_get_only
def init_js(request):
    return _send(INIT_JS, "text/javascript; charset=utf-8", "no-cache")


@_get_only
def openapi_json(request):
    return _send(contract.load().raw, "application/json; charset=utf-8", "no-cache")


@_get_only
def asset(request, name: str):
    if name not in ASSETS:
        return problem_response(AppProblem(404, "NOT_FOUND"))
    return _send(_asset(name), ASSETS[name][1], "public, max-age=86400")
