/**
 * SSE stream GET /events/stream (contracts/openapi/paths/events.yaml; spec 8.4, R33, FR-NOTIF-01): 401 before the
 * stream, `unread` on connect, `notification` (id: = seq) then `unread` for a new row, `unread` alone after
 * markNotificationsRead, replay for `Last-Event-ID` / `lastEventId` (header wins; the contract's late-commit window),
 * `reauth` at the token's expiry, `ping` every 25 s.
 *
 * Cross-backend basis: a notification row inserted straight into the shared DB (as another implementation's worker
 * would) reaches this backend's stream through the table trigger's pg_notify — the one fixture write of this file.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, type ApiClient } from './lib/client.js';
import { expectContract, schemaErrors } from './lib/contract.js';
import { fixtureWrite } from './lib/db.js';
import { eventually, freshOrg, sentWaybill } from './lib/production.js';
import { freshFarm, labApproved, type FreshFarm } from './lib/quality.js';
import { openStream, type SseEvent, type SseStream } from './lib/sse.js';

const open: SseStream[] = [];
async function stream(opts: Parameters<typeof openStream>[0]): Promise<SseStream> {
  const s = await openStream(opts);
  open.push(s);
  expect(s.status).toBe(200);
  await expectContract(s.response, 'streamEvents');
  return s;
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function unreadTotal(client: ApiClient): Promise<number> {
  const res = await client.get('/notifications', { query: { isRead: false, size: 1 } });
  await expectContract(res, 'listNotifications');
  return res.body.total as number;
}

async function expectNotification(e: SseEvent): Promise<void> {
  expect(e.id).toBe(String(e.data.seq));
  expect(await schemaErrors('Notification', e.data)).toEqual([]);
}

const b64url = (s: string) => Buffer.from(s).toString('base64url');
function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}
/** A token signed with the shared JWT_SECRET (any backend accepts it) with another expiry. */
function tokenExpiringIn(token: string, seconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({ ...jwtPayload(token), jti: randomUUID(), iat: now, exp: now + seconds }),
  );
  const sig = createHmac('sha256', process.env.JWT_SECRET!).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

describe('GET /events/stream', () => {
  let farm: FreshFarm;
  let receiver: { client: ApiClient; orgId: string; userId: string };

  beforeAll(async () => {
    farm = await freshFarm();
    receiver = await freshOrg('PROCESSOR');
  });

  /** WAYBILL_INCOMING to the receiver: one new IN_APP row for it. */
  const incoming = async () => sentWaybill(farm.client, receiver.orgId, [await labApproved(farm)]);

  it('an invalid or missing access_token → 401 problem before any stream; the Authorization header is not used', async () => {
    for (const q of [{ access_token: 'not-a-jwt' }, {}]) {
      const res = await api().get('/events/stream', { query: q });
      await expectContract(res, 'streamEvents');
      expect(res.status, res.text).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    }
    const bearerOnly = await api().get('/events/stream', {
      headers: { authorization: `Bearer ${receiver.client.accessToken}` },
    });
    expect(bearerOnly.status).toBe(401);
    const expired = await api().get('/events/stream', {
      query: { access_token: tokenExpiringIn(receiver.client.accessToken!, -5) },
    });
    expect(expired.status).toBe(401);
  });

  it('unread on connect; a new notification → `notification` (id = seq) then `unread`; markRead → `unread` alone', async () => {
    const s = await stream({ token: receiver.client.accessToken! });
    const first = await s.next('unread');
    expect(s.events[0]).toBe(first);
    expect(first.data).toEqual({ count: await unreadTotal(receiver.client) });

    const wb = await incoming();
    const n = await s.next('notification');
    await expectNotification(n);
    expect(n.data.type).toBe('WAYBILL_INCOMING');
    expect(n.data.payload.waybillId).toBe(wb.id);
    expect(n.data.isRead).toBe(false);
    const after = await s.next('unread');
    expect(s.events.indexOf(after)).toBeGreaterThan(s.events.indexOf(n));
    expect(after.data).toEqual({ count: first.data.count + 1 });

    const mark = await receiver.client.post('/notifications/read', { upToSeq: n.data.seq });
    await expectContract(mark, 'markNotificationsRead');
    expect(mark.body).toEqual({ count: 0 });
    expect((await s.next('unread')).data).toEqual({ count: 0 });
    expect(s.events.filter((e) => e.event === 'notification')).toHaveLength(1);
  });

  it('replay: rows after Last-Event-ID / lastEventId (header wins), unread rows of the late-commit window, then unread', async () => {
    const live = await stream({ token: receiver.client.accessToken! });
    await live.next('unread');
    await incoming();
    const n1 = (await live.next('notification')).data;
    await incoming();
    const n2 = (await live.next('notification')).data;
    live.close();

    // After n1: n2 is replayed, n1 itself is not.
    const a = await stream({ token: receiver.client.accessToken!, lastEventId: String(n1.seq) });
    const unreadA = await a.next('unread');
    const replayedA = a.events.slice(0, a.events.indexOf(unreadA)).filter((e) => e.event === 'notification');
    expect(replayedA.map((e) => e.data.id)).toEqual([n2.id]);
    await expectNotification(replayedA[0]!);

    // After n2: n1 (lower seq, unread, created within 60 s of n2) is replayed — a transaction that inserted earlier
    // may commit later than n2 was sent (the contract's late-commit window).
    const b = await stream({ token: receiver.client.accessToken!, header: String(n2.seq) });
    const unreadB = await b.next('unread');
    expect(
      b.events
        .slice(0, b.events.indexOf(unreadB))
        .filter((e) => e.event === 'notification')
        .map((e) => e.data.id),
    ).toEqual([n1.id]);

    // n1 read: nothing to replay after n2; the header wins over lastEventId (n1 would replay n2).
    const mark = await receiver.client.post('/notifications/read', { ids: [n1.id] });
    expect(mark.status, mark.text).toBe(200);
    const c = await stream({
      token: receiver.client.accessToken!,
      header: String(n2.seq),
      lastEventId: String(n1.seq),
    });
    const unreadC = await c.next('unread');
    expect(c.events.slice(0, c.events.indexOf(unreadC)).filter((e) => e.event === 'notification')).toEqual(
      [],
    );
    expect(unreadC.data).toEqual({ count: await unreadTotal(receiver.client) });

    // A value that is not a sequence number is ignored (no replay, no error).
    const d = await stream({ token: receiver.client.accessToken!, lastEventId: 'abc' });
    expect((await d.next('unread')).data.count).toBe(unreadC.data.count);
  });

  it('a row inserted into the shared DB by "another backend" reaches the stream (LISTEN notifications)', async () => {
    const s = await stream({ token: receiver.client.accessToken! });
    const before = (await s.next('unread')).data.count as number;
    // The one fixture write here: what another implementation's notification.dispatch worker does — an IN_APP row
    // (its trigger emits pg_notify('notifications', {id, user_id})).
    const [row] = await fixtureWrite<{ id: string; seq: string }>(
      `INSERT INTO notifications (user_id, type, payload, channel, delivery_status)
       VALUES ($1, 'COMPLAINT', $2, 'IN_APP', 'DELIVERED') RETURNING id, seq`,
      [
        receiver.userId,
        JSON.stringify({
          complaintId: randomUUID(),
          batchId: randomUUID(),
          publicCode: 'AT-2026-999999',
          productName: 'Кросс-backend',
        }),
      ],
    );
    const n = await s.next('notification');
    await expectNotification(n);
    expect(n.data).toMatchObject({ id: row!.id, seq: Number(row!.seq), type: 'COMPLAINT', isRead: false });
    expect((await s.next('unread')).data).toEqual({ count: before + 1 });
  });

  it('a lost LISTEN session: after the reconnect the stream gets what it missed, never the history', async () => {
    // The receiver has a history by now (notifications of the tests above). Marked read, so the contract's late-commit
    // window (unread rows created ≤ 60 s before the loss) has nothing to re-send either.
    const top = await receiver.client.get('/notifications', { query: { size: 1 } });
    const mark = await receiver.client.post('/notifications/read', { upToSeq: top.body.items[0].seq });
    expect(mark.status, mark.text).toBe(200);
    const s = await stream({ token: receiver.client.accessToken! });
    await s.next('unread');
    // Sanctioned test-stand action (P48): every implementation's LISTEN session is the one whose statement is
    // `LISTEN notifications` (Express probes with it too); terminating it is a DB restart in small.
    // In ONE statement (N4): the session is terminated — `pg_terminate_backend(pid, 5000)` waits until it is gone — and
    // only then a row is inserted, so its NOTIFY reaches no listener and only the reconnect resync can deliver it.
    const [row] = await fixtureWrite<{ id: string; killed: number }>(
      `WITH killed AS (
         SELECT pg_terminate_backend(pid, 5000) AS ok FROM pg_stat_activity
          WHERE datname = current_database() AND query = 'LISTEN notifications' AND pid <> pg_backend_pid())
       INSERT INTO notifications (user_id, type, payload, channel, delivery_status)
       SELECT $1, 'COMPLAINT', $2, 'IN_APP', 'DELIVERED' FROM (SELECT count(*) AS n FROM killed) k WHERE k.n > 0
       RETURNING id, (SELECT count(*)::int FROM killed) AS killed`,
      [
        receiver.userId,
        JSON.stringify({
          complaintId: randomUUID(),
          batchId: randomUUID(),
          publicCode: 'AT-2026-999998',
          productName: 'Разрыв LISTEN',
        }),
      ],
    );
    expect(row, 'a LISTEN notifications session was terminated').toBeDefined();
    const n = await s.next('notification', 30000);
    expect(n.data.id).toBe(row!.id);
    await new Promise((r) => setTimeout(r, 3000));
    expect(s.events.filter((e) => e.event === 'notification').map((e) => e.data.id)).toEqual([row!.id]);
    // The stream still runs live after the reconnect.
    const wb2 = await incoming();
    expect((await s.next('notification', 15000)).data.payload.waybillId).toBe(wb2.id);
  });

  it('reauth when the access token expires, then the stream ends', async () => {
    const s = await stream({ token: tokenExpiringIn(receiver.client.accessToken!, 3) });
    await s.next('unread');
    const e = await s.next('reauth', 10000);
    expect(e.data).toEqual({ reason: 'TOKEN_EXPIRED' });
    await s.ended;
    expect(s.events.at(-1)).toBe(e);
  });

  it('ping every 25 s', async () => {
    const s = await stream({ token: receiver.client.accessToken! });
    const t0 = Date.now();
    const p = await s.next('ping', 30000);
    expect(Date.now() - t0).toBeGreaterThan(20000);
    expect(p.data.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Math.abs(Date.parse(p.data.ts) - Date.now())).toBeLessThan(5000);
  }, 40000);

  it('streams of the same user all get the event; other users do not', async () => {
    const s1 = await stream({ token: receiver.client.accessToken! });
    const s2 = await stream({ token: receiver.client.accessToken! });
    const other = await stream({ token: farm.client.accessToken! });
    await Promise.all([s1.next('unread'), s2.next('unread'), other.next('unread')]);
    const wb = await incoming();
    for (const s of [s1, s2]) expect((await s.next('notification')).data.payload.waybillId).toBe(wb.id);
    await eventually(async () =>
      s1.events.filter((e) => e.event === 'unread').length >= 2 ? true : undefined,
    );
    expect(
      other.events.filter((e) => e.event === 'notification' && e.data.type === 'WAYBILL_INCOMING'),
    ).toEqual([]);
  });
});
