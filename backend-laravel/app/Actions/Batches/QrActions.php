<?php

namespace App\Actions\Batches;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Files\Files;
use App\Infrastructure\Files\PreparedFile;
use App\Infrastructure\Pdf\LabelPdf;
use App\Infrastructure\Qr\Qr;
use App\Infrastructure\Qr\RenderLane;
use App\Infrastructure\Storage\ObjectStore;
use App\Security\FileUrls;
use App\Security\Principal;
use App\Support\Iso;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use stdClass;
use Symfony\Component\HttpFoundation\Response;

/**
 * Batch QR (createBatchQr, downloadBatchQr; FR-PROD-08, R43, R44, Ruling Q1; Express batches/qr.ts). Who may: role
 * PROCESSOR or RETAILER (x-roles), the organization holds the batch (403 NOT_HOLDER), and the status allows it —
 * Accepted or OnSale, or Approved for a DERIVED batch the PROCESSOR's organization both originates and holds (403
 * BATCH_STATUS {status}).
 *
 * Generation renders the PNG (QR of `{PUBLIC_BASE_URL}/p/{publicCode}`) and the A6 PDF label behind the bounded
 * RenderLane, stores both as files of kind QR (`{publicCode}.png` / `.pdf`) and points the batch at them; the previous
 * QR files are soft-deleted (their URLs answer 404). `qrGeneratedAt` = the transaction's now; the batch version does
 * not change. Rendering and the MinIO upload happen before the transaction with no DB slot held (P8, P61); the checks
 * run again over the locked row (R47).
 */
final class QrActions
{
    /** null — the caller may create/download the QR of this (visible) batch; otherwise the 403. */
    public static function denied(Principal $p, stdClass $b): ?Problem
    {
        if ($b->holder_org_id !== $p->orgId) {
            return BatchesActions::notHolder();
        }
        $allowed = $b->status === 'Accepted' || $b->status === 'OnSale'
            || ($b->status === 'Approved' && $b->kind === 'DERIVED' && $b->origin_org_id === $p->orgId && $p->hasRole('PROCESSOR'));

        return $allowed ? null : new Problem(403, ProblemCode::FORBIDDEN, title: 'Batch status does not allow QR',
            params: ['reason' => 'BATCH_STATUS', 'status' => $b->status]);
    }

    /** @return array{publicUrl: string, pngUrl: string, pdfUrl: string} */
    public static function create(Principal $p, string $id): array
    {
        $pre = BatchesActions::visibleBatch($p, $id);
        if (($d = self::denied($p, $pre)) !== null) {
            throw $d;
        }
        $names = DB::selectOne('SELECT pr.name AS product_name, (SELECT o.name FROM organizations o WHERE o.id = ?) AS origin_name
              FROM products pr WHERE pr.id = ?', [$pre->origin_org_id, $pre->product_id]);
        $url = Qr::publicPageUrl((string) config('agrotrace.public_base_url'), $pre->public_code);
        $createdAt = time();
        SlotHolder::release();
        [$png, $pdf] = RenderLane::with(function () use ($url, $pre, $names, $createdAt): array {
            $png = Qr::png($url);

            return [$png, LabelPdf::qrLabel($pre->public_code, $names->product_name, $names->origin_name ?? '', $png, $createdAt)];
        });
        $pngFile = self::file($p->userId, "{$pre->public_code}.png", 'image/png', $png, $createdAt);
        $pdfFile = self::file($p->userId, "{$pre->public_code}.pdf", 'application/pdf', $pdf, $createdAt);
        Files::store($pngFile);
        Files::store($pdfFile);

        Tx::run(function () use ($p, $id, $pngFile, $pdfFile): void {
            $b = BatchesActions::visibleBatch($p, $id, true);
            if (($d = self::denied($p, $b)) !== null) {
                throw $d;
            }
            Files::insert($pngFile);
            Files::insert($pdfFile);
            $now = Tx::now();
            DB::update('UPDATE batches SET qr_png_file_id = ?, qr_pdf_file_id = ?, qr_generated_at = ?::timestamptz WHERE id = ?',
                [$pngFile->id(), $pdfFile->id(), $now, $id]);
            foreach ([$pngFile, $pdfFile] as $f) {
                AuditLog::write($p->userId, 'createBatchQr', 'file', $f->id(), AuditLog::diff(null, Files::auditView($f)));
            }
            AuditLog::write($p->userId, 'createBatchQr', 'batch', $id, AuditLog::diff(
                ['qrPngFileId' => $b->qr_png_file_id, 'qrPdfFileId' => $b->qr_pdf_file_id, 'qrGeneratedAt' => Iso::fromPg($b->qr_generated_at)],
                ['qrPngFileId' => $pngFile->id(), 'qrPdfFileId' => $pdfFile->id(), 'qrGeneratedAt' => Iso::fromPg($now)],
            ));
            foreach ([$b->qr_png_file_id, $b->qr_pdf_file_id] as $old) {
                if (Files::softDelete($old, $now)) {
                    AuditLog::write($p->userId, 'createBatchQr', 'file', $old, ['deletedAt' => [null, Iso::fromPg($now)]]);
                }
            }
        });

        return ['publicUrl' => $url, 'pngUrl' => FileUrls::signed($pngFile->id()), 'pdfUrl' => FileUrls::signed($pdfFile->id())];
    }

    /** downloadBatchQr: checks 1–3 as createBatchQr, then no QR yet → 404; the stored bytes (ETag = their sha256). */
    public static function download(Request $request, Principal $p, string $id, string $format): Response
    {
        $b = BatchesActions::visibleBatch($p, $id);
        if (($d = self::denied($p, $b)) !== null) {
            throw $d;
        }
        $fileId = $format === 'png' ? $b->qr_png_file_id : $b->qr_pdf_file_id;
        $file = $fileId !== null ? Files::live($fileId) : null;
        if ($file === null) {
            throw new Problem(404, ProblemCode::NOT_FOUND, title: 'QR not generated');
        }

        return Files::send($request, $file, 480, Files::CACHE_PRIVATE, "inline; filename=\"{$b->public_code}.{$format}\"");
    }

    private static function file(string $ownerId, string $name, string $mime, string $bytes, int $createdAt): PreparedFile
    {
        $id = (string) Str::uuid();
        $key = 'qr/'.gmdate('Y/m', $createdAt)."/{$id}/original";

        return new PreparedFile([
            'id' => $id,
            'bucket' => app(ObjectStore::class)->bucket(),
            'object_key' => $key,
            'original_name' => $name,
            'mime' => $mime,
            'size_bytes' => strlen($bytes),
            'sha256' => hash('sha256', $bytes),
            'variants' => new stdClass,
            'kind' => 'QR',
            'owner_id' => $ownerId,
        ], [['key' => $key, 'bytes' => $bytes, 'mime' => $mime]]);
    }
}
