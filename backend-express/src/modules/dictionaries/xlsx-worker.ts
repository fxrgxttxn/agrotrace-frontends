/**
 * Worker-thread entry of the XLSX import reader (P24): xlsx-read.ts runs here, off the API's event loop, under the
 * heap limit set by the parent; the parent's queue terminates the worker at the deadline (infra/worker-queue.ts).
 * Once its modules are loaded and warm it posts `{ready: true}`. Messages: `{id, input}` (the file bytes) →
 * `{id, result}` (XlsxResult).
 */
import { parentPort } from 'node:worker_threads';
import { readWorkbook } from './xlsx-read.js';

await readWorkbook(Buffer.alloc(0)); // loads exceljs and the scanner before the first job
parentPort!.postMessage({ ready: true });

parentPort!.on('message', (msg: { id: number; input: Uint8Array }) => {
  const bytes = Buffer.from(msg.input.buffer, msg.input.byteOffset, msg.input.byteLength);
  void readWorkbook(bytes).then((result) => parentPort!.postMessage({ id: msg.id, result }));
});
