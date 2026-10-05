<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../app/i18n';
  import { themeVersion } from '../ui/fullscreen.svelte';
  import { boundsOf, loadYmaps, mapsKey, token, type MapField, type YEntity } from './ymaps';

  let { fields, label }: { fields: MapField[]; label: string } = $props();

  let el: HTMLDivElement | null = $state(null);
  let failed = $state(false);
  const theme = themeVersion();
  const shape = $derived(JSON.stringify(fields.map((f) => [f.id, f.geometry])));

  $effect(() => {
    void shape;
    void theme.value;
    const node = el;
    const polygons = untrack(() => fields.flatMap((f) => (f.geometry ? [f.geometry] : [])));
    const bounds = boundsOf(polygons);
    if (!node || !bounds) return;
    let map: YEntity | null = null;
    let cancelled = false;
    loadYmaps(mapsKey()).then(
      (y) => {
        if (cancelled) return;
        map = new y.YMap(node, { location: { bounds } });
        map.addChild(new y.YMapDefaultSchemeLayer());
        map.addChild(new y.YMapDefaultFeaturesLayer());
        const stroke = token('--c-field');
        const fill = token('--c-straw-soft');
        for (const geometry of polygons)
          map.addChild(
            new y.YMapFeature({ geometry, style: { stroke: [{ color: stroke, width: 2 }], fill, fillOpacity: 0.5 } }),
          );
      },
      () => {
        if (!cancelled) failed = true;
      },
    );
    return () => {
      cancelled = true;
      map?.destroy?.();
    };
  });
</script>

{#if failed}
  <div class="at-graph__canvas"><p role="alert" style="margin: 0; padding: var(--sp-5)">{t('maps.failed')}</p></div>
{:else}
  <div class="at-graph__canvas" role="img" aria-label={label} bind:this={el}></div>
{/if}
