<script lang="ts">
  import { untrack } from 'svelte';
  import { Countdown } from '../app/api.svelte';
  import { t } from '../app/i18n';
  import { session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Empty from '../ui/Empty.svelte';
  import AuthLayout from './AuthLayout.svelte';

  /** Screen shown when the session cannot be restored for a transient reason (R61/F8): retry, not a logout. After a
   * 429 the retry waits out Retry-After (the session itself is kept). */
  const wait = new Countdown();
  const retryAfter = $derived(session.retryAfter);
  $effect(() => {
    const seconds = retryAfter;
    untrack(() => {
      if (seconds) wait.start(seconds);
    });
    return () => wait.stop();
  });

  // A disabled button drops the focus; when the wait is over, the focus goes to the button that can act now (as React).
  let button: HTMLElement | null = $state(null);
  let waited = false;
  $effect(() => {
    if (wait.left > 0) waited = true;
    else if (waited) {
      waited = false;
      button?.focus();
    }
  });
</script>

<AuthLayout title={t('page.unavailable')}>
  <Empty art="empty-search" text={retryAfter ? t('errors.RATE_LIMITED') : t('errors.BACKEND_UNAVAILABLE')}>
    {#snippet action()}
      <Button bind:element={button} variant="primary" disabled={wait.left > 0} onclick={() => void session.restore()}
        >{wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('action.retry')}</Button
      >
    {/snippet}
  </Empty>
</AuthLayout>
