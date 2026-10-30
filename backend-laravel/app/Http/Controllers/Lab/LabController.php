<?php

namespace App\Http\Controllers\Lab;

use App\Actions\Lab\LabActions;
use App\Http\IfMatch;
use App\Http\Multipart\MultipartReader;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Http\Validation\Schemas\LabSchemas;
use App\Infrastructure\Files\Files;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * /lab-tests/* (contracts/openapi/paths/lab.yaml; Express lab/routes.ts). Order of checks: `operation` (401, x-roles)
 * → the path id → `If-Match` and the body in one 400 (P36) → the action (lock, 404, version, transition, per-operation
 * steps); the protocol upload: the multipart reader (400, 413) first.
 */
final class LabController
{
    public function listLabTests(Request $request): Response
    {
        return Responses::json(LabActions::list(Auth::principal(), QueryReader::of($request)));
    }

    public function createLabTest(Request $request): Response
    {
        return Responses::json(LabActions::create(Auth::principal(), Responses::body($request)), 201);
    }

    public function getLabTest(Request $request): Response
    {
        return Responses::json(LabActions::get(Auth::principal(), Params::id($request)));
    }

    public function registerLabSample(Request $request): Response
    {
        $id = Params::id($request);
        $errors = [];
        $version = IfMatch::read($request, $errors);
        LabSchemas::parseSample(Responses::body($request), $errors);

        return Responses::json(LabActions::sample(Auth::principal(), $id, (int) $version));
    }

    public function submitLabResults(Request $request): Response
    {
        $id = Params::id($request);
        $errors = [];
        $version = IfMatch::read($request, $errors);
        $input = LabSchemas::parseResults(Responses::body($request), $errors);

        return Responses::json(LabActions::submit(Auth::principal(), $id, (int) $version, $input));
    }

    public function uploadLabProtocol(Request $request): Response
    {
        $id = Params::id($request);
        $upload = MultipartReader::read($request, LabActions::PROTOCOL_MAX_BYTES);

        return Responses::json(LabActions::uploadProtocol(Auth::principal(), $id, $upload));
    }

    public function downloadLabProtocol(Request $request): Response
    {
        $file = LabActions::protocolFile(Auth::principal(), Params::id($request));

        return Files::send($request, $file, 480, Files::CACHE_PRIVATE);
    }
}
