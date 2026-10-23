<?php

namespace App\Http\Controllers\Processing;

use App\Actions\Processing\ProcessBatches;
use App\Http\Responses;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /processing (contracts/openapi/paths/processing.yaml; Express processing/routes.ts). */
final class ProcessingController
{
    public function processBatches(Request $request): Response
    {
        return Responses::json(ProcessBatches::run(Auth::principal(), Responses::body($request)), 201);
    }
}
