<?php

namespace App\Http\Controllers\Analytics;

use App\Actions\Analytics\Dashboard;
use App\Actions\Reports\ReportAborted;
use App\Actions\Reports\ReportsActions;
use App\Http\ClientConnection;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * GET /analytics/dashboard (paths/analytics.yaml) and GET /reports/{type} (paths/reports.yaml; Express
 * reports/routes.ts). The report goes out as an attachment named by the contract (ASCII only, so `filename` and
 * `filename*` carry the same name), with `Content-Length` and `Cache-Control: no-store`. A client that went away while
 * its report waited for the renderer gives up its place and gets nothing.
 */
final class AnalyticsController
{
    public function getDashboard(Request $request): Response
    {
        return Responses::json(Dashboard::get(Auth::principal(), QueryReader::of($request)));
    }

    public function downloadReport(Request $request): Response
    {
        try {
            $f = ReportsActions::download(
                Auth::principal(),
                $request->route('type'),
                QueryReader::of($request),
                ClientConnection::watcher($request),
            );
        } catch (ReportAborted) {
            return Responses::noContent(); // nobody reads it: the connection is gone
        }

        return Responses::make($f['bytes'], 200, [
            'Content-Type' => $f['contentType'],
            'Content-Length' => (string) strlen($f['bytes']),
            'Content-Disposition' => "attachment; filename=\"{$f['fileName']}\"; filename*=UTF-8''{$f['fileName']}",
            'Cache-Control' => 'no-store',
        ]);
    }
}
