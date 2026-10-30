<?php

namespace App\Http\Controllers\Waybills;

use App\Actions\Waybills\WaybillsActions;
use App\Http\IfMatch;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Http\Validation\Schemas\WaybillSchemas;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * /waybills/* (contracts/openapi/paths/waybills.yaml; Express waybills/routes.ts). Order of checks: `operation` (401,
 * x-roles) → `idempotency` (x-idempotent) → the path id → `If-Match` and the body (one 400, P36) → the action (locks,
 * 404, side, version, transition, references, per-item rules).
 */
final class WaybillsController
{
    public function listWaybills(Request $request): Response
    {
        return Responses::json(WaybillsActions::list(Auth::principal(), QueryReader::of($request)));
    }

    public function createWaybill(Request $request): Response
    {
        return Responses::json(WaybillsActions::create(Auth::principal(), Responses::body($request)), 201);
    }

    public function getWaybill(Request $request): Response
    {
        return Responses::json(WaybillsActions::get(Auth::principal(), Params::id($request)));
    }

    public function deleteWaybill(Request $request): Response
    {
        $id = Params::id($request);
        WaybillsActions::remove(Auth::principal(), $id, IfMatch::version($request));

        return Responses::noContent();
    }

    public function sendWaybill(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(WaybillsActions::send(Auth::principal(), $id, IfMatch::version($request)));
    }

    public function acceptWaybill(Request $request): Response
    {
        $id = Params::id($request);
        $errors = [];
        $version = IfMatch::read($request, $errors);
        $input = WaybillSchemas::parseAccept(Responses::body($request), $errors);

        return Responses::json(WaybillsActions::accept(Auth::principal(), $id, (int) $version, $input));
    }

    public function rejectWaybill(Request $request): Response
    {
        $id = Params::id($request);
        $errors = [];
        $version = IfMatch::read($request, $errors);
        $input = WaybillSchemas::parseReject(Responses::body($request), $errors);

        return Responses::json(WaybillsActions::reject(Auth::principal(), $id, (int) $version, $input));
    }
}
