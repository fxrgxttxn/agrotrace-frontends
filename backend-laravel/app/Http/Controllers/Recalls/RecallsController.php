<?php

namespace App\Http\Controllers\Recalls;

use App\Actions\Recalls\RecallsActions;
use App\Http\IfMatch;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Http\Validation\Schemas\RecallSchemas;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * /recalls/* and /recall-tasks/* (contracts/openapi/paths/recalls.yaml, recall-tasks.yaml; Express recalls/routes.ts).
 * Order of checks: `operation` (401, x-roles) → `Idempotency-Key` (confirmRecallTask, x-idempotent) → the path id →
 * `If-Match` and the body in one 400 (P36) → the action (locks, 404, version, transitions).
 */
final class RecallsController
{
    public function listRecalls(Request $request): Response
    {
        return Responses::json(RecallsActions::list(QueryReader::of($request)));
    }

    public function createRecall(Request $request): Response
    {
        $out = RecallsActions::create(Auth::principal(), Responses::body($request));

        return Responses::json($out['body'], $out['status']);
    }

    public function getRecall(Request $request): Response
    {
        return Responses::json(RecallsActions::get(Params::id($request)));
    }

    public function getRecallGraph(Request $request): Response
    {
        return Responses::json(RecallsActions::graph(Params::id($request)));
    }

    public function listRecallTasks(Request $request): Response
    {
        return Responses::json(RecallsActions::listTasks(Auth::principal(), QueryReader::of($request)));
    }

    public function confirmRecallTask(Request $request): Response
    {
        $id = Params::id($request);
        $errors = [];
        $version = IfMatch::read($request, $errors);
        RecallSchemas::parseConfirm(Responses::body($request), $errors);

        return Responses::json(RecallsActions::confirm(Auth::principal(), $id, (int) $version));
    }
}
