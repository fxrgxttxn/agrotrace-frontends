/** Mock mode (ruling FM23; `./at.sh fe:build angular --mock` → dist-mock): the MSW service worker of
 * @agrotrace/mock-api (its mockServiceWorker.js and the unpatched MSW script under msw/, copied to the site root)
 * answers /api/v1 in the browser before the app makes its first request. Loaded as its own chunk; absent from the production build. */
export async function startMock(): Promise<void> {
  const { startBrowserMock } = await import('@agrotrace/mock-api/browser');
  await startBrowserMock({
    // The mock's bundled images / fonts are emitted by esbuild's `file` loader as URLs relative to the chunks
    // (`./media/…`, all chunks live in /assets/) — resolved against this chunk, not against the page's route.
    loadAsset: async (url) => {
      const res = await fetch(new URL(url, import.meta.url));
      if (!res.ok) throw new Error(`asset ${url}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  });
}
