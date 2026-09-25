<script lang="ts">
  import { sparkPoints } from './display';

  /** `at-metric` (README «Показатель»). */
  let {
    label,
    value,
    unit,
    tone,
    spark,
  }: { label: string; value: string; unit?: string; tone?: 'danger'; spark?: number[] } = $props();
</script>

<div class="at-metric" data-tone={tone}>
  <p class="at-metric__label">{label}</p>
  <p class="at-metric__value">{value}{#if unit !== undefined}<span class="at-metric__unit">{unit}</span>{/if}</p>
  {#if spark && spark.length > 1}
    <div class="at-metric__spark" aria-hidden="true">
      <svg viewBox="0 0 96 32"
        ><polyline
          points={sparkPoints(spark)}
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        /></svg
      >
    </div>
  {/if}
</div>
