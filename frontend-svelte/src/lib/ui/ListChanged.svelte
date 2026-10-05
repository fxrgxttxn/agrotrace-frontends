<script lang="ts">
  import { t } from '../app/i18n';
  import Button from './Button.svelte';
  import Card from './Card.svelte';
  import Empty from './Empty.svelte';

  let { busy = false, onreload }: { busy?: boolean; onreload: () => void } = $props();
</script>

<Card>
  <Empty art="empty-search" text={t('filters.changed')}>
    {#snippet action()}
      <Button variant="primary" {busy} onclick={onreload}>{t('filters.reload')}</Button>
    {/snippet}
  </Empty>
</Card>
