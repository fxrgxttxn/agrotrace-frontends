"""
/auth/* (contracts/openapi/paths/auth.yaml), the HTTP mapping of modules.auth.services, the port of
backend-express/src/modules/auth/routes.ts: the `at_refresh` cookie lines (R32/R40), statuses, and
`Cache-Control: no-store` on every response that carries a token (P9; login also for the 2FA challenge).
"""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.problem import AppProblem
from agrotrace.core.views import ContractView
from agrotrace.modules.auth import serializers as s
from agrotrace.modules.auth import services, sessions


def _session_response(session: services.Session) -> Response:
    res = Response(session.body(), status=200)
    res["Set-Cookie"] = sessions.set_refresh_cookie(session.refresh_token)
    res["Cache-Control"] = "no-store"
    return res


def _cookie(request) -> str | None:
    return sessions.refresh_cookie_of(request.META.get("HTTP_COOKIE"))


class LoginView(ContractView):
    operation_id = "login"

    def post(self, request):
        result = services.login(self.body(s.LoginRequest))
        if isinstance(result, str):
            res = Response({"twoFactorRequired": True, "challengeId": result}, status=200)
            res["Cache-Control"] = "no-store"
            return res
        return _session_response(result)


class VerifyTwoFactorView(ContractView):
    operation_id = "verifyTwoFactor"

    def post(self, request):
        return _session_response(services.verify_two_factor(self.body(s.TwoFactorVerifyRequest)))


class SetupTwoFactorView(ContractView):
    operation_id = "setupTwoFactor"

    def post(self, request):
        assert self.principal is not None
        res = Response(services.setup_two_factor(self.principal, self.body(s.TwoFactorSetupRequest)), status=200)
        res["Cache-Control"] = "no-store"
        return res


class RefreshView(ContractView):
    operation_id = "refreshToken"

    def post(self, request):
        outcome = sessions.rotate(_cookie(request))
        if outcome.kind == "rotated":
            assert outcome.user_id is not None and outcome.token is not None
            res = Response({"accessToken": services.access_token_for(outcome.user_id), "expiresIn": 900}, status=200)
            res["Set-Cookie"] = sessions.set_refresh_cookie(outcome.token)
            res["Cache-Control"] = "no-store"
            return res
        if outcome.kind == "expired":
            headers = {"Set-Cookie": sessions.CLEAR_REFRESH_COOKIE} if outcome.clear_cookie else None
            raise AppProblem(401, "TOKEN_EXPIRED", title="Refresh token expired", headers=headers)
        raise AppProblem(403, "FORBIDDEN", params={"reason": outcome.reason},
                         headers={"Set-Cookie": sessions.CLEAR_REFRESH_COOKIE})


class LogoutView(ContractView):
    operation_id = "logout"

    def post(self, request):
        sessions.revoke(_cookie(request))
        res = Response(status=204)
        res["Set-Cookie"] = sessions.CLEAR_REFRESH_COOKIE
        return res


class ForgotPasswordView(ContractView):
    operation_id = "forgotPassword"

    def post(self, request):
        services.forgot_password(self.body(s.ForgotPasswordRequest))
        return Response(status=204)


class ResetPasswordView(ContractView):
    operation_id = "resetPassword"

    def post(self, request):
        services.reset_password(self.body(s.ResetPasswordRequest))
        return Response(status=204)


class RegisterOrganizationView(ContractView):
    operation_id = "registerOrganization"

    def post(self, request):
        return Response(services.register_organization(self.body(s.RegisterOrganizationRequest)), status=201)


class AcceptInviteView(ContractView):
    operation_id = "acceptInvite"

    def post(self, request):
        services.accept_invite(self.body(s.AcceptInviteRequest))
        return Response(status=204)
