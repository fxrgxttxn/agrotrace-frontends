import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const [, , dir, shots, playwrightPath] = process.argv;
const { chromium } = await import(playwrightPath ?? 'playwright');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.css': 'text/css' };
let slowUntil = 0;
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/__slow-assets') {
    slowUntil = Date.now() + 5000;
    res.writeHead(204);
    return res.end();
  }
  if (extname(path) === '.webp' && Date.now() < slowUntil) await new Promise((r) => setTimeout(r, 3000));
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

const [ra, rb] = [await open('idle'), await open('idle')];
const token = await ra.evaluate(async () => {
  const r = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'petrov@agrotrace.test', password: 'agrotrace-demo' }) });
  return (await r.json()).accessToken;
});
const burst = (page, prefix, n) =>
  page.evaluate(
    ({ token, prefix, n }) =>
      Promise.all(
        Array.from({ length: n }, async (_, i) =>
          (await fetch('/api/v1/fields', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `${prefix}${i}`, areaHa: '1.00', regionCode: '33' }) })).status,
        ),
      ),
    { token, prefix, n },
  );
const reads = (page, n) =>
  page.evaluate(
    async ({ token, n }) => {
      for (let i = 0; i < n; i++) await fetch('/api/v1/fields?size=1', { headers: { Authorization: `Bearer ${token}` } });
    },
    { token, n },
  );
const [sa, sb] = await Promise.all([burst(ra, 'A', 10), burst(rb, 'B', 10)]);
const [sc] = await Promise.all([burst(ra, 'C', 10), reads(rb, 30)]);
const rc = await open('idle');
const persisted = await rc.evaluate(async (token) => {
  const r = await fetch('/api/v1/fields?size=100', { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()).items.map((x) => x.name).filter((n) => /^[ABC]\d$/.test(n)).length;
}, token);
const persistErrors = await Promise.all([ra, rb].map((p) => p.evaluate(() => String(globalThis.__agrotraceMock?.persistError ?? null))));

const nav = await open('navigate');
await nav.waitForTimeout(3500);
const navigatedAway = { url: new URL(nav.url()).search, errors: errors.filter((e) => e.startsWith('navigate')).length };
const revived = await open('idle');
const cdp = await context.newCDPSession(revived);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
const workerRestart = await revived.evaluate(() =>
  Promise.all(
    [1, 2, 3].map(async () => {
      const r = await fetch('/api/v1/public/batches/AT-2026-000001');
      return `${r.status} ${r.headers.get('X-Backend')}`;
    }),
  ),
);
const race = { statuses: [...sa, ...sb, ...sc].every((s) => s === 201) ? '30 x 201' : [...sa, ...sb, ...sc], persisted, expected: 30, persistErrors };

console.log(JSON.stringify({ tour, tabBRefresh: b1.refresh, tabBReadsUpload: b2.file, logoutInA: a2.logout, tabBAfterLogout: b3.refresh, race, navigatedAway, workerRestart, errors }, null, 2));
await browser.close();
server.close();
