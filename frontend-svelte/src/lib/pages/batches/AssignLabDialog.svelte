<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { DialogAlert } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import OrgPicker from '../../app/OrgPicker.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import type { Batch } from './batches';

  let { open, batch, onclose, ondone }: { open: boolean; batch: Batch; onclose: () => void; ondone: () => void } =
    $props();

  const screen = screenScope();
  let labOrgId = $state('');
  let error = $state<string | null>(null);
  const failure = new DialogAlert();
  const close = () => {
    failure.handOff();
    onclose();
  };
  let busy = $state(false);
  const wait = new Countdown();
  onDestroy(() => wait.stop());
  let confirmButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => wait.left,
    () => confirmButton,
  );

  $effect(() => {
    if (open) return;
    labOrgId = '';
    error = null;
    failure.clear();
  });

  async function assign() {
    if (!labOrgId) {
      error = t('validation.required');
      return;
    }
    busy = true;
    failure.clear();
    try {
      const test = await call<Schemas['LabTest']>(
        session.api.POST('/lab-tests', { body: { batchId: batch.id, labOrgId } }),
      );
      void cache.invalidate(['batch', batch.id, 'tests']);
      screen.done({ tone: 'ok', text: t('lab.assigned', { code: batch.publicCode, lab: test.lab.name }) });
      ondone();
    } catch (e) {
      const key = e instanceof ApiProblem && e.code === 'VALIDATION' ? e.errors?.labOrgId?.[0] : undefined;
      if (key) error = t(key);
      else {
        if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
        failure.show(errorText(e), errorTone(e));
      }
    } finally {
      busy = false;
    }
  }
</script>

<Dialog {open} onclose={close} title={t('lab.assignTitle', { code: batch.publicCode })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>{t('action.cancel')}</Button>
    <Button
      bind:element={confirmButton}
      variant="primary"
      {busy}
      disabled={wait.left > 0}
      onclick={() => void assign()}
    >
      {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('lab.assign')}
    </Button>
  {/snippet}
  <div style="display: grid; gap: var(--sp-4)">
    <DialogMessage text={failure.message} />
    <OrgPicker
      id="assign-lab"
      label={t('field.labOrgId')}
      types={['LAB']}
      value={labOrgId}
      error={error}
      onchange={(id) => {
        labOrgId = id ?? '';
        error = null;
      }}
    />
  </div>
</Dialog>
