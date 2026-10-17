import { BASE } from './base';

export async function startMock(): Promise<void> {
  const { startBrowserMock } = await import('@agrotrace/mock-api/browser');
  await startBrowserMock({
    serviceWorkerUrl: `${BASE}/mockServiceWorker.js`,
    publicBaseUrl: `${location.origin}${BASE}`,
    loadAsset: async (url) => {
      const res = await fetch(new URL(url, import.meta.url));
      if (!res.ok) throw new Error(`asset ${url}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  });
}
