import { useEffect, useRef, useState } from 'react';
import type { Schemas } from '@agrotrace/api-client';
import { t } from '../app/i18n';
import { Button } from '../ui';
import { useFullscreen, useThemeVersion } from '../ui/fullscreen';

// Field outlines on Yandex Maps JS API 3.0 (spec §9.1). Only when the build has a key (`VITE_YANDEX_MAPS_API_KEY`,
// from YANDEX_MAPS_API_KEY in .env); without one the screens show the table alone. The API script is loaded on first
// use from api-maps.yandex.ru (the gateway CSP must allow it: script-src, connect-src, img-src — see the task report).
// The container is the design system's full-screen canvas block (`at-graph` markup: canvas, toolbar); below 768 px
// the map opens full screen from a button, Esc or «Закрыть карту» leave it.

type Polygon = Schemas['GeoJsonPolygon'];

export interface MapField {
  id: string;
  name: string;
  geometry: Polygon | null;
}

/* Minimal surface of ymaps3 used here. */
interface YEntity {
  addChild(child: unknown): YEntity;
  destroy?(): void;
}
interface Ymaps3 {
  ready: Promise<void>;
  YMap: new (el: HTMLElement, props: { location: { bounds: [number, number][] } }) => YEntity;
  YMapDefaultSchemeLayer: new (props?: object) => unknown;
  YMapDefaultFeaturesLayer: new (props?: object) => unknown;
  YMapFeature: new (props: { geometry: Polygon; style: object }) => unknown;
}
declare global {
  interface Window {
    ymaps3?: Ymaps3;
  }
}

export function mapsKey(): string {
  return (import.meta.env.VITE_YANDEX_MAPS_API_KEY as string | undefined) ?? '';
}

let loading: Promise<Ymaps3> | null = null;

/** Loads the API once (a script element; resolves when `ymaps3.ready`). */
export function loadYmaps(key: string): Promise<Ymaps3> {
  if (window.ymaps3) return window.ymaps3.ready.then(() => window.ymaps3!);
  loading ??= new Promise<Ymaps3>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=ru_RU`;
    script.onload = () => {
      if (!window.ymaps3) return reject(new Error('ymaps3 missing'));
      window.ymaps3.ready.then(() => resolve(window.ymaps3!), reject);
    };
    script.onerror = () => {
      loading = null;
      reject(new Error('ymaps3 failed to load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** `[[minLon, minLat], [maxLon, maxLat]]` of the outer rings. */
export function boundsOf(polygons: Polygon[]): [number, number][] | null {
  let box: [number, number, number, number] | null = null;
  for (const p of polygons)
    for (const [lon, lat] of p.coordinates[0] ?? []) {
      if (lon === undefined || lat === undefined) continue;
      box = box
        ? [Math.min(box[0], lon), Math.min(box[1], lat), Math.max(box[2], lon), Math.max(box[3], lat)]
        : [lon, lat, lon, lat];
    }
  return box
    ? [
        [box[0], box[1]],
        [box[2], box[3]],
      ]
    : null;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function MapCanvas({ fields, label }: { fields: MapField[]; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const theme = useThemeVersion();
  const shape = JSON.stringify(fields.map((f) => [f.id, f.geometry]));
  useEffect(() => {
    const polygons = fields.flatMap((f) => (f.geometry ? [f.geometry] : []));
    const bounds = boundsOf(polygons);
    if (!el.current || !bounds) return;
    let map: YEntity | null = null;
    let cancelled = false;
    loadYmaps(mapsKey()).then(
      (y) => {
        if (cancelled || !el.current) return;
        map = new y.YMap(el.current, { location: { bounds } });
        map.addChild(new y.YMapDefaultSchemeLayer());
        map.addChild(new y.YMapDefaultFeaturesLayer());
        const stroke = token('--c-field');
        const fill = token('--c-straw-soft');
        for (const geometry of polygons)
          map.addChild(
            new y.YMapFeature({
              geometry,
              style: { stroke: [{ color: stroke, width: 2 }], fill, fillOpacity: 0.5 },
            }),
          );
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
      map?.destroy?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redrawn when the outlines change, not on every new array
  }, [shape, theme]);
  return (
    <div
      className="at-graph__canvas"
      role="img"
      aria-label={failed ? t('maps.failed') : label}
      ref={el}
    ></div>
  );
}

/** The map of `fields` (nothing when there is no key or no outline). */
export function FieldMap({ fields }: { fields: MapField[] }) {
  const { full, wide, open, close, opener, closer } = useFullscreen();
  const withOutline = fields.filter((f) => f.geometry);
  if (!mapsKey() || withOutline.length === 0) return null;
  const label = t('maps.fields', { names: withOutline.map((f) => f.name).join(', ') });
  if (!wide && !full)
    return (
      <Button ref={opener} icon="map" onClick={open}>
        {t('maps.open')}
      </Button>
    );
  return (
    <div className="at-graph" data-fullscreen={full ? '' : undefined}>
      <MapCanvas fields={withOutline} label={label} />
      {full && (
        <div className="at-graph__toolbar">
          <Button
            variant="ghost"
            size="s"
            iconOnly
            ref={closer}
            icon="close"
            aria-label={t('maps.close')}
            onClick={close}
          />
        </div>
      )}
    </div>
  );
}
