<?php

namespace App\Http\Controllers\Audit;

use App\Actions\Audit\AuditActions;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /audit-log (contracts/openapi/paths/audit.yaml): the audit journal, read-only for ADMIN and INSPECTOR. */
final class AuditController
{
    public function listAuditLog(Request $request): Response
    {
        return Responses::json(AuditActions::list(QueryReader::of($request)));
    }
}
