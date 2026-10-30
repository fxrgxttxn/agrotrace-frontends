"""Request bodies of /auth/* — the port of packages/validation/src/auth.ts (same error keys and paths)."""

from __future__ import annotations

from agrotrace.core.validation import (
    ContractSerializer,
    Email,
    Enum,
    Inn,
    NameString,
    Password,
    Str,
    String,
    Uuid,
    _regex,
)


def TotpCode():  # noqa: N802
    return Str([(_regex(r"^\d{6}$"), "validation.totp.format")])


def Token():  # noqa: N802
    return String(16, 256)


class LoginRequest(ContractSerializer):
    email = Email()
    password = String(1, 128)


class TwoFactorVerifyRequest(ContractSerializer):
    challengeId = Uuid()  # noqa: N815
    code = TotpCode()


class TwoFactorSetupRequest(ContractSerializer):
    code = TotpCode().optional()


class ForgotPasswordRequest(ContractSerializer):
    email = Email()


class ResetPasswordRequest(ContractSerializer):
    token = Token()
    password = Password()


class RegistrationAdmin(ContractSerializer):
    email = Email()
    fullName = NameString()  # noqa: N815
    password = Password()


class RegisterOrganizationRequest(ContractSerializer):
    inn = Inn()
    type = Enum(("FARM", "PROCESSOR", "LAB", "RETAILER", "AUTHORITY"))
    name = NameString().optional()
    regionCode = String(1, 8)  # noqa: N815
    admin = RegistrationAdmin()


class AcceptInviteRequest(ContractSerializer):
    token = Token()
    fullName = NameString()  # noqa: N815
    password = Password()
