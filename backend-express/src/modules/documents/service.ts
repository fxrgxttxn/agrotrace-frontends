/**
 * Batch documents (R81, R91; getBatchDocuments, retryBatchVsdImport): the VSD of ФГИС «Меркурий» (the
 * `batch_documents` row of kind VSD), the protocols of the batch's lab tests the caller may see, and the QR links when
 * the caller may download the QR. The VSD import itself runs in the worker (vsd-import.ts).
 */
import type { Kysely, Transaction } from 'kysely';
import type { Container } from '../../container.js';
import { withTx } from '../../db/tx.js';
import type { DB } from '../../db/types.generated.js';
import { AppProblem } from '../../http/problem.js';
import { enqueue } from '../../infra/outbox.js';
import { publicPageUrl } from '../../infra/qr.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { qrDenied } from '../batches/qr.js';
import { invalidTransition, notHolder, type BatchesService } from '../batches/service.js';
import { iso, orgRef } from '../batches/view.js';
import { isParticipant, seesAll } from '../batches/visibility.js';
import { fileRef } from '../files/service.js';

type Q = Kysely<DB> | Transaction<DB>;

/** contracts/rules/entity-state-machines.json `vsdImport`: retryBatchVsdImport restarts only these. */
const RETRYABLE = ['NOT_FOUND', 'FAILED'];

interface VsdPayload {
  product?: { name?: string };
  volume?: { value: number; unit: string };
  consignor?: { inn: string; name: string };
  consignee?: { inn: string; name: string };
}

type DocRow = {
  id: string;
  import_status: string;
  external_uuid: string | null;
  number: string | null;
  issue_date: string | null;
  vsd_status: string | null;
  payload: unknown;
  attempts: number;
  created_at: unknown;
  updated_at: unknown;
};

export function vsdView(d: DocRow) {
  const payload = (typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload) as VsdPayload | null;
  return {
    id: d.id,
    importStatus: d.import_status,
    document:
      d.import_status === 'IMPORTED' && payload
        ? {
            externalUuid: d.external_uuid,
            number: d.number,
            issueDate: d.issue_date,
            status: d.vsd_status,
            productName: payload.product?.name ?? '',
            volume: payload.volume ?? { value: 0, unit: '' },
            consignor: payload.consignor ?? { inn: '', name: '' },
            consignee: payload.consignee ?? { inn: '', name: '' },
          }
        : null,
    attempts: d.attempts,
    requestedAt: iso(d.created_at),
    updatedAt: iso(d.updated_at),
  };
}

function vsdRow(q: Q, batchId: string) {
  return q
    .selectFrom('batch_documents')
    .select([
      'id',
      'import_status',
      'external_uuid',
      'number',
      'issue_date',
      'vsd_status',
      'payload',
      'attempts',
      'last_error',
      'created_at',
      'updated_at',
    ])
    .where('batch_id', '=', batchId)
    .where('kind', '=', 'VSD');
}

export function documentsService(c: Container, batches: BatchesService) {
  const { db } = c;

  return {
    /** getBatchDocuments — visibility as getBatch; contents filtered by the caller's rights (R91). */
    async get(p: Principal, batchId: string) {
      const b = await batches.visibleBatch(db, p, batchId);
      const vsd = await vsdRow(db, batchId).executeTakeFirst();

      let tests = db
        .selectFrom('lab_tests as t')
        .innerJoin('files as f', 'f.id', 't.protocol_file_id')
        .innerJoin('organizations as l', 'l.id', 't.lab_org_id')
        .select([
          't.id',
          't.reason',
          't.conclusion',
          't.completed_at',
          'l.id as lab_id',
          'l.name as lab_name',
          'l.type as lab_type',
          'l.logo_file_id as lab_logo',
          'f.id as file_id',
          'f.kind as file_kind',
          'f.mime',
          'f.size_bytes',
          'f.original_name',
        ])
        .where('t.batch_id', '=', batchId)
        .where('t.deleted_at', 'is', null)
        .where('f.deleted_at', 'is', null);
      // Lab tag visibility: INSPECTOR/ADMIN all; participants all tests of a visible batch; LAB its own lab's.
      if (!seesAll(p) && !isParticipant(p)) tests = tests.where('t.lab_org_id', '=', p.orgId);
      const protocols = await tests.orderBy('t.created_at').orderBy('t.id').execute();

      const mayQr = p.roles.some((r) => r === 'PROCESSOR' || r === 'RETAILER') && qrDenied(p, b) === null;
      let qr = null;
      if (mayQr && b.qr_png_file_id && b.qr_pdf_file_id) {
        const live = await db
          .selectFrom('files')
          .select('id')
          .where('id', 'in', [b.qr_png_file_id, b.qr_pdf_file_id])
          .where('deleted_at', 'is', null)
          .execute();
        if (live.length === 2)
          qr = {
            publicUrl: publicPageUrl(c.config.PUBLIC_BASE_URL, b.public_code),
            pngUrl: c.fileUrls.signed(b.qr_png_file_id),
            pdfUrl: c.fileUrls.signed(b.qr_pdf_file_id),
          };
      }
      return {
        batchId: b.id,
        vsd: vsd ? vsdView(vsd) : null,
        labProtocols: protocols.map((t) => ({
          labTestId: t.id,
          lab: orgRef(t.lab_id, t.lab_name, t.lab_type, t.lab_logo),
          reason: t.reason,
          conclusion: t.conclusion,
          completedAt: t.completed_at ? iso(t.completed_at) : null,
          file: fileRef(c.fileUrls, {
            id: t.file_id,
            kind: t.file_kind,
            mime: t.mime,
            size_bytes: t.size_bytes,
            original_name: t.original_name,
          }),
        })),
        qr,
      };
    },

    /**
     * retryBatchVsdImport — locks: the batch, then its VSD row (R52 "other rows"); 404 → 403 NOT_HOLDER → 404 no VSD →
     * 409 INVALID_TRANSITION {from, to: PENDING} unless NOT_FOUND/FAILED. The row back to PENDING (attempts 0, no
     * error), audit, `vsd.import` in the outbox.
     */
    async retry(p: Principal, batchId: string) {
      const { view, eventId } = await withTx(db, async (tx) => {
        const b = await batches.visibleBatch(tx, p, batchId, true);
        if (b.holder_org_id !== p.orgId) throw notHolder();
        const doc = await vsdRow(tx, batchId).forNoKeyUpdate().executeTakeFirst();
        if (!doc) throw new AppProblem(404, 'NOT_FOUND');
        if (!RETRYABLE.includes(doc.import_status))
          throw invalidTransition({ from: doc.import_status, to: 'PENDING' });
        const updated = await tx
          .updateTable('batch_documents')
          .set({ import_status: 'PENDING', attempts: 0, last_error: null })
          .where('id', '=', doc.id)
          .returning([
            'id',
            'import_status',
            'external_uuid',
            'number',
            'issue_date',
            'vsd_status',
            'payload',
            'attempts',
            'created_at',
            'updated_at',
          ])
          .executeTakeFirstOrThrow();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'retryBatchVsdImport',
          entityType: 'batchDocument',
          entityId: doc.id,
          diff: auditDiff(
            { importStatus: doc.import_status, attempts: doc.attempts, lastError: doc.last_error },
            { importStatus: 'PENDING', attempts: 0, lastError: null },
          ),
        });
        const ev = await enqueue(tx, {
          type: 'vsd.import',
          payload: { documentId: doc.id, batchId, publicCode: b.public_code },
        });
        return { view: vsdView(updated), eventId: ev.id };
      });
      await c.relay.publish([eventId]);
      return view;
    },
  };
}
