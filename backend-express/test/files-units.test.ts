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
import { sanitizeSvg } from '../src/infra/svg.js';
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

describe('sanitizeSvg', () => {
  const clean = (s: string) => sanitizeSvg(Buffer.from(s, 'utf8'))?.toString('utf8') ?? null;

  it('removes scripts, handlers, foreignObject, style elements, animation, external references', () => {
    const out =
      clean(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()">
      <script>alert(1)</script><style>@import url(http://e/x.css)</style>
      <foreignObject><body xmlns="http://www.w3.org/1999/xhtml" onload="y()"/></foreignObject>
      <a href="javascript:alert(1)"><circle r="1" onclick="z()"/></a>
      <a xlink:href="https://evil.example/"><rect width="1" height="1"/></a>
      <image href="https://evil.example/t.png"/><image href="data:image/png;base64,iVBORw0KGgo="/>
      <use href="https://evil.example/s.svg#i"/><rect style="fill:url(https://e/x)" filter="url(#f)" mask="url(http://e/m)"/>
      <set attributeName="onclick" to="alert(1)"/><animate attributeName="href" to="javascript:alert(1)"/>
    </svg>`)!;
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
    ])
      expect(out, bad).not.toContain(bad);
    expect(out).toContain('filter="url(#f)"');
    expect(out).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('keeps an ordinary logo intact (case-sensitive SVG names, text)', () => {
    const out = clean(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="9" height="9"/></clipPath></defs><rect fill="url(#g)" clip-path="url(#c)" width="96" height="96"/><text x="1" y="2">Лого &amp; Ко</text></svg>',
    )!;
    for (const kept of [
      'viewBox="0 0 96 96"',
      '<linearGradient id="g">',
      '<clipPath id="c">',
      'clip-path="url(#c)"',
      'Лого &amp; Ко',
    ])
      expect(out).toContain(kept);
  });

  it('refuses what is not a safe, well-formed SVG document', () => {
    expect(clean('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>')).toBeNull(); // not well-formed
    expect(clean('<svg><rect/></svg>')).toBeNull(); // not in the SVG namespace
    expect(clean('<html xmlns="http://www.w3.org/1999/xhtml"/>')).toBeNull();
    expect(
      clean(
        '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"><text>&a;</text></svg>',
      ),
    ).toBeNull();
    expect(sanitizeSvg(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]))).toBeNull(); // not UTF-8
    expect(
      clean('<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ).toBeNull();
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
