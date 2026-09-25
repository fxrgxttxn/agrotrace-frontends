import { Worker } from 'node:worker_threads';
const t = Date.now();
const w = new Worker(new URL('./src/infra/svg-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
w.on('error', (e) => console.log('error', e));
w.on('exit', (c) => console.log('exit', c));
w.on('message', (m) => { console.log('msg', Date.now() - t, m); w.terminate(); });
w.postMessage({ id: 1, text: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
