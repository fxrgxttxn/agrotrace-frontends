import type { MockConfig } from '../config.js';
import { sha256hex } from '../lib/crypto.js';
import { loadFonts, protocolPdf, qrLabelPdf } from '../render/documents.js';
import { qrPng } from '../render/png.js';
import type { Store } from '../store/store.js';
import type { BatchRow } from '../store/types.js';
import { compareCodePoints } from '@agrotrace/domain';

export const publicUrl = (cfg: MockConfig, publicCode: string): string =>
  `${cfg.publicBaseUrl.replace(/\/+$/, '')}/p/${publicCode}`;

export async function protocolBytes(cfg: MockConfig, store: Store, testId: string): Promise<Uint8Array> {
  const t = store.must('lab_tests', testId);
  const b = store.must('batches', t.batch_id);
  const lab = store.must('organizations', t.lab_org_id);
  const results = store.t.lab_results
    .filter((r) => r.lab_test_id === t.id)
    .map((r) => {
      const ind = store.must('indicators', r.indicator_id);
      return { name: ind.name, unit: ind.unit, norm: r.norm_value_snapshot, value: r.value, exceeded: r.is_exceeded };
    })
    .sort((x, y) => compareCodePoints(x.name, y.name));
  return protocolPdf(await loadFonts(cfg.loadAsset), {
    labName: lab.name,
    labInn: lab.inn,
    testId: t.id,
    publicCode: b.public_code,
    productName: store.must('products', b.product_id).name,
    customerName: store.must('organizations', b.origin_org_id).name,
    reason: t.reason,
    sampledAt: t.sampled_at,
    completedAt: t.completed_at,
    conclusion: t.conclusion,
    results,
    createdAt: t.completed_at ?? t.created_at,
  });
}

export async function qrFiles(cfg: MockConfig, store: Store, b: BatchRow): Promise<{ png: Uint8Array; pdf: Uint8Array }> {
  const url = publicUrl(cfg, b.public_code);
  const png = qrPng(url);
  const pdf = qrLabelPdf(await loadFonts(cfg.loadAsset), {
    publicCode: b.public_code,
    publicUrl: url,
    productName: store.must('products', b.product_id).name,
    originName: store.must('organizations', b.origin_org_id).name,
    createdAt: b.qr_generated_at ?? store.nowIso(),
  });
  return { png, pdf };
}

export async function renderGenerated(cfg: MockConfig, store: Store): Promise<void> {
  for (const f of store.t.files) {
    if (!f.regen || (f.content.type === 'bytes' && f.content.data.length > 0)) continue;
    let data: Uint8Array;
    if (f.regen.type === 'protocol') data = await protocolBytes(cfg, store, f.regen.testId);
    else {
      const files = await qrFiles(cfg, store, store.must('batches', f.regen.batchId));
      data = f.regen.type === 'qrPng' ? files.png : files.pdf;
    }
    f.size_bytes = data.length;
    f.sha256 = sha256hex(data);
    f.content = { type: 'bytes', data };
  }
}
