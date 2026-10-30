/**
 * The error paths tests/api cannot provoke over HTTP: an unexpected exception (500 INTERNAL without internals), a
 * ZodError from a handler, an AppProblem with rule/params/errors, and the log line carrying the request id.
 */
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AppProblem, notFoundHandler, problemHandler, problemType, toProblem } from '../src/http/problem.js';
import { backendHeader, requestId } from '../src/http/request-id.js';
import { ah } from '../src/http/async.js';
import { createApp } from '../src/app.js';
import { fakeContainer, memoryLogger } from './helpers.js';

function appWith(route: (app: express.Express) => void) {
  const { logger, lines } = memoryLogger();
  const app = express();
  app.use(requestId());
  app.use(backendHeader('express'));
  app.use(express.json());
  route(app);
  app.use(notFoundHandler());
  app.use(problemHandler(logger));
  return { app, lines };
}

describe('problem handler', () => {
  it('an unexpected error → 500 INTERNAL problem, no message or stack in the body; logged with the request id', async () => {
    const { app, lines } = appWith((a) =>
      a.get(
        '/boom',
        ah(async () => {
          throw new Error('secret connection string postgres://u:p@db');
        }),
      ),
    );
    const res = await request(app).get('/boom').set('X-Request-Id', 'req-500');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['x-backend']).toBe('express');
    expect(res.headers['x-request-id']).toBe('req-500');
    expect(res.body).toEqual({
      type: '/problems/internal',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL',
    });
    expect(res.text).not.toMatch(/secret|postgres|at |Error/);
    const logged = lines.find((l) => l.msg === 'unhandled error')!;
    expect(logged).toMatchObject({ level: 50, requestId: 'req-500', path: '/boom' });
    expect(JSON.stringify(logged.err)).toMatch(/secret connection string/);
  });

  it('a synchronous throw is handled the same way', async () => {
    const { app } = appWith((a) =>
      a.get('/sync', () => {
        throw new TypeError('x is undefined');
      }),
    );
    const res = await request(app).get('/sync');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL');
  });

  it('a ZodError → 400 VALIDATION with toFieldErrors keys (contract path form items[0].field)', async () => {
    const schema = z.object({
      email: z.string().email('validation.email'),
      items: z.array(z.object({ id: z.string().uuid('validation.uuid') })),
    });
    const { app } = appWith((a) => a.post('/v', (req) => void schema.parse(req.body)));
    const res = await request(app)
      .post('/v')
      .send({ email: 'nope', items: [{ id: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      type: '/problems/validation',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION',
      errors: { email: ['validation.email'], 'items[0].id': ['validation.uuid'] },
    });
  });

  it('an AppProblem keeps rule, params, errors, detail and extra headers', async () => {
    const { app } = appWith((a) =>
      a.post('/br', () => {
        throw new AppProblem(422, 'BUSINESS_RULE', {
          rule: 'BR-01',
          params: { until: '2026-09-25', substance: 'X' },
          headers: { 'Retry-After': '5' },
        });
      }),
    );
    const res = await request(app).post('/br');
    expect(res.status).toBe(422);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toEqual({
      type: '/problems/business-rule',
      title: 'Business rule violated',
      status: 422,
      code: 'BUSINESS_RULE',
      rule: 'BR-01',
      params: { until: '2026-09-25', substance: 'X' },
    });
  });

  it('type is /problems/ + the code in kebab case', () => {
    expect(problemType('VERSION_CONFLICT')).toBe('/problems/version-conflict');
    expect(problemType('IDEMPOTENCY_KEY_IN_PROGRESS')).toBe('/problems/idempotency-key-in-progress');
    expect(problemType('NOT_FOUND')).toBe('/problems/not-found');
  });

  it('maps body-parser errors: malformed JSON → 400, too large → 413 FILE_TOO_LARGE, bad charset → 415', () => {
    expect(
      toProblem(Object.assign(new SyntaxError('x'), { type: 'entity.parse.failed' }))?.body(),
    ).toMatchObject({
      status: 400,
      errors: { _root: ['validation.invalid'] },
    });
    expect(toProblem(Object.assign(new Error('x'), { type: 'entity.too.large' }))?.body()).toMatchObject({
      status: 413,
      code: 'FILE_TOO_LARGE',
      params: { maxBytes: 12582912 },
    });
    expect(toProblem(Object.assign(new Error('x'), { type: 'charset.unsupported' }))?.body()).toMatchObject({
      status: 400,
      errors: { _root: ['validation.invalid'] },
    });
    // I2: a malformed percent-escape in a path parameter (Express throws a URIError with status 400).
    expect(toProblem(Object.assign(new URIError('URI malformed'), { status: 400 }))?.body()).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    // A lost or refused database connection → 503, as on django and laravel; a protocol violation (08P01) stays 500.
    for (const err of [
      Object.assign(new Error('x'), { code: '08006' }),
      Object.assign(new Error('x'), { code: '08001' }),
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }),
      new Error('Connection terminated unexpectedly'),
    ])
      expect(toProblem(err)?.body(), err.message).toMatchObject({ status: 503, code: 'BACKEND_UNAVAILABLE' });
    expect(toProblem(Object.assign(new Error('x'), { code: '08P01' }))).toBeNull();
    // Other exposed 4xx http-errors map by status, never with the library message; 5xx and non-exposed stay 500.
    const httpErr = (status: number, expose = true) =>
      Object.assign(new Error('lib text'), { status, expose });
    expect(toProblem(httpErr(404))?.code).toBe('NOT_FOUND');
    expect(toProblem(httpErr(400))?.body()).toEqual({
      type: '/problems/validation',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION',
      errors: { _root: ['validation.invalid'] },
    });
    expect(toProblem(httpErr(503))).toBeNull();
    expect(toProblem(httpErr(400, false))).toBeNull();
    expect(toProblem(new Error('other'))).toBeNull();
  });

  it('P61: an exhausted pool, statement_timeout and lock_timeout → 503 BACKEND_UNAVAILABLE', () => {
    for (const err of [
      new Error('timeout exceeded when trying to connect'),
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    ])
      expect(toProblem(err)?.body()).toMatchObject({ status: 503, code: 'BACKEND_UNAVAILABLE' });
  });
});

/** A container whose contract also declares `GET /zz-unimplemented` (every real operation is implemented now). */
async function withUnimplemented() {
  const { c } = await fakeContainer();
  const doc = structuredClone(c.contract!.doc);
  (doc.paths as Record<string, unknown>)['/zz-unimplemented'] = {
    get: { operationId: 'zzUnimplemented', 'x-roles': ['ANY'], responses: {} },
  };
  return { ...c, contract: { doc, raw: JSON.stringify(doc) } } as typeof c;
}

describe('404 / 405 fallback (createApp)', () => {
  it('a declared but not implemented operation is 404; another method on a contract path is 405 + Allow', async () => {
    const app = createApp(await withUnimplemented());
    const notImpl = await request(app).get('/api/v1/zz-unimplemented');
    expect(notImpl.status).toBe(404);
    expect(notImpl.body.code).toBe('NOT_FOUND');
    const wrong = await request(app).post('/api/v1/zz-unimplemented');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('GET');
    expect(wrong.body).toEqual({
      type: '/problems/method-not-allowed',
      title: 'Method not allowed',
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
    });
    const templ = await request(app).put('/api/v1/batches/8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e');
    expect(templ.status).toBe(405);
    expect(templ.headers.allow).toBe('GET');
  });

  it("OPTIONS on an implemented route is 405 with the contract Allow, not Express's automatic 200 (I1)", async () => {
    const { c } = await fakeContainer();
    const res = await request(createApp(c)).options('/api/v1/health/live');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET');
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe('METHOD_NOT_ALLOWED');
    const other = await request(createApp(c)).options('/api/v1/docs');
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('NOT_FOUND');
  });

  it('a route mounted on a contract path inherits the guard: only the declared method reaches it', async () => {
    const app = createApp(await withUnimplemented());
    // What a future module does: mount a router with a handler for every method on a contract path.
    const hits: string[] = [];
    const stack = (app as unknown as { _router: { stack: unknown[] } })._router.stack;
    const probe = express.Router();
    probe.all('/api/v1/zz-unimplemented', (req, res) => {
      hits.push(req.method);
      res.status(204).end();
    });
    stack.splice(stack.length - 2, 0, ...(probe as unknown as { stack: unknown[] }).stack);
    expect((await request(app).get('/api/v1/zz-unimplemented')).status).toBe(204);
    const put = await request(app).put('/api/v1/zz-unimplemented');
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe('GET');
    expect(hits).toEqual(['GET']);
  });

  it('a raw path with an empty segment is 404 even where Express would collapse the slashes (P8)', async () => {
    const { c } = await fakeContainer();
    const app = createApp(c);
    for (const p of [
      '/api/v1//health/live',
      '/api/v1/health//live',
      '//api/v1/health/live',
      '/api/v1///health/live',
      '/api/v1/health/live//?x=1',
    ]) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(404);
      expect(res.body.code, p).toBe('NOT_FOUND');
    }
    expect((await request(app).get('/api/v1/health/live?next=//x')).status).toBe(200); // query is not the path
  });

  it('routing is case-sensitive and strict (P8)', async () => {
    const { c } = await fakeContainer();
    const app = createApp(c);
    expect((await request(app).get('/api/v1/health/live')).status).toBe(200);
    for (const p of ['/api/v1/Health/live', '/api/v1/health/live/', '/API/v1/health/live'])
      expect((await request(app).get(p)).status, p).toBe(404);
  });
});
