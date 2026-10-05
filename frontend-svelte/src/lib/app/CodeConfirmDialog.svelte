<script lang="ts">
  import type { Snippet } from 'svelte';
  import { focusIfIdle } from './api.svelte';
  import { t } from './i18n';
  import Button from '../ui/Button.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import DialogMessage from '../ui/DialogMessage.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';

  let {
    open,
    title,
    text,
    code,
    confirmLabel,
    busy,
    wait,
    message,
    onclose,
    onconfirm,
    fieldId = 'confirm-code',
    fieldLabel = t('recallTasks.confirmCode'),
  }: {
    open: boolean;
    title: string;
    text?: Snippet;
    code: string;
    confirmLabel: string;
    busy: boolean;
    wait: number;
    message: string | null;
    onclose: () => void;
    onconfirm: () => void;
    fieldId?: string;
    fieldLabel?: string;
  } = $props();

  let typed = $state('');
  let confirmButton = $state<HTMLElement | null>(null);
  const matches = $derived(code.trim() !== '' && typed.trim().toUpperCase() === code.trim().toUpperCase());
  $effect(() => {
    if (!open) typed = '';
  });
  let waited = false;
  $effect(() => {
    if (wait > 0) waited = true;
    else if (waited) {
      waited = false;
      focusIfIdle(confirmButton);
    }
  });
</script>

<Dialog {open} {onclose} {title}>
  {#snippet actions()}
    <Button variant="ghost" onclick={onclose}>{t('action.cancel')}</Button>
    <Button bind:element={confirmButton} variant="danger" {busy} disabled={!matches || wait > 0} onclick={onconfirm}>
      {wait > 0 ? t('auth.retryIn', { seconds: wait }) : confirmLabel}
    </Button>
  {/snippet}
  <div style="display: grid; gap: var(--sp-4)">
    <DialogMessage text={message} />
    {@render text?.()}
    <Field id={fieldId} label={fieldLabel}>
      <Input mono autocomplete="off" bind:value={typed} />
    </Field>
  </div>
</Dialog>
