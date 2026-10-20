<script lang="ts">
  import { ApiProblem } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { WaybillRejectSchema } from '@agrotrace/validation';
  import { call, Countdown, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { DialogAlert } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';
  import Textarea from '../../ui/Textarea.svelte';
  import { FORM_GRID } from '../layout';
  import type { Waybill } from './waybills';

  /** Refusal (spec §9.3: an irreversible action in its own dialog, the key parameter repeated — the waybill number,
   * README «Диалог»). A failure keeps what was typed; any close clears the form (a reopened dialog asks again) and hands
   * a failure still standing to the page. */
  let {
    open,
    waybill,
    describe,
    onclose,
    ondone,
  }: {
    open: boolean;
    waybill: Waybill;
    /** The failure in words (re-reading when stale), not shown — the dialog says it (README «Диалог»). */
    describe: (e: unknown) => { text: string; tone: 'danger' | 'attention' };
    onclose: () => void;
    ondone: (next: Waybill) => void;
  } = $props();

  let reason = $state('');
  let number = $state('');
  let error = $state<string | null>(null);
  // Said in the dialog only; any close with the failure still standing (the person, or a re-read that no longer allows
  // the action) hands it to the page (README «Диалог», polish P2).
  const failure = new DialogAlert();
  let busy = $state(false);
  const wait = new Countdown();
  const matches = $derived(waybill.number !== '' && number.trim().toUpperCase() === waybill.number);
  let confirmButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => wait.left,
    () => confirmButton,
  );
  $effect(() => {
    if (open) return;
    reason = '';
    number = '';
    error = null;
    failure.handOff();
  });

  async function reject() {
    const check = WaybillRejectSchema.safeParse({ reason });
    if (!check.success) {
      error = t(reason.trim() ? check.error.issues[0]!.message : 'validation.required');
      return;
    }
    busy = true;
    failure.clear();
    try {
      const next = await call<Waybill>(
        session.api.POST('/waybills/{id}/reject', {
          params: { path: { id: waybill.id }, header: { 'If-Match': waybill.version } },
          body: { reason },
        }),
      );
      reason = '';
      number = '';
      ondone(next);
    } catch (e) {
      const key = e instanceof ApiProblem && e.code === 'VALIDATION' ? e.errors?.reason?.[0] : undefined;
      if (key) error = t(key);
      else {
        if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
        const p = describe(e);
        failure.show(p.text, p.tone);
      }
    } finally {
      busy = false;
    }
  }
</script>

<Dialog {open} {onclose} title={t('waybills.rejectTitle', { number: waybill.number })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={onclose}>{t('action.cancel')}</Button>
    <Button
      bind:element={confirmButton}
      variant="danger"
      {busy}
      disabled={!matches || wait.left > 0}
      onclick={() => void reject()}
    >
      {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : enumLabel(t, 'WaybillActionName', 'reject')}
    </Button>
  {/snippet}
  <div style={FORM_GRID}>
    <DialogMessage text={failure.message} />
    <Field id="reject-reason" label={t('waybills.rejectReason')} error={error}>
      <Textarea
        rows={3}
        value={reason}
        oninput={(e) => {
          reason = e.currentTarget.value;
          error = null;
        }}
      />
    </Field>
    <Field id="reject-number" label={t('waybills.repeatNumber')}>
      <Input mono autocomplete="off" bind:value={number} />
    </Field>
  </div>
</Dialog>
