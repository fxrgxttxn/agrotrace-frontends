<?php

namespace App\Actions\Documents;

use App\Actions\Batches\BatchesActions;
use App\Actions\Batches\BatchView;
use App\Actions\Batches\QrActions;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Files\Files;
use App\Infrastructure\Outbox\Outbox;
use App\Infrastructure\Qr\Qr;
use App\Security\FileUrls;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\Json;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * Batch documents (R81, R91; getBatchDocuments, retryBatchVsdImport; Express documents/service.ts): the VSD of ФГИС
 * «Меркурий» (the `batch_documents` row of kind VSD), the protocols of the batch's lab tests the caller may see, and
 * the QR links when the caller may download the QR. The import itself runs in the worker (Events\Handlers\VsdImport).
 */
final class DocumentsActions
{
    /** contracts/rules/entity-state-machines.json `vsdImport`: retryBatchVsdImport restarts only these. */
    private const RETRYABLE = ['NOT_FOUND', 'FAILED'];

    private const VSD_COLUMNS = 'id, import_status, external_uuid, number, issue_date::text AS issue_date, vsd_status,
        payload::text AS payload, attempts, last_error, created_at::text AS created_at, updated_at::text AS updated_at';

    /** @return array<string, mixed> the contract's BatchVsd */
    public static function vsdView(stdClass $d): array
    {
        $payload = $d->payload !== null ? Json::decode($d->payload) : null;
        $document = null;
        if ($d->import_status === 'IMPORTED' && $payload instanceof stdClass) {
            $document = [
                'externalUuid' => $d->external_uuid,
                'number' => $d->number,
                'issueDate' => $d->issue_date,
                'status' => $d->vsd_status,
                'productName' => $payload->product->name ?? '',
                'volume' => $payload->volume ?? ['value' => 0, 'unit' => ''],
                'consignor' => $payload->consignor ?? ['inn' => '', 'name' => ''],
                'consignee' => $payload->consignee ?? ['inn' => '', 'name' => ''],
            ];
        }

        return [
            'id' => $d->id,
            'importStatus' => $d->import_status,
            'document' => $document,
            'attempts' => (int) $d->attempts,
            'requestedAt' => Iso::fromPg($d->created_at),
            'updatedAt' => Iso::fromPg($d->updated_at),
        ];
    }

    /**
     * getBatchDocuments — visibility as getBatch; contents filtered by the caller's rights (R91, roles united):
     * protocols — INSPECTOR/ADMIN and participants every test of the visible batch, LAB its own laboratory's; `qr` —
     * only when the caller may download it (downloadBatchQr's checks), and only while both files are live.
     *
     * @return array<string, mixed>
     */
    public static function get(Principal $p, string $batchId): array
    {
        $b = BatchesActions::visibleBatch($p, $batchId);
        $vsd = DB::selectOne('SELECT '.self::VSD_COLUMNS." FROM batch_documents WHERE batch_id = ? AND kind = 'VSD'", [$batchId]);

        $own = ! $p->seesAll() && ! $p->isParticipant();
        $protocols = DB::select('SELECT t.id, t.reason, t.conclusion, t.completed_at::text AS completed_at,
                l.id AS lab_id, l.name AS lab_name, l.type AS lab_type, l.logo_file_id AS lab_logo,
                f.id AS file_id, f.kind AS file_kind, f.mime, f.size_bytes, f.original_name
              FROM lab_tests t JOIN files f ON f.id = t.protocol_file_id JOIN organizations l ON l.id = t.lab_org_id
             WHERE t.batch_id = ? AND t.deleted_at IS NULL AND f.deleted_at IS NULL'.($own ? ' AND t.lab_org_id = ?' : '').'
             ORDER BY t.created_at, t.id', $own ? [$batchId, $p->orgId] : [$batchId]);

        $qr = null;
        $mayQr = ($p->hasRole('PROCESSOR') || $p->hasRole('RETAILER')) && QrActions::denied($p, $b) === null;
        if ($mayQr && $b->qr_png_file_id !== null && $b->qr_pdf_file_id !== null) {
            $live = DB::select('SELECT id FROM files WHERE id IN (?, ?) AND deleted_at IS NULL', [$b->qr_png_file_id, $b->qr_pdf_file_id]);
            if (count($live) === 2) {
                $qr = [
                    'publicUrl' => Qr::publicPageUrl((string) config('agrotrace.public_base_url'), $b->public_code),
                    'pngUrl' => FileUrls::signed($b->qr_png_file_id),
                    'pdfUrl' => FileUrls::signed($b->qr_pdf_file_id),
                ];
            }
        }

        return [
            'batchId' => $b->id,
            'vsd' => $vsd !== null ? self::vsdView($vsd) : null,
            'labProtocols' => array_map(fn ($t) => [
                'labTestId' => $t->id,
                'lab' => BatchView::orgRef($t->lab_id, $t->lab_name, $t->lab_type, $t->lab_logo),
                'reason' => $t->reason,
                'conclusion' => $t->conclusion,
                'completedAt' => Iso::fromPg($t->completed_at),
                'file' => Files::ref($t->file_id, $t->file_kind, $t->mime, $t->size_bytes, $t->original_name),
            ], $protocols),
            'qr' => $qr,
        ];
    }

    /**
     * retryBatchVsdImport — locks: the batch, then its VSD row (R52 "other rows"); 404 → 403 NOT_HOLDER → 404 no VSD →
     * 409 INVALID_TRANSITION {from, to: PENDING} unless NOT_FOUND/FAILED. The row back to PENDING (attempts 0, no
     * error), audit, `vsd.import` in the outbox. (Idempotency-Key: the middleware of Task 7.)
     *
     * @return array<string, mixed>
     */
    public static function retry(Principal $p, string $batchId): array
    {
        return Tx::run(function () use ($p, $batchId): array {
            $b = BatchesActions::visibleBatch($p, $batchId, true);
            if ($b->holder_org_id !== $p->orgId) {
                throw BatchesActions::notHolder();
            }
            $doc = DB::selectOne('SELECT '.self::VSD_COLUMNS." FROM batch_documents WHERE batch_id = ? AND kind = 'VSD' FOR NO KEY UPDATE", [$batchId]);
            if ($doc === null) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            if (! in_array($doc->import_status, self::RETRYABLE, true)) {
                throw BatchesActions::invalidTransition(['from' => $doc->import_status, 'to' => 'PENDING']);
            }
            $updated = DB::selectOne("UPDATE batch_documents SET import_status = 'PENDING', attempts = 0, last_error = NULL
                 WHERE id = ? RETURNING ".self::VSD_COLUMNS, [$doc->id]);
            AuditLog::write($p->userId, 'retryBatchVsdImport', 'batchDocument', $doc->id, AuditLog::diff(
                ['importStatus' => $doc->import_status, 'attempts' => (int) $doc->attempts, 'lastError' => $doc->last_error],
                ['importStatus' => 'PENDING', 'attempts' => 0, 'lastError' => null],
            ));
            Outbox::enqueue('vsd.import', ['documentId' => $doc->id, 'batchId' => $batchId, 'publicCode' => $b->public_code]);

            return self::vsdView($updated);
        });
    }
}
