// Serves the built check page on http://127.0.0.1:8092 (a secure context: service workers work) and drives Chromium:
// the tour in tab A, then tab B (same origin) restores the session, reads A's upload, and loses it after A logs out.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const [, , dir, shots, playwrightPath] = process.argv;
const { chromium } = await import(playwrightPath ?? 'playwright');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path === '/' ? '/index.html' : path;
  try {
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
const context = await browser.newContext();
const errors = [];
const open = async (hash, expected401 = false) => {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${hash}: ${(e.stack ?? String(e)).split('\n').slice(0, 4).join(' | ')}`));
  // The browser logs every 4xx resource load; the refresh after logout is meant to be 401.
  const expected = (m) => expected401 && m.text().includes('status of 401') && m.location().url.endsWith('/auth/refresh');
  page.on('console', (m) => m.type() === 'error' && !expected(m) && errors.push(`${hash}: ${m.text()} ${m.location().url}:${m.location().lineNumber}`));
  await page.goto(`http://127.0.0.1:8092/#${hash}`);
  await page.waitForFunction(() => document.getElementById('result').textContent.includes('"done": true'), null, { timeout: 30000 });
  return page;
};
const a = await open('login');
const tour = JSON.parse(await a.textContent('#result'));
await a.screenshot({ path: `${shots}/browser-check-1.png` });
const b1 = JSON.parse(await (await open('refresh')).textContent('#result'));
const b2 = JSON.parse(await (await open(`file=${encodeURIComponent(tour.avatarUrl)}`)).textContent('#result'));
const a2 = JSON.parse(await (await open('logout')).textContent('#result'));
const b3 = JSON.parse(await (await open('refresh', true)).textContent('#result'));
console.log(JSON.stringify({ tour, tabBRefresh: b1.refresh, tabBReadsUpload: b2.file, logoutInA: a2.logout, tabBAfterLogout: b3.refresh, errors }, null, 2));
await browser.close();
server.close();
