/**
 * Units of the file pipeline that HTTP cannot isolate: type sniffing, the SVG sanitizer on hostile input, raster
 * variants, the contract's Content-Disposition example, If-None-Match matching; and createTelegramCode without a bot
 * token (503 — the api-test stand always has one).
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { AppProblem } from '../src/http/problem.js';
import { rasterVariants, sniff } from '../src/infra/images.js';
import { cleanStyle, safeCssAttribute, sanitizeSvgText } from '../src/infra/svg-sanitize.js';
import { SanitizerQueue, sanitizeSvg, scanSvg, type SanitizerEngine } from '../src/infra/svg.js';
import { contentDisposition, ifNoneMatch } from '../src/modules/files/download.js';
import { meService } from '../src/modules/me/service.js';
import { testConfig } from './helpers.js';

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#7a5' } })
    .png()
    .toBuffer();

describe('sniff — by content only', () => {
  it('recognizes JPEG, PNG, WebP, PDF and SVG by their signatures; anything else is null', async () => {
    const base = sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } });
    expect(sniff(await base.clone().jpeg().toBuffer())).toBe('image/jpeg');
    expect(sniff(await base.clone().png().toBuffer())).toBe('image/png');
    expect(sniff(await base.clone().webp().toBuffer())).toBe('image/webp');
    expect(sniff(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniff(Buffer.from('﻿<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg>\n<svg xmlns="x"/>'))).toBe(
      'image/svg+xml',
    );
    expect(sniff(Buffer.from('<svgx/>'))).toBeNull();
    expect(sniff(Buffer.from('<html><svg/></html>'))).toBeNull();
    expect(sniff(Buffer.from('just text'))).toBeNull();
    expect(sniff(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0x00]))).toBeNull(); // "<svg " + NUL: binary
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });
});

describe('rasterVariants', () => {
  it('WebP 96 and 480 on the longer side, never enlarged; a forged signature → null', async () => {
    const big = await rasterVariants(await png(1000, 500), 'image/png');
    expect(big).not.toBeNull();
    expect(await sharp(big![480].body).metadata()).toMatchObject({ format: 'webp', width: 480, height: 240 });
    expect(await sharp(big![96].body).metadata()).toMatchObject({ format: 'webp', width: 96, height: 48 });
    const small = await rasterVariants(await png(50, 80), 'image/png');
    expect(await sharp(small![480].body).metadata()).toMatchObject({ width: 50, height: 80 });
    expect(
      await rasterVariants(Buffer.from('\x89PNG\r\n\x1a\nnot an image', 'latin1'), 'image/png'),
    ).toBeNull();
    // A JPEG whose signature was trusted as PNG is refused: the decoder's format must match.
    const jpeg = await sharp(await png(10, 10))
      .jpeg()
      .toBuffer();
    expect(await rasterVariants(jpeg, 'image/png')).toBeNull();
  });
});

describe('scanSvg — streaming pre-scan before any DOM (P15, P18)', () => {
  const nested = (n: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(n - 1)}${'</g>'.repeat(n - 1)}</svg>`;
  const flat = (n: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(n - 1)}</svg>`;
  const why = (s: string) => {
    const r = scanSvg(s);
    return r.ok ? null : `${r.tooComplex ? 'complex: ' : ''}${r.why}`;
  };

  it('depth ≤ 64 and ≤ 5 000 elements pass; one more is too complex; no DOCTYPE; terminated constructs only', () => {
    expect(why(nested(64))).toBeNull();
    expect(why(nested(65))).toMatch(/complex: .*deep/);
    expect(why(flat(5000))).toBeNull();
    expect(why(flat(5001))).toMatch(/complex: too many elements/);
    expect(why('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>')).toMatch(/declaration/);
    expect(why('<?xml version="1.0"?><!-- a > b --><svg a=">" b=\'/g\'/>')).toBeNull();
    expect(why('<svg><![CDATA[<g><g>]]></svg>')).toBeNull();
    expect(why('<svg><!-- never closed')).toMatch(/comment/);
    expect(why('<svg a="unterminated>')).toMatch(/attribute value/);
    expect(why('</g><svg/>')).toMatch(/unbalanced/);
    expect(why('<svg><g>')).toMatch(/unclosed/);
    expect(why('text only')).toMatch(/no element/);
  });

  it('element allowlist: script, style, foreignObject, use, animation, prefixed names → refused (not complex)', () => {
    for (const el of [
      'script',
      'style',
      'foreignObject',
      'use',
      'set',
      'animate',
      'feImage',
      'svg:rect',
      'RECT',
    ])
      expect(why(`<svg xmlns="http://www.w3.org/2000/svg"><${el}/></svg>`), el).toMatch(
        /^element .* not allowed/,
      );
    expect(why('<s:svg xmlns:s="http://www.w3.org/2000/svg"/>')).toMatch(/not allowed/);
    expect(
      why(
        '<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="g"><stop/></linearGradient><feGaussianBlur/></svg>',
      ),
    ).toBeNull();
  });

  it('attribute limits: 100 per element, 20 000 in all, 32 namespace declarations, 64 KiB per value', () => {
    const attrs = (k: number, prefix = 'a') =>
      Array.from({ length: k }, (_, i) => ` ${prefix}${i}="1"`).join('');
    expect(why(`<svg${attrs(100)}/>`)).toBeNull();
    expect(why(`<svg${attrs(101)}/>`)).toMatch(/complex: too many attributes on an element/);
    const rects = `<rect${attrs(100)}/>`.repeat(200); // 20 000 attributes + the root's none
    expect(why(`<svg>${rects}</svg>`)).toBeNull();
    expect(why(`<svg a="1">${rects}</svg>`)).toMatch(/complex: too many attributes$/);
    expect(why(`<svg${attrs(32, 'xmlns:n')}/>`)).toBeNull();
    expect(why(`<svg${attrs(33, 'xmlns:n')}/>`)).toMatch(/complex: too many namespace/);
    expect(why(`<svg d="${'1'.repeat(64 * 1024)}"/>`)).toBeNull();
    expect(why(`<svg d="${'1'.repeat(64 * 1024 + 1)}"/>`)).toMatch(/complex: attribute value too long/);
    expect(why('<svg a=1/>')).toMatch(/unquoted/);
    expect(why('<svg a/>')).toMatch(/without a value/);
  });

  it('a 10 000-deep document is refused in milliseconds, without touching a DOM', async () => {
    const started = Date.now();
    expect(await sanitizeSvg(Buffer.from(nested(10000)))).toEqual({ ok: false, reason: 'too-complex' });
    expect(Date.now() - started).toBeLessThan(200);
    expect(await sanitizeSvg(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]))).toEqual({
      ok: false,
      reason: 'invalid',
    }); // not UTF-8
  });
});

describe('cleanStyle / safeCssAttribute (P17, P20)', () => {
  it('style keeps allowlisted presentation properties with plain values only', () => {
    expect(cleanStyle('fill: #fff; stroke:red;font-family: Onest, sans-serif ;opacity:.5')).toBe(
      'fill: #fff; stroke: red; font-family: Onest, sans-serif; opacity: .5',
    );
    expect(cleanStyle('fill:url(#g)')).toBe('');
    expect(cleanStyle('background:url(http://e/x); fill:red')).toBe('fill: red');
    expect(cleanStyle('fill: \\75 rl(x); stroke: image-set("a.png" 1x); font-family: @x; display:none')).toBe(
      'display: none',
    );
    expect(cleanStyle('fill: expression(alert(1)); stroke: blue')).toBe('stroke: blue');
    expect(cleanStyle('behavior: url(x.htc); position: fixed')).toBe('');
  });

  it('CSS-parsed attributes: no backslash, only url(#id)', () => {
    expect(safeCssAttribute('url(#g)')).toBe(true);
    expect(safeCssAttribute('url( #grad-1 ) red')).toBe(true);
    expect(safeCssAttribute('#D9B650')).toBe(true);
    expect(safeCssAttribute('url(http://e/x)')).toBe(false);
    expect(safeCssAttribute("url('#g')")).toBe(false);
    expect(safeCssAttribute('u\\72l(http://e/x)')).toBe(false);
    expect(safeCssAttribute('URL(#g) url(//e/x)')).toBe(false);
    expect(safeCssAttribute('expression(alert(1))')).toBe(false);
  });
});

describe('SVG sanitizing — the DOM stage the worker runs', () => {
  // The worker thread itself runs in tests/api (built image); from sources it would load jsdom through tsx, far too
  // slow for a unit test, so the DOM stage is called directly — also on documents the pre-scan would refuse, to
  // prove the defence in depth.
  const clean = async (s: string) => sanitizeSvgText(s);

  it('removes scripts, handlers, foreignObject, style elements, animation, external references', async () => {
    const out =
      (await clean(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()">
      <script>alert(1)</script><style>@import url(http://e/x.css)</style>
      <foreignObject><body xmlns="http://www.w3.org/1999/xhtml" onload="y()"/></foreignObject>
      <a href="javascript:alert(1)"><circle r="1" onclick="z()"/></a>
      <a xlink:href="https://evil.example/"><rect width="1" height="1"/></a>
      <image href="https://evil.example/t.png"/><image href="data:image/png;base64,iVBORw0KGgo="/>
      <use href="https://evil.example/s.svg#i"/><rect style="fill:url(https://e/x)" filter="url(#f)" mask="url(http://e/m)"/>
      <rect style="fill: #D9B650; background-image: url(https://e/y)" fill="u&#x5c;72l(x)" stroke="&#117;rl(http://e/z)"/>
      <set attributeName="onclick" to="alert(1)"/><animate attributeName="href" to="javascript:alert(1)"/>
    </svg>`))!;
    expect(out).not.toBeNull();
    for (const bad of [
      'script',
      'onload',
      'onclick',
      'javascript',
      'evil.example',
      'foreignObject',
      '<style',
      '@import',
      'http://e',
      'https://e',
      '<set',
      '<animate',
      'background',
      '\\',
      'stroke=',
    ])
      expect(out, bad).not.toContain(bad);
    expect(out).toContain('filter="url(#f)"');
    expect(out).toContain('style="fill: #D9B650"');
    expect(out).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('keeps an ordinary logo intact (case-sensitive SVG names, text, url(#id) paint)', async () => {
    const out = (await clean(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="9" height="9"/></clipPath></defs><rect fill="url(#g)" clip-path="url(#c)" width="96" height="96"/><text x="1" y="2">Лого &amp; Ко</text></svg>',
    ))!;
    for (const kept of [
      'viewBox="0 0 96 96"',
      '<linearGradient id="g">',
      '<clipPath id="c">',
      'fill="url(#g)"',
      'clip-path="url(#c)"',
      'Лого &amp; Ко',
    ])
      expect(out).toContain(kept);
  });

  it('refuses what is not a safe, well-formed SVG document', async () => {
    expect(await clean('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>')).toBeNull(); // not well-formed
    expect(await clean('<svg><rect/></svg>')).toBeNull(); // not in the SVG namespace
    expect(await clean('<s:svg xmlns:s="http://www.w3.org/2000/svg"/>')).toBeNull(); // namespaced root
    expect(await clean('<html xmlns="http://www.w3.org/1999/xhtml"/>')).toBeNull();
    expect(
      await clean('<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ).toBeNull();
  });
});

describe('SanitizerQueue — bounded, with deadlines, aborts and a replaceable engine (P18)', () => {
  /** A stub engine: `run` answers after `delayMs` (never, when null); records terminations. */
  function stubs(delayMs: number | null, readyMs = 0) {
    const log = { created: 0, terminated: 0, ran: [] as string[] };
    const factory = (): SanitizerEngine => {
      log.created += 1;
      let dead = false;
      let fail: ((e: Error) => void) | null = null;
      return {
        ready: new Promise((r) => setTimeout(r, readyMs)),
        run: (text) =>
          new Promise((resolve, reject) => {
            fail = reject;
            log.ran.push(text);
            if (delayMs !== null) setTimeout(() => !dead && resolve(`<svg>${text}</svg>`), delayMs);
          }),
        terminate: () => {
          dead = true;
          log.terminated += 1;
          fail?.(new Error('terminated'));
        },
      };
    };
    return { log, factory };
  }

  it('a job past its deadline is refused and its engine terminated; the next job gets a fresh engine', async () => {
    const { log, factory } = stubs(null); // hangs forever
    // deadline 300 ms > the first back-off (100 ms), so the second job does reach a fresh engine
    const q = new SanitizerQueue(factory, { maxWaiting: 8, deadlineMs: 300 });
    const started = Date.now();
    expect(await q.run('a')).toEqual({ ok: false, reason: 'too-complex' });
    expect(Date.now() - started).toBeLessThan(900);
    expect(log.terminated).toBe(1);
    expect(q.size).toBe(0);
    await q.run('b'); // also hangs → deadline, after the back-off a second engine was created
    expect(log.created).toBe(2);
  });

  it('1 running + 8 waiting; the 10th job is refused at once; the deadline counts waiting time', async () => {
    const { factory } = stubs(60);
    const q = new SanitizerQueue(factory, { maxWaiting: 8, deadlineMs: 250 });
    const jobs = Array.from({ length: 10 }, (_, i) => q.run(`j${i}`));
    expect(await jobs[9]).toEqual({ ok: false, reason: 'too-complex' }); // overflow
    const results = await Promise.all(jobs.slice(0, 9));
    const done = results.filter((r) => r.ok).length;
    // 60 ms each, 250 ms budget from enqueue: the first few finish, the rest time out while waiting.
    expect(done).toBeGreaterThanOrEqual(3);
    expect(done).toBeLessThan(9);
    for (const r of results.filter((x) => !x.ok)) expect(r).toEqual({ ok: false, reason: 'too-complex' });
    expect(q.size).toBe(0);
  });

  it('a client abort never terminates the engine nor causes a back-off (P21)', async () => {
    const { log, factory } = stubs(100);
    const q = new SanitizerQueue(factory, { maxWaiting: 8, deadlineMs: 3000 });
    const running = new AbortController();
    const waiting = new AbortController();
    const first = q.run('first', running.signal);
    const second = q.run('second', waiting.signal);
    const third = q.run('third');
    await new Promise((r) => setTimeout(r, 20)); // `first` is running on the engine
    waiting.abort();
    expect(await second).toEqual({ ok: false, reason: 'aborted' });
    running.abort();
    expect(await first).toEqual({ ok: false, reason: 'aborted' });
    const started = Date.now();
    // `first` runs to completion on the same engine (result dropped), then `third` — no restart, no back-off.
    expect(await third).toEqual({ ok: true, svg: '<svg>third</svg>' });
    expect(Date.now() - started).toBeLessThan(400);
    expect(log.terminated).toBe(0);
    expect(log.created).toBe(1);
    expect(log.ran).toEqual(['first', 'third']); // the aborted waiting job never ran
    // Many aborted uploads in a row still cost the others nothing.
    for (let i = 0; i < 5; i++) {
      const ac = new AbortController();
      const p = q.run(`gone${i}`, ac.signal);
      ac.abort();
      expect(await p).toEqual({ ok: false, reason: 'aborted' });
    }
    expect(await q.run('legit')).toEqual({ ok: true, svg: '<svg>legit</svg>' });
    expect(log.terminated).toBe(0);
    expect(log.created).toBe(1);
  });

  it('the waiting bound holds while the engine is being replaced (back-off)', async () => {
    const { log, factory } = stubs(null); // hangs: the first job's deadline kills the engine
    const q = new SanitizerQueue(factory, { maxWaiting: 3, deadlineMs: 150 });
    expect(await q.run('hang')).toEqual({ ok: false, reason: 'too-complex' });
    expect(log.terminated).toBe(1);
    // No engine now, back-off pending: only 3 may wait, the 4th is refused at once.
    const queued = [q.run('a'), q.run('b'), q.run('c')];
    expect(q.size).toBe(3);
    expect(await q.run('d')).toEqual({ ok: false, reason: 'too-complex' });
    expect(q.size).toBe(3);
    await Promise.all(queued);
  });

  it('the start-up of a respawned engine is not charged to the job running on it', async () => {
    // Every engine needs 250 ms to start; the deadline is 200 ms. The job waits for start-up with its clock paused
    // and still completes (runs 20 ms).
    const { log, factory } = stubs(20, 250);
    const q = new SanitizerQueue(factory, { maxWaiting: 8, deadlineMs: 200 });
    expect(await q.run('first')).toEqual({ ok: true, svg: '<svg>first</svg>' });
    expect(log.created).toBe(1);
  });
});

describe('Content-Disposition (components.headers.ContentDisposition)', () => {
  it('reproduces the contract example and its rules', () => {
    expect(contentDisposition('петров.jpg', 'webp')).toBe(
      `inline; filename="______.webp"; filename*=UTF-8''%D0%BF%D0%B5%D1%82%D1%80%D0%BE%D0%B2.webp`,
    );
    expect(contentDisposition('a "b"\\c (1).png', 'webp')).toBe(
      `inline; filename="a _b__c (1).webp"; filename*=UTF-8''a%20%22b%22%5Cc%20%281%29.webp`,
    );
    expect(contentDisposition('archive.tar.gz', 'pdf')).toBe(
      `inline; filename="archive.tar.pdf"; filename*=UTF-8''archive.tar.pdf`,
    );
    expect(contentDisposition('.hidden', 'svg')).toBe(
      `inline; filename=".hidden.svg"; filename*=UTF-8''.hidden.svg`,
    );
    expect(contentDisposition('noext', 'png')).toBe(
      `inline; filename="noext.png"; filename*=UTF-8''noext.png`,
    );
  });
});

describe('If-None-Match', () => {
  const tag = '"ab"';
  it.each([
    ['"ab"', true],
    ['W/"ab"', true],
    ['"x", "ab"', true],
    ['*', true],
    ['"abc"', false],
    ['', false],
  ])('%s → %s', (header, expected) => {
    expect(ifNoneMatch(header, tag)).toBe(expected);
  });
});

describe('createTelegramCode without a bot token', () => {
  it('503 EXTERNAL_UNAVAILABLE {service: telegram}, nothing written', async () => {
    const c = { config: testConfig } as unknown as Container;
    const err = await meService(c)
      .createTelegramCode({ userId: 'u', orgId: 'o', roles: ['FARMER'], orgAdmin: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppProblem);
    expect((err as AppProblem).status).toBe(503);
    expect((err as AppProblem).body()).toMatchObject({
      code: 'EXTERNAL_UNAVAILABLE',
      params: { service: 'telegram' },
    });
  });
});
