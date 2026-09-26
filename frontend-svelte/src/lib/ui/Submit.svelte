<script lang="ts">
  import type { Snippet } from 'svelte';
  import { focusAfterWait, type Countdown } from '../app/api.svelte';
  import { t } from '../app/i18n';
  import Button from './Button.svelte';

  /** Submit button of a form: busy while sending, disabled with a countdown («Повторить через N с») after a 429; when
   * the wait is over it takes the focus back (FM17: only when the focus is free). */
  let {
    form,
    variant = 'primary',
    formId,
    children,
  }: {
    form: { busy: boolean; wait: Countdown };
    variant?: 'primary' | 'secondary';
    /** Id of the form when the button stands outside it (dialog actions). */
    formId?: string;
    children: Snippet;
  } = $props();

  let element: HTMLElement | null = $state(null);
  focusAfterWait(
    () => form.wait.left,
    () => element,
  );
</script>

<Button bind:element type="submit" form={formId} {variant} busy={form.busy} disabled={form.wait.left > 0}
  >{#if form.wait.left > 0}{t('auth.retryIn', { seconds: form.wait.left })}{:else}{@render children()}{/if}</Button
>
