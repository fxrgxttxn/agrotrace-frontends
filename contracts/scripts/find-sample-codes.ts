// BR-03's deterministic 20% sample is: sha256(utf8 publicCode) -> first 4
// bytes read as a big-endian uint32 -> mod 100 < 20. This script brute-forces
// public codes AT-2026-000001, AT-2026-000002, ... and prints the first code
// found for each of mod100 in {0, 19, 20, 99} -- the boundary values used to
// build BR-03.json's SAMPLED vectors (0 and 19 are inside the 20% sample,
// 20 and 99 are just outside it). Run with:
//   pnpm --filter @agrotrace/contracts gen:sample-codes
import { createHash } from 'node:crypto';

function mod100(code: string): number {
  const digest = createHash('sha256').update(code, 'utf8').digest();
  const uint32 = digest.readUInt32BE(0);
  return uint32 % 100;
}

const targets = new Set([0, 19, 20, 99]);
const found = new Map<number, string>();

for (let seq = 1; found.size < targets.size && seq <= 5_000_000; seq++) {
  const code = `AT-2026-${String(seq).padStart(6, '0')}`;
  const m = mod100(code);
  if (targets.has(m) && !found.has(m)) {
    found.set(m, code);
    console.log(`mod100=${m}\tcode=${code}\tseq=${seq}`);
  }
}

for (const t of [...targets].sort((a, b) => a - b)) {
  if (!found.has(t)) console.log(`mod100=${t}\tNOT FOUND within search range`);
}
