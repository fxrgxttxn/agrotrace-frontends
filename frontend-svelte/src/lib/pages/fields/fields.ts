import type { Schemas } from '@agrotrace/api-client';
import { formatLocalDate } from '@agrotrace/i18n';
import { FieldInputSchema, TreatmentInputSchema } from '@agrotrace/validation';
import { normalizeDecimal, wireSchema } from '../../app/forms.svelte';
import { LOCALE } from '../../app/i18n';
import type { ListSpec } from '../../app/listState.svelte';
import { momentCheck, momentWire } from '../../app/moment';

// Fields (FR-PROD-01) and their treatment journal (FR-PROD-02): the shared pieces of the screens — the same rules as the
// React app (src/pages/fields.tsx there).

export type FieldT = Schemas['Field'];
export type Treatment = Schemas['Treatment'];
export const SIZE = 20;
export const GAP = 'display: grid; gap: var(--sp-5)';

export const FIELDS_SPEC: ListSpec = {
  sort: ['name', 'areaHa', 'lastTreatmentAt', 'createdAt'],
  patterns: { regionCode: /^[0-9A-Z-]{1,8}$/ },
  uuids: ['organizationId'],
  texts: ['q'],
};
export const TREATMENTS_SPEC: ListSpec = { sort: ['appliedAt', 'createdAt'] };

export const dateOrDash = (iso: string | null) => (iso ? formatLocalDate(iso, LOCALE) : '—');
export const sortParam = (s: { field: string; dir: string } | null) => (s ? { sort: `${s.field},${s.dir}` } : {});

/** Largest outline file read into the form (1000 positions × 10 rings of GeoJSON fit well below it). */
export const GEOJSON_MAX_BYTES = 1024 * 1024;

/** GeoJSON text → a Polygon geometry (a bare geometry, a Feature, or a collection of one Feature); `''` → null. */
export function parseGeometry(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    let v = JSON.parse(text) as Record<string, unknown> | null;
    if (v?.type === 'FeatureCollection' && Array.isArray(v.features) && v.features.length === 1)
      v = v.features[0] as Record<string, unknown>;
    if (v?.type === 'Feature') v = v.geometry as Record<string, unknown>;
    return v?.type === 'Polygon' ? { ok: true, value: v } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** A polygon as the outline field shows it: pretty-printed, one position per line. */
export function prettyGeometry(geometry: unknown): string {
  return JSON.stringify(geometry, null, 2).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]');
}

/** Text of a chosen file (FileReader: every browser, and jsdom). */
export function readText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}

export interface FieldValues extends Record<string, unknown> {
  name: string;
  areaHa: string;
  regionCode: string;
  geometry: string;
}
export const FIELD_FIELDS = ['name', 'areaHa', 'regionCode', 'geometry'] as const;

export const fieldSchema = wireSchema<FieldValues>(
  FieldInputSchema,
  (v) => {
    const geometry = parseGeometry(v.geometry);
    return {
      name: v.name,
      areaHa: normalizeDecimal(v.areaHa, 2),
      regionCode: v.regionCode,
      geometry: geometry.ok ? geometry.value : null,
    };
  },
  (v): Record<string, string> => (parseGeometry(v.geometry).ok ? {} : { geometry: 'fields.geometryInvalid' }),
);

/** Server errors inside the outline (`geometry.coordinates[0]`) belong to the outline field. */
export const fieldAlias = (path: string) => (path.startsWith('geometry') ? 'geometry' : path);

export function fieldValuesOf(f?: FieldT): FieldValues {
  return {
    name: f?.name ?? '',
    areaHa: f ? f.areaHa.replace('.', ',') : '',
    regionCode: f?.region.code ?? '',
    geometry: f?.geometry ? prettyGeometry(f.geometry) : '',
  };
}

export interface TreatmentValues extends Record<string, unknown> {
  substanceId: string;
  dose: string;
  doseUnit: string;
  appliedAt: string | null;
  appliedTime: string;
  /** The recorded instant: kept as it is while its date and time are not changed. */
  original: string | null;
}
export const TREATMENT_FIELDS = ['substanceId', 'dose', 'doseUnit', 'appliedAt', 'appliedTime'] as const;
export const DOSE_UNITS = ['л/га', 'мл/га', 'кг/га', 'г/га'] as const;

const moment = (v: TreatmentValues) => ({ date: v.appliedAt, time: v.appliedTime, original: v.original });
export const treatmentSchema = wireSchema<TreatmentValues>(
  TreatmentInputSchema,
  (v) => ({
    substanceId: v.substanceId,
    dose: normalizeDecimal(v.dose, 3),
    doseUnit: v.doseUnit,
    appliedAt: momentWire(moment(v)),
  }),
  (v) => momentCheck(moment(v), 'appliedAt', 'appliedTime'),
);
