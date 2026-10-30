<?php

namespace App\Http\Controllers\Admin;

use App\Actions\Admin\AdminActions;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /admin/organizations/* (contracts/openapi/paths/admin.yaml): HTTP mapping of AdminActions. */
final class AdminController
{
    public function listAdminOrganizations(Request $request): Response
    {
        return Responses::json(AdminActions::list(QueryReader::of($request)));
    }

    public function updateAdminOrganization(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(AdminActions::update(Auth::principal(), $id, Responses::body($request)));
    }

    /** The operation declares no 400: a malformed id names no organization → 404 (D1). */
    public function approveOrganization(Request $request): Response
    {
        $id = $request->route('id');
        if (! is_string($id) || ! QueryReader::isUuid($id)) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }

        return Responses::json(AdminActions::approve(Auth::principal(), strtolower($id)));
    }
}
