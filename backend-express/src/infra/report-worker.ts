/**
 * Worker-thread entry of report rendering (downloadReport, P52): XLSX (infra/xlsx.ts) and PDF (infra/pdf.ts) are
 * produced here, off the API's event loop, under the heap limit set by the parent; the parent's queue terminates the
 * worker at the deadline (infra/worker-queue.ts). Once warm it posts `{ready: true}`. Messages: `{id, input}` (a
 * RenderJob) → `{id, result}` where `result` is ONE transferred ArrayBuffer with the file, or null when rendering
 * failed.
 */
import { parentPort } from 'node:worker_threads';
import { renderReport, type RenderJob } from './report-render.js';

// Loads exceljs, pdfkit and the fonts before the first job.
await renderReport({
  format: 'pdf',
  report: {
    title: 'warm-up',
    periodLine: '',
    generatedLine: '',
    generatedAt: new Date(0).toISOString(),
    sheets: [],
  },
});
await renderReport({
  format: 'xlsx',
  report: {
    title: 'warm-up',
    periodLine: '',
    generatedLine: '',
    generatedAt: new Date(0).toISOString(),
    sheets: [],
  },
});
parentPort!.postMessage({ ready: true });

parentPort!.on('message', (msg: { id: number; input: RenderJob }) => {
  void renderReport(msg.input).then(
    (bytes) => {
      const result = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      parentPort!.postMessage({ id: msg.id, result }, [result]);
    },
    () => parentPort!.postMessage({ id: msg.id, result: null }),
  );
});
