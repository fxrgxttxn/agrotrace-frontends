<script lang="ts">
  import { initials } from './display';

  /** `at-avatar` (README «Аватар»). With `src`: an image (`alt` = name, or `''` when `decorative`); without: initials,
   * `role="img"` + `aria-label`, or `aria-hidden` when `decorative`. `hidden` hides the whole avatar from assistive
   * technology (inside a link that already names the person). */
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
