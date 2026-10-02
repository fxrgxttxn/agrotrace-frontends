<script lang="ts">
  import { untrack } from 'svelte';
  import { reloadForChunk } from '../app/chunkFailure';
  import { t } from '../app/i18n';
  import Button from '../ui/Button.svelte';
  import { themeVersion } from '../ui/fullscreen.svelte';
  import { chartSummary, type Bar } from './bars';
  import type { ChartView } from './echarts';
  import { loadCharts } from './load';

  /** The canvas of an `at-chart`: drawn by the lazily loaded ECharts mount while that works; a failure (the chunk did
   * not load, or the drawing threw) shows «График не загрузился.» with «Повторить» — after a chunk failure through the
   * reload-once guard (FM15: a new document is the only way to ask for the chunk again), after a draw error a new
   * mount in place. */
  let {
    title,
    bars,
    integer = false,
    axisFormat,
  }: { title: string; bars: Bar[]; integer?: boolean; axisFormat?: (value: number) => string } = $props();

  let failure = $state<'chunk' | 'draw' | null>(null);
  /** «Повторить» after a draw error: a new mount (the loaded library tries again). */
  let attempt = $state(0);
  let element = $state<HTMLDivElement | null>(null);
  const theme = themeVersion();
  // Redrawn only when what is drawn changes (a new answer with equal data keeps the chart).
  const data = $derived(JSON.stringify(bars));

  $effect(() => {
    const el = element;
    const drawn = data;
    void theme.value;
    void attempt;
    if (!el || failure) return;
    let cancelled = false;
    let view: ChartView | null = null;
    const format = untrack(() => axisFormat);
    loadCharts().then(
      ({ mountBars }) => {
        if (cancelled) return;
        try {
          view = mountBars(el, JSON.parse(drawn) as Bar[], { integer, ...(format ? { axisFormat: format } : {}) });
        } catch {
          failure = 'draw';
        }
      },
      () => {
        if (!cancelled) failure = 'chunk';
      },
    );
    return () => {
      cancelled = true;
      view?.destroy();
    };
  });

  function retry() {
    // The chunk could not be loaded: only a new document can ask for it again (FM15 guard: once per chain).
    if (failure === 'chunk') {
      reloadForChunk();
      return;
    }
    failure = null;
    attempt += 1;
  }
</script>

{#if failure}
  <div class="at-chart__canvas">
    <div class="at-chart__failed">
      <p role="alert" style="margin: 0">{t('dashboard.chartFailed')}</p>
      <Button variant="secondary" size="s" onclick={retry}>{t('action.retry')}</Button>
    </div>
  </div>
{:else}
  <div class="at-chart__canvas" role="img" aria-label={chartSummary(title, bars)} bind:this={element}></div>
{/if}
