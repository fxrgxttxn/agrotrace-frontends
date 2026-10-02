<script lang="ts">
  import { ApiProblem } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call, Countdown, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import type { Waybill } from './waybills';

  let {
    open,
    waybill,
    fail,
    onclose,
    ondone,
  }: {
    open: boolean;
    waybill: Waybill;
    fail: (e: unknown) => { text: string; tone: 'danger' | 'attention' };
    onclose: () => void;
    ondone: () => void;
  } = $props();

  let busy = $state(false);
  const wait = new Countdown();
  let message = $state<string | null>(null);
  let confirmButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => wait.left,
    () => confirmButton,
  );
  $effect(() => {
    if (!open) message = null;
  });

  async function remove() {
    busy = true;
    try {
      await call(
        session.api.DELETE('/waybills/{id}', { params: { path: { id: waybill.id }, header: { 'If-Match': waybill.version } } }),
      );
      ondone();
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
      message = fail(e).text;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog {open} {onclose} title={t('waybills.deleteTitle', { number: waybill.number })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={onclose}>{t('action.cancel')}</Button>
    <Button bind:element={confirmButton} variant="danger" {busy} disabled={wait.left > 0} onclick={() => void remove()}>
      {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : enumLabel(t, 'WaybillActionName', 'delete')}
    </Button>
  {/snippet}
  <DialogMessage text={message} />
</Dialog>
