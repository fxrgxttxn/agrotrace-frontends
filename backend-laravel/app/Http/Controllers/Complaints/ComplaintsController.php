<?php

namespace App\Http\Controllers\Complaints;

use App\Actions\Complaints\ComplaintsActions;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * /complaints/* (contracts/openapi/paths/complaints.yaml; Express complaints/routes.ts), INSPECTOR only. Order:
 * `operation` (401, x-roles) → the path id → the body (400) → the action (lock, 404, transition, references).
 */
final class ComplaintsController
{
    public function listComplaints(Request $request): Response
    {
        return Responses::json(ComplaintsActions::list(QueryReader::of($request)));
    }

    public function getComplaint(Request $request): Response
    {
        return Responses::json(ComplaintsActions::get(Params::id($request)));
    }

    public function startComplaintReview(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(ComplaintsActions::review(Auth::principal(), $id, Responses::body($request)));
    }

    public function decideComplaint(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(ComplaintsActions::decide(Auth::principal(), $id, Responses::body($request)));
    }
}
