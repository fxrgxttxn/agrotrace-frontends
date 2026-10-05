import type { Schemas } from '@agrotrace/api-client';

export type Polygon = Schemas['GeoJsonPolygon'];

export interface MapField {
  id: string;
  name: string;
  geometry: Polygon | null;
}

export interface YEntity {
  addChild(child: unknown): YEntity;
  destroy?(): void;
}
export interface Ymaps3 {
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

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
