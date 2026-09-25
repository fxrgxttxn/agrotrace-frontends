/** P8: secrets are redacted however deeply they sit in a log object; the request id rides along. */
import { describe, expect, it } from 'vitest';
import { runWithContext } from '../src/context.js';
import { createLogger } from '../src/logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level: 'info', process: 'api' },
    { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  );
  return { logger, lines };
}

describe('logger redaction (P8)', () => {
  it('redacts secret keys at the top level and nested up to four levels', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        password: 'p0',
        body: {
          password: 'p1',
          user: { accessToken: 't2', profile: { totpSecret: 's3', deep: { token: 't4' } } },
        },
        req: { headers: { authorization: 'Bearer x', cookie: 'at_refresh=y', 'set-cookie': ['z'] } },
        keep: { email: 'a@b.ru' },
      },
      'm',
    );
    const text = JSON.stringify(lines[0]);
    for (const secret of ['p0', 'p1', 't2', 's3', 't4', 'Bearer x', 'at_refresh=y', '"z"'])
      expect(text).not.toContain(secret);
    expect(lines[0]).toMatchObject({
      password: '***',
      body: {
        password: '***',
        user: { accessToken: '***', profile: { totpSecret: '***', deep: { token: '***' } } },
      },
      req: { headers: { authorization: '***', cookie: '***', 'set-cookie': '***' } },
      keep: { email: 'a@b.ru' },
    });
  });

  it('adds the request id of the current request context', () => {
    const { logger, lines } = capture();
    runWithContext({ requestId: 'rid-7', ip: null }, () => logger.info('in request'));
    logger.info('outside');
    expect(lines[0]).toMatchObject({ requestId: 'rid-7', backend: 'express', process: 'api', level: 'info' });
    expect(lines[1]).not.toHaveProperty('requestId');
  });
});
