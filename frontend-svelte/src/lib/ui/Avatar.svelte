<script lang="ts">
  import { initials } from './display';

  let {
    name,
    src = null,
    size = 'm',
    shape,
    decorative = false,
    hidden = false,
  }: {
    name: string;
    src?: string | null;
    size?: 's' | 'm' | 'l';
    shape?: 'square';
    decorative?: boolean;
    hidden?: boolean;
  } = $props();

  const silent = $derived(decorative || hidden);
</script>

{#if src}
  <span class="at-avatar" data-size={size} data-shape={shape} aria-hidden={hidden ? 'true' : undefined}
    ><img {src} alt={silent ? '' : name} /></span
  >
{:else}
  <span
    class="at-avatar"
    data-size={size}
    data-shape={shape}
    role={silent ? undefined : 'img'}
    aria-label={silent ? undefined : name}
    aria-hidden={silent ? 'true' : undefined}>{initials(name)}</span
  >
{/if}
