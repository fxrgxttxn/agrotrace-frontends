<script lang="ts">
  let { shape = 'text', width }: { shape?: 'text' | 'block' | 'circle'; width?: string } = $props();
</script>

<span class="at-skeleton" data-shape={shape} style={width ? `width: ${width}` : undefined}></span>
