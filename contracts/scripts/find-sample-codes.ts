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
