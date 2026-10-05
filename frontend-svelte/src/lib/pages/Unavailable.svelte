<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Countdown, focusAfterWait } from '../app/api.svelte';
  import { t } from '../app/i18n';
  import { session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Empty from '../ui/Empty.svelte';
  import AuthLayout from './AuthLayout.svelte';

  const wait = new Countdown();
  const retryAfter = $derived(session.retryAfter);
  $effect(() => {
    const seconds = retryAfter;
    untrack(() => {
      if (seconds) wait.start(seconds);
    });
    return () => wait.stop();
  });

  onMount(() => {
    if (session.takeUserRetry()) button?.focus();
  });

  let button: HTMLElement | null = $state(null);
  focusAfterWait(
    () => wait.left,
    () => button,
  );
</script>

<AuthLayout title={t('page.unavailable')}>
  <Empty art="empty-search" text={retryAfter ? t('errors.RATE_LIMITED') : t('errors.BACKEND_UNAVAILABLE')}>
    {#snippet action()}
      <Button bind:element={button} variant="primary" disabled={wait.left > 0} onclick={() => void session.retry()}
        >{wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('action.retry')}</Button
      >
    {/snippet}
  </Empty>
</AuthLayout>
