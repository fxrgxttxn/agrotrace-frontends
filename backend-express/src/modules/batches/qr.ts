/**
 * Batch QR (createBatchQr, downloadBatchQr; FR-PROD-08, R43, R44). Who may: role PROCESSOR or RETAILER (x-roles),
 * the organization holds the batch (403 NOT_HOLDER), and the status allows it — Accepted or OnSale, or Approved for a
 * DERIVED batch the PROCESSOR's organization both originates and holds (403 BATCH_STATUS {status}).
 *
 * Generation renders the PNG (QR of `{PUBLIC_BASE_URL}/p/{publicCode}`) and the A6 PDF label, stores both as files of
 * kind QR (`{publicCode}.png` / `.pdf`) and points the batch at them; the previous QR files are soft-deleted (their
 * URLs answer 404). `qrGeneratedAt` = now; the batch version does not change. Rendering and the MinIO upload happen
 * before the transaction (withTx must stay DB-only, P8); the checks run again over the locked row (R47).
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Container } from '../../container.js';
import { withTx } from '../../db/tx.js';
import { AppProblem } from '../../http/problem.js';
import { sha256hex } from '../../infra/images.js';
import { qrLabelPdf } from '../../infra/pdf.js';
import { publicPageUrl, qrPng } from '../../infra/qr.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { CACHE_PRIVATE, sendFile } from '../files/download.js';
import {
  fileAuditView,
  insertFile,
  objectKey,
  softDeleteFile,
  storeObjects,
  type PreparedFile,
} from '../files/service.js';
import type { BatchesService } from './service.js';
import { notHolder } from './service.js';

/** null — the caller may create/download the QR of this (visible) batch; otherwise the 403. */
export function qrDenied(
  p: Principal,
  b: { holder_org_id: string | null; origin_org_id: string; status: string; kind: string },
): AppProblem | null {
  if (b.holder_org_id !== p.orgId) return notHolder();
  const allowed =
    b.status === 'Accepted' ||
    b.status === 'OnSale' ||
    (b.status === 'Approved' &&
      b.kind === 'DERIVED' &&
      b.origin_org_id === p.orgId &&
      p.roles.includes('PROCESSOR'));
  if (allowed) return null;
  return new AppProblem(403, 'FORBIDDEN', {
    title: 'Batch status does not allow QR',
    params: { reason: 'BATCH_STATUS', status: b.status },
  });
}

export interface QrLinks {
  publicUrl: string;
  pngUrl: string;
  pdfUrl: string;
}

function qrFile(
  bucket: string,
  ownerId: string,
  name: string,
  mime: string,
  body: Buffer,
  createdAt: Date,
): PreparedFile {
  const id = randomUUID();
  const key = objectKey('QR', id, createdAt, 'original');
  return {
    row: {
      id,
      bucket,
      object_key: key,
      original_name: name,
      mime,
      size_bytes: body.length,
      sha256: sha256hex(body),
      variants: JSON.stringify({}),
      kind: 'QR',
      owner_id: ownerId,
      created_at: createdAt,
    },
    objects: [{ key, body, contentType: mime }],
  };
}

export function qrService(c: Container, batches: BatchesService) {
  const { db } = c;

  return {
    async create(p: Principal, id: string): Promise<QrLinks> {
      const pre = await batches.visibleBatch(db, p, id);
      const denied = qrDenied(p, pre);
      if (denied) throw denied;
      const names = await db
        .selectFrom('products as pr')
        .select([
          'pr.name as product_name',
          (eb) =>
            eb
              .selectFrom('organizations as o')
              .select('o.name')
              .where('o.id', '=', pre.origin_org_id)
              .as('origin_name'),
        ])
        .where('pr.id', '=', pre.product_id)
        .executeTakeFirstOrThrow();
      const url = publicPageUrl(c.config.PUBLIC_BASE_URL, pre.public_code);
      const createdAt = new Date();
      const png = await qrPng(url);
      const pdf = await qrLabelPdf({
        publicCode: pre.public_code,
        productName: names.product_name,
        originName: names.origin_name ?? '',
        png,
        createdAt,
      });
      const pngFile = qrFile(c.s3.bucket, p.userId, `${pre.public_code}.png`, 'image/png', png, createdAt);
      const pdfFile = qrFile(
        c.s3.bucket,
        p.userId,
        `${pre.public_code}.pdf`,
        'application/pdf',
        pdf,
        createdAt,
      );
      await Promise.all([storeObjects(c.s3, pngFile), storeObjects(c.s3, pdfFile)]);

      await withTx(db, async (tx) => {
        const b = await batches.visibleBatch(tx, p, id, true);
        const again = qrDenied(p, b);
        if (again) throw again;
        await insertFile(tx, pngFile);
        await insertFile(tx, pdfFile);
        const now = new Date();
        const updated = await tx
          .updateTable('batches')
          .set({ qr_png_file_id: pngFile.row.id, qr_pdf_file_id: pdfFile.row.id, qr_generated_at: now })
          .where('id', '=', id)
          .returning(['qr_generated_at'])
          .executeTakeFirstOrThrow();
        for (const f of [pngFile, pdfFile])
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'createBatchQr',
            entityType: 'file',
            entityId: f.row.id,
            diff: auditDiff(null, fileAuditView(f.row)),
          });
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'createBatchQr',
          entityType: 'batch',
          entityId: id,
          diff: auditDiff(
            {
              qrPngFileId: b.qr_png_file_id,
              qrPdfFileId: b.qr_pdf_file_id,
              qrGeneratedAt: b.qr_generated_at ? new Date(b.qr_generated_at).toISOString() : null,
            },
            {
              qrPngFileId: pngFile.row.id,
              qrPdfFileId: pdfFile.row.id,
              qrGeneratedAt: new Date(updated.qr_generated_at!).toISOString(),
            },
          ),
        });
        for (const old of [b.qr_png_file_id, b.qr_pdf_file_id])
          if (await softDeleteFile(tx, old, now))
            await auditService.record(tx, {
              actorId: p.userId,
              action: 'createBatchQr',
              entityType: 'file',
              entityId: old,
              diff: { deletedAt: [null, now.toISOString()] },
            });
      });
      return {
        publicUrl: url,
        pngUrl: c.fileUrls.signed(pngFile.row.id),
        pdfUrl: c.fileUrls.signed(pdfFile.row.id),
      };
    },

    /** downloadBatchQr: checks 1–3 as createBatchQr, then no QR yet → 404; the stored bytes (ETag = their sha256). */
    async download(
      req: Request,
      res: Response,
      p: Principal,
      id: string,
      format: 'png' | 'pdf',
    ): Promise<void> {
      const b = await batches.visibleBatch(db, p, id);
      const denied = qrDenied(p, b);
      if (denied) throw denied;
      const fileId = format === 'png' ? b.qr_png_file_id : b.qr_pdf_file_id;
      const file = fileId
        ? await db
            .selectFrom('files')
            .selectAll()
            .where('id', '=', fileId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst()
        : undefined;
      if (!file) throw new AppProblem(404, 'NOT_FOUND', { title: 'QR not generated' });
      await sendFile(c, req, res, file, 480, CACHE_PRIVATE, `inline; filename="${b.public_code}.${format}"`);
    },
  };
}
