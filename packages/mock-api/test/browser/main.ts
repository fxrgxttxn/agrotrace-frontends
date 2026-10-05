import { startBrowserMock } from '../../src/browser.js';

const out: Record<string, unknown> = {};
const log = (k: string, v: unknown) => {
  out[k] = v;
  document.getElementById('result')!.textContent = JSON.stringify(out, null, 2);
};

async function tour() {
  const login = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'provizia.head@agrotrace.test', password: 'agrotrace-demo' }),
  });
  const body = await login.json();
  log('login', [login.status, login.headers.get('X-Backend'), Boolean(login.headers.get('X-Request-Id'))]);
  const auth = { Authorization: `Bearer ${body.accessToken}` };
  log('me', (await (await fetch('/api/v1/me', { headers: auth })).json()).fullName);
  const page = await (await fetch('/api/v1/batches?holder=me&size=1', { headers: auth })).json();
  const img = document.getElementById('photo') as HTMLImageElement;
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = page.items[0].product.imageUrl;
  });
  log('image', img.naturalWidth);
  const avatar = await fetch(body.user.avatarUrl);
  log('avatar', [avatar.status, avatar.headers.get('Content-Type')]);
  const form = new FormData();
  form.set('file', new File([await (await fetch(img.src)).blob()], 'upload.webp'));
  const up = await fetch('/api/v1/me/avatar', { method: 'PUT', headers: auth, body: form });
  const upBody = await up.json();
  log('upload', [up.status, upBody.mime]);
  const variant = await fetch(`${upBody.url}&variant=96`);
  log('uploadVariant', [variant.status, variant.headers.get('Content-Type')]);
  const es = new EventSource(`/api/v1/events/stream?access_token=${body.accessToken}`);
  log(
    'sse',
    await new Promise((resolve) => {
      es.addEventListener('unread', (e) => {
        es.close();
        resolve((e as MessageEvent).data);
      });
      setTimeout(() => resolve('timeout'), 5000);
    }),
  );
  const api = (globalThis as { __agrotraceMock?: { openStreams: number } }).__agrotraceMock!;
  const deadline = Date.now() + 3000;
  while (api.openStreams > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  log('sseOpenAfterClose', api.openStreams);
  log('public', (await (await fetch(`/api/v1/public/batches/${page.items[0].publicCode}`)).json()).safety);
  log('avatarUrl', upBody.url);
}

async function navigateAway() {
  const pub = await (await fetch('/api/v1/public/batches/AT-2026-000001')).json();
  const login = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'zarya.head@agrotrace.test', password: 'agrotrace-demo' }),
  });
  const { user } = await login.json();
  await fetch('/__slow-assets');
  const img = document.getElementById('photo') as HTMLImageElement;
  img.src = pub.product.imageUrl;
  void fetch(user.avatarUrl).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  location.href = '/?after#idle';
  await new Promise(() => undefined);
}

async function main() {
  await startBrowserMock({ delayMs: 0 });
  const step = location.hash.slice(1) || 'login';
  if (step === 'login') await tour();
  if (step === 'refresh') log('refresh', (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).status);
  if (step === 'logout') log('logout', (await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' })).status);
  if (step.startsWith('file=')) log('file', (await fetch(decodeURIComponent(step.slice(5)))).status);
  if (step === 'navigate') await navigateAway();
  log('done', true);
}
main().catch((e) => log('error', String(e)));
