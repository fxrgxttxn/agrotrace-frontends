/**
 * P4: MinIO rejects a multi-object DeleteObjects without Content-MD5 (`MissingContentMD5`) — the AWS SDK v3 sends a
 * CRC32 checksum instead. The seed deletes stale objects this way whenever a previous seed left objects the new one
 * doesn't produce (e.g. another SEED_NOW), so this deletes several objects in ONE call against the real MinIO.
 */
import { randomUUID } from 'node:crypto';
import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { deleteKeys, s3Client } from '../../src/seed';
import { env } from './db';

describe('MinIO DeleteObjects (P4)', () => {
  it('deletes several objects in one DeleteObjects call', async () => {
    const s3 = s3Client(env);
    const prefix = `test-delete/${randomUUID()}/`;
    const keys = ['a.txt', 'b.txt', 'c/d.txt'].map((k) => prefix + k);
    for (const Key of keys) await s3.send(new PutObjectCommand({ Bucket: env.s3.bucket, Key, Body: Key }));
    const listed = async () =>
      (await s3.send(new ListObjectsV2Command({ Bucket: env.s3.bucket, Prefix: prefix }))).Contents ?? [];
    expect(await listed()).toHaveLength(3);
    await deleteKeys(s3, env.s3.bucket, keys);
    expect(await listed()).toHaveLength(0);
  });
});
