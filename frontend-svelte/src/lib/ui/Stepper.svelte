<script lang="ts">
  let { label, steps, current }: { label: string; steps: string[]; current: number } = $props();
</script>

<ol class="at-stepper" aria-label={label}>
  {#each steps as s, i (s)}
    <li
      class="at-stepper__step"
      data-done={i < current ? '' : undefined}
      aria-current={i === current ? 'step' : undefined}
    >
      <span class="at-stepper__marker">{i + 1}</span><span class="at-stepper__label">{s}</span>
    </li>
  {/each}
</ol>
