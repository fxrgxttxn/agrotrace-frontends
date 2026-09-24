/** Runs last: a second `seed` with the same SEED_NOW must produce byte-identical table contents. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, inject, it } from 'vitest';
import { runSeed, s3Client } from '../../src/seed';
import { env, tableChecksums, withDb } from './db';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** mtime and size of every git-tracked file (the seed must not write any of them, R86). */
function trackedFiles(): Map<string, string> {
  const files = execFileSync('git', ['-c', `safe.directory=${REPO.replace(/\/$/, '')}`, 'ls-files', '-z'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  return new Map(
    files.map((f) => {
      try {
        const s = statSync(`${REPO}${f}`);
        return [f, `${s.mtimeMs}:${s.size}`];
      } catch {
        return [f, 'missing'];
      }
    }),
  );
}

describe('idempotency', () => {
  it('seeding again gives the same database content and the same MinIO objects', async () => {
    const before = await withDb(tableChecksums);
    expect(before.batches).toMatch(/^40:/);
    await runSeed({ ...env, seedNow: inject('seedNow') }, () => undefined);
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

  it('never writes a tracked file, docs/demo-accounts.md included (R86)', async () => {
    const docs = new URL('../../../../docs/demo-accounts.md', import.meta.url);
    const docsBefore = readFileSync(docs, 'utf8');
    const before = trackedFiles();
    expect(before.size).toBeGreaterThan(100);
    await runSeed({ ...env, seedNow: inject('seedNow') }, () => undefined);
    const after = trackedFiles();
    const changed = [...before].filter(([f, v]) => after.get(f) !== v).map(([f]) => f);
    expect(changed).toEqual([]);
    expect(readFileSync(docs, 'utf8')).toBe(docsBefore);
  });
});
