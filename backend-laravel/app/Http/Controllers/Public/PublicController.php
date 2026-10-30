<?php

namespace App\Http\Controllers\Public;

use App\Actions\Public\PublicActions;
use App\Http\Responses;
use App\Support\RequestContext;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * /public/batches/{publicCode}, /public/batches/{publicCode}/complaints, /public/captcha (contracts/openapi/paths/
 * public.yaml; Express public/routes.ts): no authentication (`security: []`, x-roles PUBLIC). downloadPublicFile and
 * listPublicRegions live with files and dictionaries.
 */
final class PublicController
{
    public function getPublicBatch(Request $request): Response
    {
        $bytes = PublicActions::page(self::code($request));

        return Responses::make($bytes, 200, ['Content-Type' => 'application/json; charset=utf-8']);
    }

    public function createPublicComplaint(Request $request): Response
    {
        $ip = app(RequestContext::class)->clientIp();

        return Responses::json(PublicActions::complain($ip, self::code($request), Responses::body($request)), 201);
    }

    public function getCaptchaChallenge(): Response
    {
        return Responses::json(PublicActions::captcha(), 200, ['Cache-Control' => 'no-store']);
    }

    private static function code(Request $request): string
    {
        $v = $request->route('publicCode');

        return is_string($v) ? $v : '';
    }
}
