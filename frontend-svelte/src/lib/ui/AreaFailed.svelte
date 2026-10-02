<script lang="ts">
  import { t } from '../app/i18n';
  import Button from './Button.svelte';
  import Card from './Card.svelte';
  import Empty from './Empty.svelte';

  /** A list or card area that failed to load: what failed and one button (spec §10.1: error = what and what to do).
   * With `onreset` (the server rejected the list's filters, 400) the button resets them instead of retrying. */
  let {
    text,
    busy = false,
    onretry,
    onreset,
  }: { text: string; busy?: boolean; onretry: () => void; onreset?: () => void } = $props();
</script>

<Card>
  <Empty art="empty-search" text={onreset ? t('filters.invalid') : text}>
    {#snippet action()}
      {#if onreset}
        <Button variant="primary" onclick={onreset}>{t('filters.reset')}</Button>
      {:else}
        <Button variant="primary" {busy} onclick={onretry}>{t('action.retry')}</Button>
      {/if}
    {/snippet}
  </Empty>
</Card>
