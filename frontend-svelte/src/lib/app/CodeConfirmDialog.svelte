<script lang="ts">
  import type { Snippet } from 'svelte';
  import { focusIfIdle } from './api.svelte';
  import { t } from './i18n';
  import Button from '../ui/Button.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import DialogMessage from '../ui/DialogMessage.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';

  /** Confirmation of an irreversible action in its own `at-dialog` with the batch code repeated (spec §9.3, README
   * «Диалог»): starting a recall, confirming a withdrawal, a FAIL result. The danger button stays disabled until the
   * typed code matches (case and surrounding spaces do not matter); an unknown (empty) code never matches. A failure is
   * said inside the dialog (the page's toast region is behind the modal) and what was typed stays; any close clears
   * it — a dialog opened again asks for the code again. As the React app's CodeConfirmDialog. */
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
    /** The batch code to repeat. */
    code: string;
    confirmLabel: string;
    busy: boolean;
    /** Seconds of a 429 wait (0 — none). */
    wait: number;
    /** The failure of the last attempt, said in the dialog. */
    message: string | null;
    onclose: () => void;
    onconfirm: () => void;
    /** Id and label of the code field (the FAIL dialog of a lab test has its own). */
    fieldId?: string;
    fieldLabel?: string;
  } = $props();

  let typed = $state('');
  let confirmButton = $state<HTMLElement | null>(null);
  const matches = $derived(code.trim() !== '' && typed.trim().toUpperCase() === code.trim().toUpperCase());
  $effect(() => {
    if (!open) typed = '';
  });
  // FM17: when a wait ends, the confirm button takes the focus back (only when the focus is free).
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
