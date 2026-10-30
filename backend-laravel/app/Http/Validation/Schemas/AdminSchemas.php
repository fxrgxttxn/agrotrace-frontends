<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Z\Effects;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\Z;

/** packages/validation/src/admin.ts, one to one (OrganizationAdminPatch and the five DictionaryInput schemas). */
final class AdminSchemas
{
    public const CATEGORIES = ['GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'MEAT', 'OILSEED', 'PROCESSED'];

    public const SUBSTANCE_TYPES = ['PESTICIDE', 'FERTILIZER'];

    public static function organizationAdminPatch(): Effects
    {
        return Z::atLeastOneKey(Z::object([
            'name' => Z::nameString(),
            'address' => Z::codePointString(0, 500, '\S')->nullable(),
            'regionCode' => Z::regionCode(),
            'status' => Z::enum(['ACTIVE', 'REJECTED', 'SUSPENDED']),
        ])->partial());
    }

    public static function product(): ObjectS
    {
        return Z::object([
            'name' => Z::codePointString(1, 160, '\S'),
            'category' => Z::enum(self::CATEGORIES),
            'lossNormPercent' => Z::string()->regex('^(100\.00|\d{1,2}\.\d{2})$', 'validation.percent.format'),
            // R81: the ФГИС «Меркурий» product code used by the VSD import; optional, null — no code.
            'mercuryCode' => Z::string()->max(16, 'validation.maxLength')
                ->regex('^\d{2}(\.\d{1,3}){1,3}$', 'validation.mercuryCode.format')->nullable()->optional(),
        ]);
    }

    public static function substance(): ObjectS
    {
        return Z::object([
            'name' => Z::codePointString(1, 160, '\S'),
            'type' => Z::enum(self::SUBSTANCE_TYPES),
            'waitingPeriodDays' => Z::number()->int()->min(0)->max(3650),
        ]);
    }

    public static function indicator(): ObjectS
    {
        return Z::object([
            'name' => Z::codePointString(1, 160, '\S'),
            'unit' => Z::codePointString(1, 24, '\S'),
        ]);
    }

    public static function norm(): ObjectS
    {
        return Z::object([
            'productId' => Z::uuid(),
            'indicatorId' => Z::uuid(),
            'maxValue' => Z::decimal(),
        ]);
    }

    public static function region(): ObjectS
    {
        return Z::object([
            'code' => Z::regionCode(),
            'name' => Z::codePointString(1, 120, '\S'),
        ]);
    }
}
