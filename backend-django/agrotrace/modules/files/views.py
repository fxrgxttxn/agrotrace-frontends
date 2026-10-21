"""
downloadFile (`GET /files/{id}`, x-access: signed) and downloadPublicFile (`GET /public/files/{id}`), the port of
backend-express/src/modules/files/routes.ts. downloadFile, in this order:
1. a valid Bearer token counts against the `user` limit — also when a signature is present;
2. `exp` or `sig` present → only the signature decides: both must be there as single values, `exp` by
   `^[1-9]\\d{0,11}$` and not in the past, `sig` 64 lower-case hex equal to the contract's HMAC (constant time) —
   otherwise 403 FORBIDDEN (decision 9, P17); rights are not checked and Authorization is ignored; `variant` is not
   signed;
3. no signature → a valid Bearer token or 401;
4. 400 for `id` / `variant`; 5. a missing, deleted or (Bearer) unreadable file → 404.
"""

from __future__ import annotations

from rest_framework.views import APIView

from agrotrace.core import ratelimit
from agrotrace.core.auth import bearer_principal
from agrotrace.core.params import parse_query, variant_param
from agrotrace.core.problem import AppProblem
from agrotrace.core.views import ContractView
from agrotrace.infra import file_urls
from agrotrace.modules.files import services


def _bad_signature() -> AppProblem:
    return AppProblem(403, "FORBIDDEN", title="Invalid or expired signature")


class DownloadFileView(ContractView):
    operation_id = "downloadFile"

    def initial(self, request, *args, **kwargs):
        # Not ContractView's order: a signature replaces the Bearer requirement (x-access: signed).
        APIView.initial(self, request, *args, **kwargs)
        self.principal = bearer_principal(request)
        if self.principal is not None:
            ratelimit.hit("user", self.principal.user_id)

    def get(self, request, id):
        query = parse_query(request.META.get("QUERY_STRING", ""))
        signed = "exp" in query or "sig" in query
        if signed:
            exp, sig = query.get("exp"), query.get("sig")
            if not isinstance(exp, str) or not isinstance(sig, str) or not file_urls.verify(id, exp, sig):
                raise _bad_signature()
        elif self.principal is None:
            raise AppProblem(401, "UNAUTHORIZED")
        file_id = self.path_uuid()
        variant = variant_param(request)
        f = services.live_file(file_id)
        if f is None or (not signed and not services.can_read(self.principal, f)):  # type: ignore[arg-type]
            raise AppProblem(404, "NOT_FOUND")
        return services.serve(request, f, variant, services.CACHE_PRIVATE)


class DownloadPublicFileView(ContractView):
    operation_id = "downloadPublicFile"

    def get(self, request, id):
        file_id = self.path_uuid()
        variant = variant_param(request)
        f = services.live_file(file_id)
        if f is None or f["kind"] not in services.PUBLIC_KINDS:
            raise AppProblem(404, "NOT_FOUND")
        return services.serve(request, f, variant, services.CACHE_PUBLIC)
