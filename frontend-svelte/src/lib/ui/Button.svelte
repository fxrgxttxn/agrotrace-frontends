<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';

  type Look = {
    /** `secondary` is the default and is always written out, so the DOM is the same in every framework. */
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    /** Written only when given (`m` is the CSS default). */
    size?: 'm' | 's';
    icon?: IconName;
    /** Square icon button: `aria-label` is required. */
    iconOnly?: boolean;
    busy?: boolean;
    children?: Snippet;
    /** The button element (focus, tests). */
    element?: HTMLElement | null;
  };

  type Props = Look &
    (({ href?: undefined } & Omit<HTMLButtonAttributes, 'children'>) | ({ href: string } & Omit<HTMLAnchorAttributes, 'children'>));

  /** `at-button` (README «Кнопка»); with `href` — `<a class="at-button">` with the same attributes (a link styled as a
   * button: client-side navigation for app paths, plain download for file URLs). While `busy`, clicks do not pass. */
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
  <!-- `onclick` goes through `click` (busy guard), not straight onto the element. -->
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
