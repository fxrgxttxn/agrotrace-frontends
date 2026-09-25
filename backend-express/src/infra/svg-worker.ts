/**
 * Worker-thread entry of the SVG sanitizer (P15): jsdom + DOMPurify run here, off the API's event loop; the parent
 * (svg.ts) terminates the worker when a job exceeds its time budget. Once its modules are loaded and warm it posts
 * `{ready: true}` (the budget of a job never includes the worker's start-up). Messages: `{id, text}` → `{id, result}`,
 * `result` = the sanitized document or null.
 */
import { parentPort } from 'node:worker_threads';
import { sanitizeSvgText } from './svg-sanitize.js';

sanitizeSvgText('<svg xmlns="http://www.w3.org/2000/svg"/>');
parentPort!.postMessage({ ready: true });

parentPort!.on('message', (msg: { id: number; text: string }) => {
  let result: string | null;
  try {
    result = sanitizeSvgText(msg.text);
  } catch {
    result = null;
  }
  parentPort!.postMessage({ id: msg.id, result });
});
