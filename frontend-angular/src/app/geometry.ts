export const GEOJSON_MAX_BYTES = 1024 * 1024;

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

export function prettyGeometry(geometry: unknown): string {
  return JSON.stringify(geometry, null, 2).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]');
}

export function readText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}
