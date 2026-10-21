/**
 * downloadReport (contracts/openapi/paths/reports.yaml; FR-ANL-04, FR-ANL-05). Order: guard (401, x-roles) → `type`
 * (path enum, 400) → access by `x-report-access` (read from the contract): `roles` — the whole system; `headRoles` — an
 * organization head (`is_org_admin`) of such a role, own organization only; neither — 403 FORBIDDEN without params →
 * parameters in one 400 (format required; window as the dashboard's; `recall`: from/to notAllowed, id required;
 * `org`: id required for full access, a head may omit it or pass its own; other types: id notAllowed) → admission
 * (a full render queue → 503 report-busy, before any data is read) → in one READ ONLY REPEATABLE READ snapshot: 404
 * (recall or organization missing/deleted), the contents → more than REPORT_MAX_ROWS data rows in a sheet → 400
 * `errors.type: [validation.report.tooManyRows]` → the file (not stored).
 */
import type { Request } from 'express';
import type { Container } from '../../container.js';
import { operationById } from '../../contract.js';
import { QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import { renderInWorker, reportBusy, reportQueueFull } from './render.js';
import type { Principal } from '../../security/jwt.js';
import { resolveWindow, snapshot, tooLong, type Window } from '../analytics/window.js';
import {
  batchesReport,
  complaintsReport,
  labTestsReport,
  minute,
  orgReport,
  recallReport,
  recallsReport,
  type Report,
} from './sheets.js';

const TYPES = ['batches', 'recalls', 'recall', 'lab-tests', 'complaints', 'org'] as const;
type ReportType = (typeof TYPES)[number];
const FORMATS = ['xlsx', 'pdf'] as const;

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

interface Access {
  roles: string[];
  headRoles: string[];
}

export interface ReportFile {
  bytes: Buffer;
  contentType: string;
  fileName: string;
}

export function reportsService(c: Container) {
  if (!c.contract) throw new Error('reportsService(): the contract is not loaded');
  const access = operationById(c.contract.doc, 'downloadReport')['x-report-access'] as Record<
    ReportType,
    Access
  >;

  return {
    async download(p: Principal, req: Request, signal?: AbortSignal): Promise<ReportFile> {
      const maxRows = c.config.REPORT_MAX_ROWS;
      const type = req.params.type as ReportType;
      if (!(TYPES as readonly string[]).includes(type))
        throw validationProblem({ type: ['validation.enum'] });
      const a = access[type];
      const full = p.roles.some((r) => a.roles.includes(r));
      const head = !full && p.orgAdmin && p.roles.some((r) => a.headRoles.includes(r));
      if (!full && !head) throw new AppProblem(403, 'FORBIDDEN');

      const q = new QueryReader(req.query);
      const format = q.enumOf('format', FORMATS);
      if (!q.has('format')) q.errors.format = ['validation.required'];
      let id = q.uuid('id');
      let range: { from?: string; to?: string } = {};
      if (type === 'recall') {
        q.notAllowed('from');
        q.notAllowed('to');
        if (!q.has('id')) q.errors.id = ['validation.required'];
      } else {
        range = q.dateRange();
        if (!q.errors.from && tooLong(range.from, range.to)) q.errors.from = ['validation.range.tooLong'];
        if (type === 'org') {
          if (full && !q.has('id')) q.errors.id = ['validation.required'];
          if (head && id !== undefined && id !== p.orgId) q.errors.id = ['validation.id.notAllowed'];
          if (head) id = p.orgId;
        } else q.notAllowed('id');
      }
      q.done();
      if (reportQueueFull()) throw reportBusy();

      const { report, at } = await snapshot(c.db, async (tx, now) => {
        const w: Window = resolveWindow(range.from, range.to, now.toISOString().slice(0, 10));
        const headOrg = head ? p.orgId : null;
        let r: Report | undefined;
        if (type === 'batches') r = await batchesReport(tx, w, headOrg, maxRows);
        else if (type === 'recalls') r = await recallsReport(tx, w, maxRows);
        else if (type === 'recall') r = await recallReport(tx, c.fileUrls, id!);
        else if (type === 'lab-tests') r = await labTestsReport(tx, w, headOrg, maxRows);
        else if (type === 'complaints') r = await complaintsReport(tx, w, maxRows);
        else r = await orgReport(tx, w, id!, maxRows);
        if (!r) throw new AppProblem(404, 'NOT_FOUND');
        return { report: r, at: now };
      });
      if (report.sheets.some((s) => s.rows.length > maxRows))
        throw validationProblem({ type: ['validation.report.tooManyRows'] });

      const bytes = await renderInWorker(
        {
          format: format!,
          report: {
            title: report.title,
            periodLine: report.periodLine,
            generatedLine: `Сформирован: ${minute(at)} UTC`,
            generatedAt: at.toISOString(),
            sheets: report.sheets,
          },
        },
        signal,
      );
      return { bytes, contentType: MIME[format!], fileName: `${report.fileBase}.${format}` };
    },
  };
}
