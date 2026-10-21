<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Z\Effects;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\Z;
use App\Security\Principal;

/** packages/validation/src/profile.ts, one to one (MeUpdate, ChannelsUpdate, UserInvite, UserPatch). */
final class ProfileSchemas
{
    public static function meUpdate(): Effects
    {
        $phone = Z::string()->regex('^\+[1-9]\d{6,14}$', 'validation.phone.format')->nullable();

        return Z::atLeastOneKey(Z::object(['fullName' => Z::nameString(), 'phone' => $phone])->partial());
    }

    public static function channelsUpdate(): ObjectS
    {
        return Z::object(['email' => Z::boolean(), 'telegram' => Z::boolean()]);
    }

    private static function roles(): Effects
    {
        return Z::array(Z::enum(Principal::ROLES))->min(1, 'validation.minItems')
            ->refine(fn (array $a) => Z::unique($a), 'validation.duplicate');
    }

    public static function userInvite(): ObjectS
    {
        return Z::object([
            'email' => Z::email(),
            'fullName' => Z::nameString(),
            'roles' => self::roles(),
            'isOrgAdmin' => Z::boolean(),
            'organizationId' => Z::uuid()->optional(),
        ]);
    }

    public static function userPatch(): Effects
    {
        return Z::atLeastOneKey(Z::object([
            'roles' => self::roles(),
            'isOrgAdmin' => Z::boolean(),
            'status' => Z::enum(['ACTIVE', 'BLOCKED']),
        ])->partial());
    }
}
