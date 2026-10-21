<?php

namespace App\Actions\Files;

use App\Queries\Visibility;
use App\Security\Principal;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * Bearer access to a file (downloadFile, п. 4.2: files inherit the rights of the entity they belong to; Express
 * modules/files/access.ts). A file the principal may not read is indistinguishable from a missing one (404).
 * - AVATAR — any authenticated user; LOGO, PRODUCT_IMAGE — everybody;
 * - LAB_PROTOCOL — whoever sees the lab test: INSPECTOR/ADMIN all, LAB its own laboratory's, participants the tests
 *   of the batches they see;
 * - QR — whoever sees the batch; REPORT — only its owner.
 */
final class FileAccess
{
    public static function canRead(Principal $p, stdClass $f): bool
    {
        switch ($f->kind) {
            case 'AVATAR':
            case 'LOGO':
            case 'PRODUCT_IMAGE':
                return true;
            case 'REPORT':
                return $f->owner_id === $p->userId;
            case 'LAB_PROTOCOL':
                if ($p->seesAll()) {
                    return true;
                }
                $own = $p->hasRole('LAB');
                [$via, $viaBindings] = $p->isParticipant()
                    ? Visibility::batchVisibleTo(new Principal($p->userId, $p->orgId, array_values(array_filter($p->roles, fn ($r) => $r !== 'LAB')), $p->orgAdmin), 'b.id')
                    : ['false', []];
                $row = DB::selectOne(
                    "SELECT EXISTS (SELECT 1 FROM lab_tests t JOIN batches b ON b.id = t.batch_id
                       WHERE t.protocol_file_id = ? AND t.deleted_at IS NULL AND b.deleted_at IS NULL
                         AND ((?::boolean AND t.lab_org_id = ?) OR {$via})) AS ok",
                    [$f->id, $own, $p->orgId, ...$viaBindings],
                );

                return $row !== null && $row->ok === true;
            case 'QR':
                [$visible, $bindings] = Visibility::batchVisibleTo($p, 'b.id');
                $row = DB::selectOne(
                    "SELECT EXISTS (SELECT 1 FROM batches b WHERE (b.qr_png_file_id = ? OR b.qr_pdf_file_id = ?)
                       AND b.deleted_at IS NULL AND {$visible}) AS ok",
                    [$f->id, $f->id, ...$bindings],
                );

                return $row !== null && $row->ok === true;
            default:
                return false;
        }
    }
}
