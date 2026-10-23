<?php

namespace App\Events\Handlers;

use App\Domain\Dates;
use App\Events\Claim;
use App\Events\EventHandler;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Mercury\Mercury;
use App\Support\Iso;
use App\Support\Json;
use Closure;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use stdClass;

/**
 * The `vsd.import` handler (R81, contracts/events/vsd.import.schema.json, verbatim; Express documents/vsd-import.ts):
 *
 * 1. The event already claimed (`processed_events`) or the row no longer PENDING — nothing to do (a row other than
 *    PENDING still gets the claim, in an otherwise empty transaction).
 * 2. The query from the batch: productCode = products.mercury_code (NULL → NOT_FOUND without calling Mercury),
 *    senderInn = the origin organization's INN, dateFrom/dateTo = UTC dates of harvested_at ∓ 3 days.
 * 3. Up to 6 calls: a failed call records attempts + 1 and last_error (≤ 500 characters) in its own short transaction
 *    (only while the row is still PENDING) and the next call follows after MERCURY_RETRY_BASE_MS · 2^k (2, 4, 8, 16,
 *    32 s by default).
 * 4. The final state (IMPORTED with the latest CONFIRMED document, NOT_FOUND, FAILED after the 6th failure) in ONE
 *    transaction that starts with the claim, locks the row FOR NO KEY UPDATE and writes only while it is still
 *    PENDING, with the audit row `system.vsdImport` (entityType batchDocument); `updated_at` from the touch trigger.
 *
 * Mercury being down is never a handler failure: the message is acknowledged after FAILED. The batch is never
 * touched. P61 holder rule: no connection is held across the Mercury calls and the pauses between them.
 */
final class VsdImport implements EventHandler
{
    public const MERCURY_CALLS = 6;

    private const LAST_ERROR_MAX = 500;

    private readonly Closure $sleepMs;

    public function __construct(private readonly Mercury $mercury, ?Closure $sleepMs = null, private readonly ?int $retryBaseMs = null)
    {
        $this->sleepMs = $sleepMs ?? function (int $ms): void {
            usleep($ms * 1000);
        };
    }

    public function handle(stdClass $envelope): void
    {
        $eventId = (string) $envelope->id;
        $documentId = (string) ($envelope->data->documentId ?? '');
        if (DB::selectOne('SELECT 1 AS one FROM processed_events WHERE event_id = ?', [$eventId]) !== null) {
            return;
        }
        $src = DB::selectOne('SELECT d.id, d.import_status, p.mercury_code, o.inn, b.harvested_at::text AS harvested_at
              FROM batch_documents d JOIN batches b ON b.id = d.batch_id
              JOIN products p ON p.id = b.product_id JOIN organizations o ON o.id = b.origin_org_id
             WHERE d.id = ?', [$documentId]);
        if ($src === null || $src->import_status !== 'PENDING') {
            Tx::run(fn () => Claim::event($eventId));

            return;
        }
        if ($src->mercury_code === null || $src->harvested_at === null) {
            $this->finish($eventId, $src->id, ['status' => 'NOT_FOUND', 'calls' => 0]);

            return;
        }
        $day = Dates::utcDate((string) Iso::fromPg($src->harvested_at));
        $query = [
            'productCode' => $src->mercury_code,
            'senderInn' => $src->inn,
            'dateFrom' => Dates::addDaysToDate($day, -3),
            'dateTo' => Dates::addDaysToDate($day, 3),
        ];
        $base = $this->retryBaseMs ?? (int) config('agrotrace.mercury.retry_base_ms', 2000);
        for ($call = 1; ; $call++) {
            DB::disconnect();
            $r = $this->mercury->listVsd($query);
            if ($r['ok']) {
                $vsd = Mercury::pick($r['items']);
                $this->finish($eventId, $src->id, $vsd !== null
                    ? ['status' => 'IMPORTED', 'vsd' => $vsd, 'calls' => $call]
                    : ['status' => 'NOT_FOUND', 'calls' => $call]);

                return;
            }
            Log::warning('mercury call failed', ['eventId' => $eventId, 'documentId' => $src->id, 'call' => $call, 'err' => $r['error']]);
            if ($call >= self::MERCURY_CALLS) {
                $this->finish($eventId, $src->id, ['status' => 'FAILED', 'error' => $r['error'], 'calls' => $call]);

                return;
            }
            DB::update("UPDATE batch_documents SET attempts = attempts + 1, last_error = ? WHERE id = ? AND import_status = 'PENDING'",
                [mb_substr($r['error'], 0, self::LAST_ERROR_MAX), $src->id]);
            DB::disconnect();
            ($this->sleepMs)($base * 2 ** ($call - 1));
        }
    }

    /** @param  array{status: string, calls: int, vsd?: stdClass, error?: string}  $outcome */
    private function finish(string $eventId, string $documentId, array $outcome): void
    {
        Tx::run(function () use ($eventId, $documentId, $outcome): void {
            if (! Claim::event($eventId)) {
                return;
            }
            $row = DB::selectOne('SELECT id, import_status, attempts, last_error FROM batch_documents WHERE id = ? FOR NO KEY UPDATE', [$documentId]);
            if ($row === null || $row->import_status !== 'PENDING') {
                return;
            }
            // The calls before the last one were counted by the failure updates; the last one is counted here.
            $attempts = (int) $row->attempts + ($outcome['calls'] > 0 ? 1 : 0);
            $vsd = $outcome['vsd'] ?? null;
            $lastError = $outcome['status'] === 'FAILED' ? mb_substr((string) $outcome['error'], 0, self::LAST_ERROR_MAX) : null;
            if ($vsd !== null) {
                DB::update("UPDATE batch_documents SET import_status = 'IMPORTED', external_uuid = ?, number = ?, issue_date = ?::date,
                        vsd_status = ?, payload = ?::jsonb, attempts = ?, last_error = NULL WHERE id = ?",
                    [$vsd->uuid, $vsd->number, $vsd->issueDate, $vsd->status, Json::encode($vsd), $attempts, $documentId]);
            } else {
                DB::update('UPDATE batch_documents SET import_status = ?, attempts = ?, last_error = ? WHERE id = ?',
                    [$outcome['status'], $attempts, $lastError, $documentId]);
            }
            AuditLog::write(null, 'system.vsdImport', 'batchDocument', $documentId, AuditLog::diff(
                ['importStatus' => $row->import_status, 'attempts' => (int) $row->attempts, 'lastError' => $row->last_error,
                    'externalUuid' => null, 'number' => null, 'issueDate' => null, 'vsdStatus' => null],
                ['importStatus' => $outcome['status'], 'attempts' => $attempts, 'lastError' => $lastError,
                    'externalUuid' => $vsd?->uuid, 'number' => $vsd?->number, 'issueDate' => $vsd?->issueDate, 'vsdStatus' => $vsd?->status],
            ));
        });
    }
}
