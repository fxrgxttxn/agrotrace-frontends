import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  InjectionToken,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { Schemas } from '@agrotrace/api-client';
import { t } from '../app/i18n';
import { ButtonComponent, injectThemeVersion, isolate, type Fullscreen } from '../app/ui';

declare const AT_MAPS_KEY: string | undefined;

export const MAPS_KEY = new InjectionToken<string>('MAPS_KEY', {
  providedIn: 'root',
  factory: () => (typeof AT_MAPS_KEY === 'string' ? AT_MAPS_KEY : ''),
});

type Polygon = Schemas['GeoJsonPolygon'];

export interface MapField {
  id: string;
  name: string;
  geometry: Polygon | null;
}

export function mappable<F extends MapField>(fields: readonly F[], key: string): F[] {
  return key ? fields.filter((f) => f.geometry) : [];
}

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
const ymaps = () => (window as { ymaps3?: Ymaps3 }).ymaps3;

let loading: Promise<Ymaps3> | null = null;

export function loadYmaps(key: string): Promise<Ymaps3> {
  const ready = ymaps();
  if (ready) return ready.ready.then(() => ymaps()!);
  loading ??= new Promise<Ymaps3>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=ru_RU`;
    script.onload = () => {
      const y = ymaps();
      if (!y) return reject(new Error('ymaps3 missing'));
      y.ready.then(() => resolve(y), reject);
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

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

@Component({
  selector: 'div.at-graph[atFieldMap]',
  standalone: true,
  imports: [ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (failed()) {
      <div class="at-graph__canvas">
        <p role="alert" style="margin: 0; padding: var(--sp-5)">{{ t('maps.failed') }}</p>
      </div>
    } @else {
      <div #canvas class="at-graph__canvas" role="img" [attr.aria-label]="label()"></div>
    }
    @if (fs()?.full()) {
      <div class="at-graph__toolbar">
        <button
          #closer
          class="at-button"
          [variant]="'ghost'"
          [size]="'s'"
          [iconOnly]="true"
          [icon]="'close'"
          [attr.aria-label]="t('maps.close')"
          (click)="fs()?.close()"
        ></button>
      </div>
    }`,
  host: { '[attr.data-fullscreen]': "fs()?.full() ? '' : null" },
})
export class FieldMapComponent {
  protected readonly t = t;
  readonly atFieldMap = input.required<MapField[]>();
  readonly fs = input<Fullscreen | undefined>(undefined);
  private readonly key = inject(MAPS_KEY);
  private readonly drawn = computed(() => this.atFieldMap().filter((f) => f.geometry));
  protected readonly label = computed(() =>
    t('maps.fields', {
      names: this.drawn()
        .map((f) => f.name)
        .join(', '),
    }),
  );
  protected readonly failed = signal(false);
  private readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');
  private readonly closer = viewChild('closer', { read: ElementRef });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private readonly theme = injectThemeVersion();
  private readonly shape = computed(() => JSON.stringify(this.drawn().map((f) => [f.id, f.geometry])));

  constructor() {
    let map: YEntity | null = null;
    let run = 0;
    effect(() => {
      const el = this.canvas()?.nativeElement;
      this.shape();
      this.theme();
      untracked(() => {
        const mine = ++run;
        map?.destroy?.();
        map = null;
        const polygons = this.drawn().flatMap((f) => (f.geometry ? [f.geometry] : []));
        const bounds = boundsOf(polygons);
        if (!el || !bounds || !this.key) return;
        loadYmaps(this.key).then(
          (y) => {
            if (mine !== run || !el.isConnected) return;
            map = new y.YMap(el, { location: { bounds } });
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
          () => {
            if (mine === run) this.failed.set(true);
          },
        );
      });
    });
    let undo: (() => void) | null = null;
    effect(() => {
      const full = this.fs()?.full() ?? false;
      untracked(() => {
        undo?.();
        undo = null;
        if (!full) return;
        afterNextRender(
          () => {
            if (!this.fs()?.full()) return;
            undo = isolate(this.host);
            (this.closer()?.nativeElement as HTMLElement | undefined)?.focus();
          },
          { injector: this.injector },
        );
      });
    });
    inject(DestroyRef).onDestroy(() => {
      run++;
      undo?.();
      map?.destroy?.();
    });
  }
}
