<script lang="ts">
  import { ART } from './art';
  import Art from './Art.svelte';
  import { focusIfIdle, Wait, type Failure } from './data.svelte';
  import { t } from './i18n';

  let { failure, busy, onretry }: { failure: Failure; busy: boolean; onretry: () => void } = $props();

  const TEXT: Record<Failure['kind'], string> = {
    offline: 'public.offline',
    unavailable: 'public.unavailable',
    limited: 'errors.RATE_LIMITED',
  };
  const wait = new Wait();
  $effect(() => () => wait.stop());
  $effect(() => {
    if (failure.kind === 'limited') wait.start(failure.wait);
  });
  let waited = false;
  $effect(() => {
    if (wait.left > 0) waited = true;
    else if (waited) {
      waited = false;
      focusIfIdle(document.querySelector<HTMLElement>('.at-public .at-empty .at-button'));
    }
  });
</script>

<article class="at-card" data-furrow="">
  <div class="at-empty">
    <Art art={ART.emptySearch} />
    <p class="at-empty__text">{t(TEXT[failure.kind])}</p>
    <button
      type="button"
      class="at-button"
      data-variant="primary"
      aria-busy={busy ? 'true' : undefined}
      disabled={wait.left > 0}
      onclick={() => {
        if (!busy) onretry();
      }}>{wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('action.retry')}</button
    >
  </div>
</article>
