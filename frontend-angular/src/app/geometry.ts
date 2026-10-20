// The field outline as people enter it (ruling F11): GeoJSON text in a textarea (or read from a `.geojson` file),
// sent as the contract's Polygon geometry — the React app's helpers of pages/fields.tsx.

/** Largest outline file read into the form (1000 positions × 10 rings of GeoJSON fit well below it). */
export const GEOJSON_MAX_BYTES = 1024 * 1024;

/** GeoJSON text → a Polygon geometry (a bare geometry, a Feature, or a collection of one Feature); `''` → null. */
export function parseGeometry(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    let v = JSON.parse(text) as Record<string, unknown> | null;
    if (v?.['type'] === 'FeatureCollection' && Array.isArray(v['features']) && v['features'].length === 1)
      v = v['features'][0] as Record<string, unknown>;
    if (v?.['type'] === 'Feature') v = v['geometry'] as Record<string, unknown>;
    return v?.['type'] === 'Polygon' ? { ok: true, value: v } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** A polygon as the outline field shows it: pretty-printed, one position per line. */
export function prettyGeometry(geometry: unknown): string {
  return JSON.stringify(geometry, null, 2).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]');
}

/** Text of a chosen file (FileReader: every browser, and jsdom); `null` — unreadable. */
export function readText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}
