/**
 * Worker-thread entry of the XLSX import reader (P24, P25): xlsx-read.ts runs here, off the API's event loop, under the
 * heap limit set by the parent; the parent's queue terminates the worker at the deadline (infra/worker-queue.ts).
 * Once its modules are loaded and warm it posts `{ready: true}`. Messages: `{id, input}` (the file bytes) →
 * `{id, result}` where `result` is ONE transferred ArrayBuffer holding the JSON of the (bounded) XlsxResult — the
 * API thread never receives a cloned object graph whose size the workbook could multiply.
 */
import { parentPort } from 'node:worker_threads';
import { encodeResult, readWorkbook } from './xlsx-read.js';

await readWorkbook(Buffer.alloc(0)); // loads exceljs and the scanner before the first job
parentPort!.postMessage({ ready: true });

parentPort!.on('message', (msg: { id: number; input: Uint8Array }) => {
  const bytes = Buffer.from(msg.input.buffer, msg.input.byteOffset, msg.input.byteLength);
  void readWorkbook(bytes).then((r) => {
    const result = encodeResult(r);
    parentPort!.postMessage({ id: msg.id, result }, [result]);
  });
});
