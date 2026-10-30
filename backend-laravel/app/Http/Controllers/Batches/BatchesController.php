<?php

namespace App\Http\Controllers\Batches;

use App\Actions\Batches\BatchesActions;
use App\Actions\Batches\QrActions;
use App\Actions\Documents\DocumentsActions;
use App\Http\IfMatch;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Http\Validation\Body;
use App\Http\Validation\Schemas\BatchSchemas;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /batches/* (contracts/openapi/paths/batches.yaml): HTTP mapping of the batches, QR and documents actions. */
final class BatchesController
{
    public function listBatches(Request $request): Response
    {
        return Responses::json(BatchesActions::list(Auth::principal(), QueryReader::of($request)));
    }

    public function createBatch(Request $request): Response
    {
        return Responses::json(BatchesActions::create(Auth::principal(), Responses::body($request)), 201);
    }

    public function getBatch(Request $request): Response
    {
        return Responses::json(BatchesActions::get(Auth::principal(), Params::id($request)));
    }

    public function getBatchGraph(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(BatchesActions::graph(Auth::principal(), $id, QueryReader::of($request)));
    }

    public function getBatchHistory(Request $request): Response
    {
        return Responses::json(BatchesActions::history(Auth::principal(), Params::id($request)));
    }

    public function getBatchPath(Request $request): Response
    {
        return Responses::json(BatchesActions::path(Auth::principal(), Params::id($request)));
    }

    public function createBatchQr(Request $request): Response
    {
        $id = Params::id($request);
        // The request body is optional: absent (JsonBody leaves `{}`) or exactly `{}`.
        Body::parse(BatchSchemas::qrRequest(), Responses::body($request));

        return Responses::json(QrActions::create(Auth::principal(), $id), 201);
    }

    public function downloadBatchQr(Request $request): Response
    {
        $id = Params::id($request);
        $q = QueryReader::of($request);
        $format = $q->enum('format', ['png', 'pdf']);
        if (! $q->has('format')) {
            $q->add('format', 'validation.required');
        }
        $q->done();

        return QrActions::download($request, Auth::principal(), $id, (string) $format);
    }

    public function getBatchDocuments(Request $request): Response
    {
        return Responses::json(DocumentsActions::get(Auth::principal(), Params::id($request)));
    }

    public function retryBatchVsdImport(Request $request): Response
    {
        return Responses::json(DocumentsActions::retry(Auth::principal(), Params::id($request)), 202);
    }

    public function putBatchOnSale(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(BatchesActions::putOnSale(Auth::principal(), $id, IfMatch::version($request)));
    }

    public function markBatchSold(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(BatchesActions::markSold(Auth::principal(), $id, IfMatch::version($request)));
    }
}
