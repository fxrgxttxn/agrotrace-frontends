"""
ContractView — the base of every operation's view. `initial()` runs the contract's order (info.description; Express
`guard()` + `idempotency()`):

1. authentication (Bearer, unless `x-roles: [PUBLIC]`) → 401 UNAUTHORIZED;
2. the `user` rate limit (every Bearer-authenticated request counts, after authentication and before the role check —
   decision 10 of Express Task 2);
3. `x-roles` / `x-org-admin` → 403 FORBIDDEN;
4. the IP-subject scopes of `x-rate-limit` (login-ip, complaint-ip; `forgot` is counted by its operation after the
   body, like Express);
5. `Idempotency-Key` when `x-idempotent` (400/409, or the stored response replayed).
Then the handler: path parameters first and alone (`path_uuid`), then If-Match + body errors in one 400 (P36,
final M2: `if_match_errors()` + `body(…, extra_errors=…)`).

Every view call ends with `connections.close_all()` in the view's own thread (D-I7): a request the client abandoned
still returns its pool connection, even when Django's `request_finished` never runs for it.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.db import connections
from rest_framework.response import Response
from rest_framework.views import APIView

from agrotrace.core import access, contract, idempotency, ratelimit
from agrotrace.core.auth import authenticate
from agrotrace.core.if_match import if_match_version, read_if_match
from agrotrace.core.middleware import client_ip, raw_path
from agrotrace.core.patterns import ecma
from agrotrace.core.problem import exception_handler, validation_problem
from agrotrace.core.validation import ContractSerializer
from agrotrace.security.jwt import Principal

_UUID = ecma(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")


def is_uuid(v: Any) -> bool:
    return isinstance(v, str) and _UUID.search(v) is not None


class ContractView(APIView):
    #: The contract's operationId this view implements (x-roles, x-rate-limit, x-idempotent are read from it).
    operation_id: ClassVar[str] = ""
    #: One path, several operations (GET /me + PATCH /me): HTTP method → operationId (HEAD counts as GET).
    operation_ids: ClassVar[dict[str, str]] = {}
    principal: Principal | None = None
    _idem: idempotency.Claim | None = None

    def dispatch(self, request, *args, **kwargs):
        try:
            return super().dispatch(request, *args, **kwargs)
        finally:
            connections.close_all()

    @property
    def current_operation_id(self) -> str:
        method = getattr(getattr(self, "request", None), "method", None) or "GET"
        method = "GET" if method == "HEAD" else method
        return self.operation_ids.get(method) or self.operation_id

    @property
    def operation(self) -> dict[str, Any]:
        return contract.operation(self.current_operation_id)

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        op = self.operation
        if not access.is_public(op):
            principal = authenticate(request)
            ratelimit.hit("user", principal.user_id)
            access.require(op, principal)
            self.principal = principal
        for scope in op.get("x-rate-limit") or []:
            if ratelimit.limit_of(scope).subject == "ip":
                ratelimit.hit(scope, client_ip(request) or "unknown")
        if op.get("x-idempotent") is True:
            assert self.principal is not None, f"{self.current_operation_id}: x-idempotent needs a Bearer principal"
            self._idem = idempotency.begin(
                self.principal.user_id,
                request.META.get("HTTP_IDEMPOTENCY_KEY"),
                request.method,
                raw_path(request),
                getattr(request, "raw_body", b""),
            )

    def handle_exception(self, exc):
        if isinstance(exc, idempotency.Replay):
            return exc.response
        return exception_handler(exc, self.get_exception_handler_context())

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        # DRF advertises its own method list (with OPTIONS) on every answer; only the contract's 405 carries Allow.
        if response.status_code != 405 and response.has_header("Allow"):
            del response["Allow"]
        if self._idem is not None:
            status = response.status_code
            body = None
            if 200 <= status < 300 and not getattr(response, "streaming", False):
                # The record keeps the body exactly as the client gets it: render now (DRF renders lazily; Django
                # does not render a rendered response twice) and store those bytes.
                if isinstance(response, Response) and not response.is_rendered:
                    try:
                        response.render()
                    except BaseException:
                        # Django answers 500 (handler500); the key is freed so that a retry runs again, as Express
                        # releases it on a crash rendered as 500 (Task 7 review M1).
                        self._idem.settle(500, None)
                        raise
                body = idempotency.response_body_json(response.content)
            self._idem.settle(status, body)
        return response

    # ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────
    def path_uuid(self, name: str = "id") -> str:
        """`IdPath` (uuid) → lower case; otherwise 400 `errors.<name>: [validation.uuid]` (alone, first — P36)."""
        v = self.kwargs.get(name)
        if not is_uuid(v):
            raise validation_problem({name: ["validation.uuid"]})
        return v.lower()

    def body(self, serializer_cls: type[ContractSerializer], *, extra_errors: dict | None = None) -> dict[str, Any]:
        """The request body parsed by `serializer_cls` (+ the request's other parameter errors in the same 400)."""
        return serializer_cls.parse_body(getattr(self.request, "json_body", {}), extra_errors=extra_errors)

    def if_match(self) -> int:
        return if_match_version(self.request)

    def if_match_errors(self) -> tuple[int | None, dict[str, list[str]]]:
        return read_if_match(self.request)
