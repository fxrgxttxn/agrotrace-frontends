/**
 * P4: the S3 client sends what MinIO accepts — Content-MD5 on DeleteObjects (checked here on the wire through a
 * capturing request handler; the live MinIO case is db/seed's test/db/s3-delete.test.ts) and no flexible checksum on
 * a plain upload (requestChecksumCalculation WHEN_REQUIRED).
 */
import { createHash } from 'node:crypto';
import { DeleteObjectsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createS3 } from '../src/infra/s3.js';
import { testConfig } from './helpers.js';

interface Captured {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function capturingS3() {
  const seen: Captured[] = [];
  const s3 = createS3(testConfig);
  // Replace the transport: record the signed request, answer like S3 would.
  (s3.client.config as unknown as { requestHandler: unknown }).requestHandler = {
    handle: async (request: Captured & { query?: Record<string, string> }) => {
      seen.push({
        method: request.method,
        path: request.path,
        headers: { ...request.headers },
        body: request.body,
      });
      const xml = '<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>';
      const { Readable } = await import('node:stream');
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/xml' },
          body: Readable.from([xml]),
        },
      };
    },
  };
  return { s3, seen };
}

describe('S3 client (P4)', () => {
  it('DeleteObjects of several keys carries a correct, signed Content-MD5', async () => {
    const { s3, seen } = capturingS3();
    await s3.client.send(
      new DeleteObjectsCommand({
        Bucket: 'c',
        Delete: { Objects: [{ Key: 'a' }, { Key: 'b' }, { Key: 'c/d' }], Quiet: true },
      }),
    );
    const req = seen[0]!;
    const body =
      typeof req.body === 'string' ? req.body : Buffer.from(req.body as Uint8Array).toString('utf8');
    expect(body).toContain('<Key>c/d</Key>');
    expect(req.headers['content-md5']).toBe(createHash('md5').update(body).digest('base64'));
    expect(req.headers.authorization).toMatch(/SignedHeaders=[^,]*content-md5/);
  });

  it('a plain PutObject sends no flexible checksum (WHEN_REQUIRED)', async () => {
    const { s3, seen } = capturingS3();
    await s3.client.send(new PutObjectCommand({ Bucket: 'c', Key: 'k', Body: 'hello' }));
    expect(Object.keys(seen[0]!.headers).filter((h) => h.startsWith('x-amz-checksum-'))).toEqual([]);
    expect(seen[0]!.headers['content-md5']).toBeUndefined();
  });
});
