<script lang="ts">
  import { t } from '../app/i18n';
  import Button from '../ui/Button.svelte';
  import { Fullscreen } from '../ui/fullscreen.svelte';
  import MapCanvas from './MapCanvas.svelte';
  import { mapsKey, type MapField } from './ymaps';

  /** The map of `fields` (nothing when there is no key or no outline). The container is the design system's canvas
   * block (`at-graph` markup: canvas, toolbar — README «Граф», map alias); below 768 px the map opens full screen from
   * a button, Esc or «Закрыть карту» leave it. */
  let { fields }: { fields: MapField[] } = $props();

  const fs = new Fullscreen();
  const withOutline = $derived(fields.filter((f) => f.geometry));
  const label = $derived(t('maps.fields', { names: withOutline.map((f) => f.name).join(', ') }));
</script>

{#if mapsKey() && withOutline.length > 0}
  {#if !fs.wide && !fs.full}
    <Button bind:element={fs.opener} icon="map" onclick={fs.open}>{t('maps.open')}</Button>
  {:else}
    <div bind:this={fs.block} class="at-graph" data-fullscreen={fs.full ? '' : undefined}>
      <MapCanvas fields={withOutline} {label} />
      {#if fs.full}
        <div class="at-graph__toolbar">
          <Button
            variant="ghost"
            size="s"
            iconOnly
            bind:element={fs.closer}
            icon="close"
            aria-label={t('maps.close')}
            onclick={fs.close}
          />
        </div>
      {/if}
    </div>
  {/if}
{/if}
