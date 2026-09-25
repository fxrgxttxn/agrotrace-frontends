// Browser check of @agrotrace/mock-api: the service worker path, the cookie jar, images, SSE, persistence.
import { startBrowserMock } from '../../src/browser.js';

const out: Record<string, unknown> = {};
const log = (k: string, v: unknown) => {
  out[k] = v;
  document.getElementById('result')!.textContent = JSON.stringify(out, null, 2);
};

async function main() {
  const reloaded = sessionStorage.getItem('check-reloaded') === '1';
  await startBrowserMock({ delayMs: 0 });
  log('reloaded', reloaded);
  if (!reloaded) {
    const login = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'provizia.head@agrotrace.test', password: 'agrotrace-demo' }),
    });
    const body = await login.json();
    log('login', login.status);
    const me = await fetch('/api/v1/me', { headers: { Authorization: `Bearer ${body.accessToken}` } });
    log('me', (await me.json()).fullName);
    const batches = await fetch('/api/v1/batches?holder=me&size=1', { headers: { Authorization: `Bearer ${body.accessToken}` } });
    const page = await batches.json();
    const img = document.getElementById('photo') as HTMLImageElement;
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = page.items[0].product.imageUrl;
    });
    log('image', { width: img.naturalWidth, url: img.src });
    const avatar = await fetch(body.user.avatarUrl);
    log('avatar', [avatar.status, avatar.headers.get('Content-Type')]);
    const es = new EventSource(`/api/v1/events/stream?access_token=${body.accessToken}`);
    log('sse', await new Promise((resolve) => {
      es.addEventListener('unread', (e) => {
        es.close();
        resolve((e as MessageEvent).data);
      });
      setTimeout(() => resolve('timeout'), 5000);
    }));
    const qr = await fetch(`/api/v1/public/batches/${page.items[0].publicCode}`);
    log('public', (await qr.json()).safety);
    await new Promise((r) => setTimeout(r, 100));
    sessionStorage.setItem('check-reloaded', '1');
    log('done', true);
  } else {
    const refresh = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    log('refreshAfterReload', refresh.status);
    log('done', true);
  }
}
main().catch((e) => log('error', String(e)));
