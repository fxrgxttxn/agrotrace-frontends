<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';

  type Look = {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'm' | 's';
    icon?: IconName;
    iconOnly?: boolean;
    busy?: boolean;
    children?: Snippet;
    element?: HTMLElement | null;
  };

  type Props = Look &
    (({ href?: undefined } & Omit<HTMLButtonAttributes, 'children'>) | ({ href: string } & Omit<HTMLAnchorAttributes, 'children'>));

  let {
    variant = 'secondary',
    size,
    icon,
    iconOnly = false,
    busy = false,
    children,
    element = $bindable(null),
    ...rest
  }: Props = $props();

  function click(e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
    if (busy) {
      e.preventDefault();
      return;
    }
    (rest as HTMLButtonAttributes).onclick?.(e);
  }
</script>

{#if rest.href !== undefined}
  <a
    bind:this={element}
    class="at-button"
    data-variant={variant}
    data-size={size}
    data-icon-only={iconOnly ? '' : undefined}
    {...rest as HTMLAnchorAttributes}
  >
    {#if icon}<Icon name={icon} class="at-button__icon" />{/if}{@render children?.()}
  </a>
{:else}
  <!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
  {@const { type = 'button', onclick: _onclick, ...attrs } = rest as HTMLButtonAttributes}
  <button
    bind:this={element}
    {type}
    class="at-button"
    data-variant={variant}
    data-size={size}
    data-icon-only={iconOnly ? '' : undefined}
    aria-busy={busy ? 'true' : undefined}
    {...attrs}
    onclick={click}
  >
    {#if icon}<Icon name={icon} class="at-button__icon" />{/if}{@render children?.()}
  </button>
{/if}
