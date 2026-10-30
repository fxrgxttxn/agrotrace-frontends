<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Z\Effects;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\StringS;
use App\Http\Validation\Z\Z;

/** packages/validation/src/auth.ts, one to one. */
final class AuthSchemas
{
    private static function totpCode(): StringS
    {
        return Z::string()->regex('^\d{6}$', 'validation.totp.format');
    }

    private static function token(): Effects
    {
        return Z::codePointString(16, 256);
    }

    public static function login(): ObjectS
    {
        return Z::object(['email' => Z::email(), 'password' => Z::codePointString(1, 128)]);
    }

    public static function twoFactorVerify(): ObjectS
    {
        return Z::object(['challengeId' => Z::uuid(), 'code' => self::totpCode()]);
    }

    public static function twoFactorSetup(): ObjectS
    {
        return Z::object(['code' => self::totpCode()->optional()]);
    }

    public static function forgotPassword(): ObjectS
    {
        return Z::object(['email' => Z::email()]);
    }

    public static function resetPassword(): ObjectS
    {
        return Z::object(['token' => self::token(), 'password' => Z::password()]);
    }

    public static function registerOrganization(): ObjectS
    {
        return Z::object([
            'inn' => Z::inn(),
            'type' => Z::enum(['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY']),
            'name' => Z::nameString()->optional(),
            'regionCode' => Z::codePointString(1, 8),
            'admin' => Z::object([
                'email' => Z::email(),
                'fullName' => Z::nameString(),
                'password' => Z::password(),
            ]),
        ]);
    }

    public static function acceptInvite(): ObjectS
    {
        return Z::object(['token' => self::token(), 'fullName' => Z::nameString(), 'password' => Z::password()]);
    }
}
