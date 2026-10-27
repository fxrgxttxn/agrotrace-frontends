<?php

namespace App\Actions\Reports;

use App\Actions\Analytics\Window;
use App\Contract\Contract;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Pdf\LabelPdf;
use App\Security\Principal;
use App\Support\Iso;

/**
 * downloadReport (contracts/openapi/paths/reports.yaml; FR-ANL-04, FR-ANL-05; Express modules/reports/service.ts).
 * Order: `operation` (401, x-roles) → `type` (path enum, 400) → access by `x-report-access` (read from the contract):
 * `roles` — the whole system; `headRoles` — an organization head (`is_org_admin`) of such a role, own organization
 * only; neither — 403 FORBIDDEN without params → parameters in one 400 (format required; window as the dashboard's;
 * `recall`: from/to notAllowed, id required; `org`: id required for full access, a head may omit it or pass its own;
 * other types: id notAllowed) → admission to the render queue (full → 503 report-busy, before any data is read) → in
 * one READ ONLY REPEATABLE READ snapshot: 404 (recall or organization missing/deleted), the contents → the DB slot and
 * connection released (P61) → more than REPORT_MAX_ROWS data rows in a sheet → 400 `errors.type:
 * [validation.report.tooManyRows]` → the file, rendered in the sandbox (not stored).
 */
final class ReportsActions
{
    public const TYPES = ['batches', 'recalls', 'recall', 'lab-tests', 'complaints', 'org'];

    public const FORMATS = ['xlsx', 'pdf'];

    public const MIME = [
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'pdf' => 'application/pdf',
    ];

    /**
     * @param  null|callable(): bool  $clientGone
     * @return array{bytes: string, contentType: string, fileName: string}
     */
    public static function download(Principal $p, mixed $type, QueryReader $q, ?callable $clientGone = null): array
    {
        if (! is_string($type) || ! in_array($type, self::TYPES, true)) {
            throw Problem::validation(['type' => ['validation.enum']]);
        }
        /** @var array{roles: list<string>, headRoles: list<string>} $access */
        $access = app(Contract::class)->operation('downloadReport')['x-report-access'][$type];
        $full = array_intersect($p->roles, $access['roles']) !== [];
        $head = ! $full && $p->orgAdmin && array_intersect($p->roles, $access['headRoles']) !== [];
        if (! $full && ! $head) {
            throw new Problem(403, ProblemCode::FORBIDDEN);
        }

        $format = $q->enum('format', self::FORMATS);
        if (! $q->has('format')) {
            $q->errors['format'] = ['validation.required'];
        }
        $id = $q->uuid('id');
        $range = ['from' => null, 'to' => null];
        if ($type === 'recall') {
            $q->notAllowed('from');
            $q->notAllowed('to');
            if (! $q->has('id')) {
                $q->errors['id'] = ['validation.required'];
            }
        } else {
            $range = Window::read($q);
            if ($type === 'org') {
                if ($full && ! $q->has('id')) {
                    $q->errors['id'] = ['validation.required'];
                }
                if ($head && $id !== null && $id !== $p->orgId) {
                    $q->errors['id'] = ['validation.id.notAllowed'];
                }
                if ($head) {
                    $id = $p->orgId;
                }
            } else {
                $q->notAllowed('id');
            }
        }
        $q->done();
        $format = (string) $format;
        $maxRows = (int) config('agrotrace.report_max_rows', 50000);

        $ticket = Queue::admit();
        try {
            [$report, $now] = Window::snapshot(function (string $now) use ($type, $range, $id, $head, $maxRows, $p): array {
                $w = Window::resolve($range['from'], $range['to'], Window::dateOf($now));

                return [Sheets::build($type, ['window' => $w, 'id' => $id, 'head' => $head, 'maxRows' => $maxRows], $p), $now];
            });
            SlotHolder::release();
            if ($report === null) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            if ($report->tooManyRows($maxRows)) {
                throw Problem::validation(['type' => ['validation.report.tooManyRows']]);
            }
            $at = (string) Iso::fromPg($now);
            $job = [
                'format' => $format,
                'title' => $report->title,
                'periodLine' => $report->periodLine,
                'generatedLine' => 'Сформирован: '.Sheets::minute($at).' UTC',
                'generatedAt' => $at,
                'fontDir' => $format === 'pdf' ? LabelPdf::fontDir() : null,
                'sheets' => $report->sheets,
            ];
            $bytes = $ticket->render(
                json_encode($job, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
                $clientGone,
            );
        } finally {
            $ticket->release();
        }

        return ['bytes' => $bytes, 'contentType' => self::MIME[$format], 'fileName' => "{$report->fileBase}.{$format}"];
    }
}
