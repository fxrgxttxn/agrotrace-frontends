/** Runs last: a second `seed` with the same SEED_NOW must produce byte-identical table contents. */
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, inject, it } from 'vitest';
import { runSeed, s3Client } from '../../src/seed';
import { env, tableChecksums, withDb } from './db';

describe('idempotency', () => {
  it('seeding again gives the same database content and the same MinIO objects', async () => {
    const before = await withDb(tableChecksums);
    expect(before.batches).toMatch(/^40:/);
    await runSeed({ ...env, seedNow: inject('seedNow') }, () => undefined, { writeDocs: false });
    const after = await withDb(tableChecksums);
    expect(after).toEqual(before);

    const referenced = await withDb(async (db) => {
      const rows = (
        await db.query<{ object_key: string; variants: Record<string, { key: string }> }>(
          'SELECT object_key, variants FROM files',
        )
      ).rows;
      return rows.flatMap((f) => [f.object_key, ...Object.values(f.variants).map((v) => v.key)]);
    });
    const s3 = s3Client(env);
    const listed: string[] = [];
    let token: string | undefined;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: env.s3.bucket, ContinuationToken: token }));
      listed.push(...(r.Contents ?? []).map((o) => o.Key!));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    for (const k of referenced) expect(listed).toContain(k);
    expect(listed.filter((k) => k.startsWith('seed/'))).toEqual([]);
  });
});
