import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/angular';
import { PageToolbarComponent, ToolbarFiltersDirective } from '../../src/app/ui';
import { graphElements, graphStyle, kebab, type BatchGraph } from '../../src/graph/elements';
import { boundsOf, FieldMapComponent, MAPS_KEY, mappable } from '../../src/maps/field-map';
import { normalizeDecimal } from '../../src/app/forms';
import { parseGeometry, prettyGeometry } from '../../src/app/geometry';
import { listGap, sanitizeParams } from '../../src/app/list-state';
import { momentCheck, momentWire } from '../../src/app/moment';
import { localToInstant } from '../../src/app/dates';
import { contractExample } from '../msw/fromContract';
import { canonical, canonicalHtml, readmeBlock } from './readme';
import { renderProd, useProductionDom } from './prod-dom';

useProductionDom();

const wide = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

const TOOLBAR = [PageToolbarComponent, ToolbarFiltersDirective];

describe('README markup contract: page toolbar', () => {
  it('search + filters (open on ≥ 768 px, count with its hidden prefix)', () => {
    wide(true);
    const f = renderProd(
      `<div class="at-page__toolbar" [search]="search" [count]="1"><ng-template atToolbarFilters><span></span></ng-template></div>`,
      TOOLBAR,
      { search: { label: 'Поиск партий', placeholder: 'Код, продукт', value: '' } },
    );
    const el = f.nativeElement as HTMLElement;
    el.querySelector('.at-page__filters-body')!.replaceChildren(
      document.createTextNode('…at-field со select / date…'),
    );
    const block = readmeBlock('Страница').match(
      /<div class="at-page__toolbar">[\s\S]*?<\/details>\n {2}<\/div>/,
    )![0];
    expect(canonical(el.childNodes)).toBe(canonicalHtml(block));
  });

  it('below 768 px the filters start closed; no count while nothing is chosen', () => {
    wide(false);
    const f = renderProd(
      `<div class="at-page__toolbar" [count]="0"><ng-template atToolbarFilters><span></span></ng-template></div>`,
      TOOLBAR,
    );
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('details')!.open).toBe(false);
    expect(el.querySelector('.at-page__filters-count')).toBeNull();
    expect(el.querySelector('summary')!.textContent).toBe('Фильтры');
  });
});

describe('graph elements', () => {
  const graph = contractExample('getBatchGraph').body as BatchGraph;

  it('status → token name', () => {
    expect(kebab('OnTest')).toBe('on-test');
    expect(kebab('WrittenOff')).toBe('written-off');
    expect(kebab('Recalled')).toBe('recalled');
  });

  it('nodes carry code, status, access and root; edges parent → child', () => {
    const els = graphElements(graph);
    expect(els.filter((e) => e.group === 'nodes').map((e) => e.data)).toEqual([
      { id: graph.nodes[0]!.id, label: 'AT-2026-000123', status: 'Processed', accessible: true, root: true },
      { id: graph.nodes[1]!.id, label: 'AT-2026-000457', status: 'OnSale', accessible: false, root: false },
    ]);
    expect(els.filter((e) => e.group === 'edges').map((e) => e.data)).toEqual([
      {
        id: `${graph.edges[0]!.parent}>${graph.edges[0]!.child}`,
        source: graph.edges[0]!.parent,
        target: graph.edges[0]!.child,
      },
    ]);
  });

  it('colours come from the status tokens; a node without access is dashed', () => {
    const style = graphStyle(graph, (name) => `var(${name})`);
    const sel = (s: string) => style.find((x) => x.selector === s)?.style as Record<string, unknown>;
    expect(sel('node[status = "OnSale"]')).toEqual({
      'background-color': 'var(--status-on-sale-bg)',
      color: 'var(--status-on-sale-fg)',
    });
    expect(sel('node[!accessible]')['border-style']).toBe('dashed');
  });
});

describe('field map', () => {
  const polygon = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [39.0, 45.0],
        [39.2, 45.0],
        [39.2, 45.1],
        [39.0, 45.0],
      ],
    ] as [number, number][][],
  };

  it('bounds of the outer rings', () => {
    expect(boundsOf([polygon])).toEqual([
      [39.0, 45.0],
      [39.2, 45.1],
    ]);
    expect(boundsOf([])).toBeNull();
  });

  it('without a key nothing is drawn and no script is loaded; only fields with an outline are drawn', () => {
    const fields = [
      { id: '1', name: 'Северное', geometry: polygon },
      { id: '2', name: 'Без контура', geometry: null },
    ];
    expect(mappable(fields, '')).toEqual([]);
    expect(mappable(fields, 'k').map((f) => f.id)).toEqual(['1']);
    expect(document.querySelector('script[src*="api-maps.yandex.ru"]')).toBeNull();
  });

  it('with a key: the outlines on Yandex Maps 3.0, fitted to their bounds', async () => {
    wide(true);
    const added: unknown[] = [];
    let bounds: unknown = null;
    class Entity {
      constructor(public props?: unknown) {}
    }
    class YMap {
      constructor(_el: HTMLElement, props: { location: { bounds: unknown } }) {
        bounds = props.location.bounds;
      }
      addChild(child: unknown) {
        added.push(child);
        return this;
      }
      destroy() {}
    }
    (window as { ymaps3?: unknown }).ymaps3 = {
      ready: Promise.resolve(),
      YMap,
      YMapDefaultSchemeLayer: Entity,
      YMapDefaultFeaturesLayer: Entity,
      YMapFeature: Entity,
    };
    const f = renderProd(
      `<div class="at-graph" [atFieldMap]="fields"></div>`,
      [FieldMapComponent],
      {
        fields: [
          { id: '1', name: 'Северное', geometry: polygon },
          { id: '2', name: 'Без контура', geometry: null },
        ],
      },
      [{ provide: MAPS_KEY, useValue: 'test-key' }],
    );
    f.autoDetectChanges(true);
    expect(screen.getByRole('img', { name: 'Карта полей: Северное' })).toBeInTheDocument();
    await waitFor(() => expect(added).toHaveLength(3));
    expect(bounds).toEqual([
      [39.0, 45.0],
      [39.2, 45.1],
    ]);
    expect((added[2] as Entity).props).toMatchObject({ geometry: polygon });
    delete (window as { ymaps3?: unknown }).ymaps3;
  });
});

describe('form helpers', () => {
  it('decimal text → wire format', () => {
    expect(normalizeDecimal('124,5', 2)).toBe('124.50');
    expect(normalizeDecimal('1.5', 3)).toBe('1.500');
    expect(normalizeDecimal('10', 2)).toBe('10.00');
    expect(normalizeDecimal('1,2345', 3)).toBe('1,2345');
    expect(normalizeDecimal('abc', 2)).toBe('abc');
  });

  it('GeoJSON outline: geometry, Feature, one-feature collection; anything else is rejected', () => {
    const p = { type: 'Polygon', coordinates: [] };
    expect(parseGeometry('')).toEqual({ ok: true, value: null });
    expect(parseGeometry(JSON.stringify(p))).toEqual({ ok: true, value: p });
    expect(parseGeometry(JSON.stringify({ type: 'Feature', geometry: p }))).toEqual({ ok: true, value: p });
    expect(
      parseGeometry(
        JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: p }] }),
      ),
    ).toEqual({ ok: true, value: p });
    expect(parseGeometry('{"type":"Point","coordinates":[1,2]}')).toEqual({ ok: false });
    expect(parseGeometry('null')).toEqual({ ok: false });
    expect(parseGeometry('{')).toEqual({ ok: false });
  });
});

describe('helpers', () => {
  it('sanitizeParams keeps what the list accepts, and other parameters of the screen', () => {
    const spec = {
      sort: ['massKg'],
      enums: { kind: ['RAW'], status: ['OnTest', 'Approved'] },
      uuids: ['orgId'],
      dates: ['from'],
      texts: ['q'],
    };
    const out = sanitizeParams(
      new URLSearchParams(
        'sort=massKg,desc&kind=X&status=OnTest&status=OnTest&status=Nope&orgId=1&from=2026-02-30&q=a&tab=docs&page=2',
      ),
      spec,
    );
    expect([...out].map(([k, v]) => `${k}=${v}`).sort()).toEqual([
      'page=2',
      'q=a',
      'sort=massKg,desc',
      'status=OnTest',
      'tab=docs',
    ]);
    expect(sanitizeParams(new URLSearchParams('page=1&sort=x,asc'), spec).toString()).toBe('');
  });

  it('a moment: local date + time → UTC instant; the edited instant is kept; not after now; time required', () => {
    const at = localToInstant('2026-07-18', '06:15')!;
    expect(at).toBe(new Date('2026-07-18T06:15:00').toISOString().replace('.000Z', 'Z'));
    expect(momentWire({ date: '2026-07-18', time: '06:15', original: null })).toBe(at);
    const original = new Date('2026-07-18T06:15:42').toISOString();
    expect(momentWire({ date: '2026-07-18', time: '06:15', original })).toBe(original);
    expect(momentWire({ date: null, time: '06:15', original: null })).toBeUndefined();
    expect(momentCheck({ date: '2026-07-18', time: '', original: null }, 'd', 't')).toEqual({
      t: 'validation.required',
    });
    expect(
      momentCheck({ date: '2026-07-18', time: '06:15', original: null }, 'd', 't', Date.parse(at) - 1),
    ).toEqual({ t: 'moment.timeFuture' });
    expect(
      momentCheck({ date: '2026-07-19', time: '00:10', original: null }, 'd', 't', Date.parse(at)),
    ).toEqual({ d: 'validation.date.future' });
    expect(
      momentCheck({ date: '2026-07-18', time: '06:15', original: null }, 'd', 't', Date.parse(at)),
    ).toEqual({});
  });

  it('the outline is shown pretty-printed, one position per line', () => {
    const p = {
      type: 'Polygon',
      coordinates: [
        [
          [39, 45.5],
          [-39.1, 45],
        ],
      ],
    };
    expect(prettyGeometry(p)).toBe(
      '{\n  "type": "Polygon",\n  "coordinates": [\n    [\n      [39, 45.5],\n      [-39.1, 45]\n    ]\n  ]\n}',
    );
  });
});

describe('regressions', () => {
  it('q longer than the contract allows (100 code points) is cut before the request', () => {
    const spec = { sort: [], texts: ['q'] };
    const long = `${'ё'.repeat(99)}😀xyz`;
    expect(sanitizeParams(new URLSearchParams({ q: long }), spec).get('q')).toBe(`${'ё'.repeat(99)}😀`);
    expect(sanitizeParams(new URLSearchParams({ q: 'abc' }), spec).get('q')).toBe('abc');
  });

  it('a page of an empty slice inside the list (items [] with total > 0 on a page ≤ last) is not «loading»', () => {
    expect(listGap({ items: [], total: 30 }, 1, 20)).toBe('changed');
    expect(listGap({ items: [], total: 30 }, 3, 20)).toBe('pastEnd');
    expect(listGap({ items: [1], total: 30 }, 1, 20)).toBe(null);
    expect(listGap({ items: [], total: 0 }, 1, 20)).toBe(null);
  });
});
