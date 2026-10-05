<script lang="ts">
  import { t } from '../app/i18n';
  import Button from './Button.svelte';
  import Card from './Card.svelte';
  import Empty from './Empty.svelte';

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
