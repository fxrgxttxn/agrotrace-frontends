<script lang="ts">
  import { t } from '../app/i18n';
  import Button from './Button.svelte';
  import { toasts, type ToastEntry } from './toast-store.svelte';

  /** One `at-toasts` stack per app: both live regions are rendered from the start and never hidden (README), errors
   * go to the `role="alert"` region, the rest to `aria-live="polite"`. */
  const danger = $derived(toasts.list.filter((x) => x.tone === 'danger'));
  const polite = $derived(toasts.list.filter((x) => x.tone !== 'danger'));
</script>

{#snippet toast(x: ToastEntry)}
  <div class="at-toast" data-tone={x.tone}
    ><p class="at-toast__text">{x.text}{#if x.detail}<small>{x.detail}</small>{/if}</p
    ><Button
      variant="ghost"
      size="s"
      iconOnly
      icon="close"
      aria-label={t('shell.close')}
      onclick={() => toasts.dismiss(x.id)}
    /></div
  >
{/snippet}

<div class="at-toasts">
  <div class="at-toast-region" role="alert">{#each danger as x (x.id)}{@render toast(x)}{/each}</div>
  <div class="at-toast-region" aria-live="polite">{#each polite as x (x.id)}{@render toast(x)}{/each}</div>
</div>
