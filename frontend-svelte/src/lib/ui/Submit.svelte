<script lang="ts">
  import type { Snippet } from 'svelte';
  import { focusAfterWait, type Countdown } from '../app/api.svelte';
  import { t } from '../app/i18n';
  import Button from './Button.svelte';

  let {
    form,
    variant = 'primary',
    formId,
    children,
  }: {
    form: { busy: boolean; wait: Countdown };
    variant?: 'primary' | 'secondary';
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
