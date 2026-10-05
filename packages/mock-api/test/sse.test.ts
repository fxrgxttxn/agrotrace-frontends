import { describe, expect, it } from 'vitest';
import { createMockApi, DEMO_PASSWORD } from '../src/index.js';
import { nodeAssetLoader } from './helpers/assets.js';

describe('events stream', () => {
  it('unread on connect, notification + unread when one is created, reauth when the token expires', async () => {
    let t = Date.parse('2026-10-14T10:00:00Z');
    const api = createMockApi({ now: () => t, loadAsset: nodeAssetLoader });
    const post = (path: string, body: unknown) =>
      api.handle(new Request(`http://localhost/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    const login = await (await post('/auth/login', { email: 'inspector@agrotrace.test', password: DEMO_PASSWORD })).json();
    const res = await api.handle(new Request(`http://localhost/api/v1/events/stream?access_token=${login.accessToken}`));
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    expect(first).toMatch(/^event: unread\ndata: \{"count":\d+\}\n\n$/);
    const challenge = await (await api.handle(new Request('http://localhost/api/v1/public/captcha'))).json();
    const { solveChallenge } = await import('../src/index.js');
    const created = await post('/public/batches/AT-2026-000002/complaints', { text: 'Молоко прокисшее в день покупки.', altcha: solveChallenge(challenge) });
    expect(created.status).toBe(201);
    const n = dec.decode((await reader.read()).value);
    expect(n).toMatch(/^id: \d+\nevent: notification\ndata: \{.*"type":"COMPLAINT"/);
    const u = dec.decode((await reader.read()).value);
    expect(u).toMatch(/^event: unread/);
    await reader.cancel();

    const bad = await api.handle(new Request('http://localhost/api/v1/events/stream?access_token=a.b.c'));
    expect(bad.status).toBe(401);

    t += 900_000 - 50;
    const s2 = await api.handle(new Request(`http://localhost/api/v1/events/stream?access_token=${login.accessToken}`));
    const r2 = s2.body!.getReader();
    let all = '';
    for (;;) {
      const { value, done } = await r2.read();
      if (done) break;
      all += dec.decode(value);
    }
    expect(all).toContain('event: reauth\ndata: {"reason":"TOKEN_EXPIRED"}');
    api.dispose();
  });
});
