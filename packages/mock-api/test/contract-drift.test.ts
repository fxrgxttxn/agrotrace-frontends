import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BASE, call, expectStatus } from './helpers/client.js';
import { useMock } from './helpers/mock.js';

const mock = useMock();
const webp = new Uint8Array(readFileSync(new URL('../assets/seed/avatars/avatar-1-96.webp', import.meta.url)));
const enc = (s: string) => new TextEncoder().encode(s);
const UNKNOWN = '00000000-0000-4000-8000-000000000001';
const form = (parts: [string, Uint8Array | string, string?][]): FormData => {
  const f = new FormData();
  for (const [k, v, name] of parts) f.append(k, typeof v === 'string' ? v : new File([v], name ?? 'x.bin'));
  return f;
};

describe('signed file URLs (P14, P17)', () => {
  it('malformed exp/sig (or id) with a signature is 403, id and variant are checked after it', async () => {
    const t = await mock.login('provizia.head@agrotrace.test');
    const me = await expectStatus(200, 'GET', '/me', { token: t });
    const url: string = me.body.avatarUrl.replace('/api/v1', '');
    const [path, query] = url.split('?') as [string, string];
    const exp = /exp=(\d+)/.exec(query)![1]!;
    for (const q of [`exp=0${exp}&sig=${'a'.repeat(64)}`, `exp=abc&sig=${'a'.repeat(64)}`, `exp=${exp}&sig=XYZ`, `exp=${exp}`, `sig=${'a'.repeat(64)}`])
      await expectStatus(403, 'GET', `${path}?${q}`);
    await expectStatus(403, 'GET', `/files/not-a-uuid?${query}`);
    await expectStatus(400, 'GET', `${url}&variant=12`);
    await expectStatus(200, 'GET', `${url}&variant=96`);
  });
});

describe('uploads (P14): 400 form → 413 → 404/403 → 415', () => {
  it('form errors', async () => {
    const t = await mock.login('petrov@agrotrace.test');
    const dup = await expectStatus(400, 'PUT', '/me/avatar', { token: t, form: form([['file', webp, 'a.webp'], ['file', webp, 'b.webp']]) });
    expect(dup.body.errors).toEqual({ file: ['validation.duplicate'] });
    const extra = await expectStatus(400, 'PUT', '/me/avatar', { token: t, form: form([['file', webp, 'a.webp'], ['note', 'x']]) });
    expect(extra.body.errors).toEqual({ note: ['validation.unknownField'] });
    const empty = await expectStatus(400, 'PUT', '/me/avatar', { token: t, form: form([['file', new Uint8Array(0), 'a.webp']]) });
    expect(empty.body.errors).toEqual({ file: ['validation.required'] });
    const long = await expectStatus(400, 'PUT', '/me/avatar', { token: t, form: form([['file', webp, `dir/${'я'.repeat(256)}.webp`]]) });
    expect(long.body.errors).toEqual({ file: ['validation.maxLength'] });
    const json = await expectStatus(400, 'PUT', '/me/avatar', { token: t, body: { file: 'x' } });
    expect(json.body.errors).toEqual({ file: ['validation.required'] });
    const broken = await expectStatus(400, 'PUT', '/me/avatar', {
      token: t,
      rawBody: '--b\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nabc',
      headers: { 'Content-Type': 'multipart/form-data; boundary=b' },
    });
    expect(broken.body.errors).toEqual({ _root: ['validation.invalid'] });
    const base = await expectStatus(200, 'PUT', '/me/avatar', { token: t, form: form([['file', webp, 'C:\\photos\\me.webp']]) });
    expect(base.body.originalName).toBe('me.webp');
  });

  it('413 before the entity checks, 404/403 before 415', async () => {
    const admin = await mock.login('admin@agrotrace.test');
    const big = await expectStatus(413, 'PUT', `/dictionaries/products/${UNKNOWN}/image`, { token: admin, form: form([['file', new Uint8Array(5 * 1024 * 1024 + 1), 'p.webp']]) });
    expect(big.body.params).toEqual({ maxBytes: 5242880 });
    await expectStatus(404, 'PUT', `/dictionaries/products/${UNKNOWN}/image`, { token: admin, form: form([['file', enc('not an image'), 'p.txt']]) });
    const lavka = await mock.login('lavka.head@agrotrace.test');
    const molkombinat = mock.api.store.t.organizations.find((o) => o.name.includes('Молкомбинат'))!;
    await expectStatus(403, 'PUT', `/organizations/${molkombinat.id}/logo`, { token: lavka, form: form([['file', enc('not an image'), 'l.txt']]) });
  });

  it('SVG: allowlist, declarations, encoding, namespace, complexity (P15, P18)', async () => {
    const t = await mock.login('lavka.head@agrotrace.test');
    const own = mock.api.store.t.users.find((u) => u.email === 'lavka.head@agrotrace.test')!.organization_id;
    const put = (svg: string | Uint8Array) =>
      call('PUT', `/organizations/${own}/logo`, { token: t, form: form([['file', typeof svg === 'string' ? enc(svg) : svg, 'l.svg']]) });
    const NS = 'xmlns="http://www.w3.org/2000/svg"';
    for (const bad of [
      `<svg ${NS}><style>*{}</style></svg>`,
      `<svg ${NS}><use href="#a"/></svg>`,
      `<svg ${NS}><foreignObject/></svg>`,
      `<svg ${NS}><animate attributeName="x"/></svg>`,
      `<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}>&x;</svg>`,
      `<svg xmlns="http://example.com/other"/>`,
      `<s:svg xmlns:s="http://www.w3.org/2000/svg"/>`,
      `<svg ${NS}><g></svg>`,
      `<svg ${NS}><text>&#x110000;</text></svg>`,
      `<svg ${NS}><text>&#0;</text></svg>`,
      `<svg ${NS}><text>a & b</text></svg>`,
      `<svg ${NS}><text>]]></text></svg>`,
      `<svg ${NS}><rect q:x="1"/></svg>`,
    ]) {
      const r = await put(bad);
      expect(r.status, bad).toBe(415);
      expect(r.body.params.reason).toBeUndefined();
    }
    const latin1 = new Uint8Array([...enc(`<svg ${NS}><title>`), 0xe9, ...enc('</title></svg>')]);
    expect((await put(latin1)).status).toBe(415);
    const deep = `<svg ${NS}>${'<g>'.repeat(70)}${'</g>'.repeat(70)}</svg>`;
    const tooComplex = await put(deep);
    expect(tooComplex.status).toBe(415);
    expect(tooComplex.body.params.reason).toBe('svg-too-complex');
    const many = `<svg ${NS}>${'<rect/>'.repeat(5001)}</svg>`;
    expect((await put(many)).body.params.reason).toBe('svg-too-complex');
    const ok = await put(`<svg ${NS} viewBox="0 0 1 1"><!-- c --><a href="https://x.example"><rect fill="url(#g)" onload="x()"/></a><text>A &amp; B</text></svg>`);
    expect(ok.status).toBe(200);
    const served = await expectStatus(200, 'GET', `/organizations/${own}/logo`, { token: t });
    expect(served.text).toContain('fill="url(#g)"');
    expect(served.text).not.toContain('onload');
    expect(served.text).not.toContain('https://x.example');
    expect(served.text).toContain('A &amp; B');
    expect(ok.body.sizeBytes).toBe(served.bytes.length);
  });
});

describe('admin, dictionaries, SSE, headers', () => {
  it('approveOrganization: an id that is not a uuid is 404 (no 400, P23)', async () => {
    const admin = await mock.login('admin@agrotrace.test');
    await expectStatus(404, 'POST', '/admin/organizations/not-a-uuid/approve', { token: admin });
  });

  it('XLSX over the P23 limits → 415 workbook-too-large', async () => {
    const admin = await mock.login('admin@agrotrace.test');
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    };
    for (let i = 0; i < 70; i++) files[`x/${i}.xml`] = strToU8('x');
    const r = await expectStatus(415, 'POST', '/dictionaries/regions/import', { token: admin, form: form([['file', zipSync(files), 'r.xlsx']]) });
    expect(r.body.params.reason).toBe('workbook-too-large');
    const cells = Array.from({ length: 70 }, (_, i) => `<c r="${String.fromCharCode(65 + (i % 26))}${i >= 26 ? '' : ''}2" t="inlineStr"><is><t>x</t></is></c>`).join('');
    const wide: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row r="1"><c r="BZ1" t="inlineStr"><is><t>x</t></is></c></row>${cells}</sheetData></worksheet>`),
    };
    const w = await expectStatus(415, 'POST', '/dictionaries/regions/import', { token: admin, form: form([['file', zipSync(wide), 'r.xlsx']]) });
    expect(w.body.params.reason).toBe('workbook-too-large');
  });

  it('SSE: a Last-Event-ID that is not a sequence number is ignored (no undeclared 400)', async () => {
    const t = await mock.login('inspector@agrotrace.test');
    const res = await mock.api.handle(new Request(`${BASE}/events/stream?access_token=${t}&lastEventId=abc`));
    expect(res.status).toBe(200);
    expect(mock.api.openStreams).toBe(1);
    await res.body!.cancel();
    expect(mock.api.openStreams).toBe(0);
  });

  it('X-Request-Id and X-Backend on every response; the request id lands in the audit row', async () => {
    const r = await call('GET', '/nope', { noValidate: true, headers: { 'X-Request-Id': 'probe-123' } });
    expect(r.headers.get('X-Request-Id')).toBe('probe-123');
    expect(r.headers.get('X-Backend')).toBe('express');
    const bad = await call('GET', '/health/live', { headers: { 'X-Request-Id': 'bad id!' } });
    expect(bad.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    const t = await mock.login('petrov@agrotrace.test');
    await expectStatus(200, 'PATCH', '/me', { token: t, body: { fullName: 'Петров И. С.' }, headers: { 'X-Request-Id': 'audit-req-1' } });
    const row = mock.api.store.t.audit_log.at(-1)!;
    expect(row).toMatchObject({ action: 'updateMe', request_id: 'audit-req-1', backend: 'express' });
  });

  it('a body equal to the field changes nothing (P23): no audit row, updatedAt kept', async () => {
    const t = await mock.login('petrov@agrotrace.test');
    const f = (await expectStatus(200, 'GET', '/fields', { token: t })).body.items[0];
    const before = mock.api.store.t.audit_log.length;
    const row = mock.api.store.t.fields.find((x) => x.id === f.id)!;
    const updated = row.updated_at;
    mock.advance(60_000);
    await expectStatus(200, 'PUT', `/fields/${f.id}`, { token: t, body: { name: f.name, areaHa: f.areaHa, regionCode: f.region.code, geometry: f.geometry } });
    expect(mock.api.store.t.audit_log.length).toBe(before);
    expect(row.updated_at).toBe(updated);
  });
});
