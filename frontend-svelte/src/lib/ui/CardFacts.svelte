<script lang="ts">
  let { facts }: { facts: { term: string; value: string; key?: string }[] } = $props();
</script>

<dl class="at-card__facts">
  {#each facts as f, i (f.key ?? i)}
    <div>
      <dt>{f.term}</dt>
      <dd>{f.value}</dd>
    </div>
  {/each}
</dl>
