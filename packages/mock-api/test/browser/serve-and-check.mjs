// Serves the built check page on http://localhost:8092 (a secure context: service workers work) and drives Chromium.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = await import(process.argv[4] ?? 'playwright');

const dir = process.argv[2];
const shots = process.argv[3];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(dir, file));
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(8092, r));
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const probe = await fetch('http://localhost:8092/');
console.log('probe', probe.status, (await probe.text()).slice(0, 80));
await page.goto('http://127.0.0.1:8092/').catch((e) => console.log('goto', String(e)));
await page.waitForFunction(() => document.getElementById('result').textContent.includes('"done": true'), null, { timeout: 30000 });
const first = await page.textContent('#result');
await page.screenshot({ path: `${shots}/browser-check-1.png` });
await page.reload();
await page.waitForFunction(() => document.getElementById('result').textContent.includes('"done": true'), null, { timeout: 30000 });
const second = await page.textContent('#result');
console.log(first);
console.log(second);
console.log('errors', JSON.stringify(errors));
await browser.close();
server.close();
