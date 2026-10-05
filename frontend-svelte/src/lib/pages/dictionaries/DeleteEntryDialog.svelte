<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiProblem } from '@agrotrace/api-client';
  import type { DictName } from '../../app/admin';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { userAction } from '../../app/focusRescue';
  import { DialogAlert } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import { entryName, refresh, SOFT, STACK, type Entry } from './dictionaries';

  let { name, entry: shown, onclose }: { name: DictName; entry: Entry; onclose: () => void } = $props();

  const screen = screenScope();
  const dict = untrack(() => name);
  const entry = untrack(() => shown);
  const label = entryName(dict, entry);
  let busy = $state(false);
  const failure = new DialogAlert();
  const close = () => {
    failure.handOff();
    onclose();
  };
  const wait = new Countdown();
  $effect(() => () => wait.stop());
  let button = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => wait.left,
    () => button,
  );

  async function remove() {
    busy = true;
    failure.clear();
    try {
      await call(session.api.DELETE('/dictionaries/{name}/{id}', { params: { path: { name: dict, id: entry.id } } }));
      refresh(dict);
      if (screen.alive()) onclose();
      screen.done({ tone: 'ok', text: t('dict.removed', { name: label }) });
    } catch (e) {
      if (!screen.alive()) return;
      let text = errorText(e);
      if (e instanceof ApiProblem && e.code === 'REFERENCE_IN_USE') {
        const used = Array.isArray(e.params?.usedBy) ? (e.params.usedBy as string[]) : [];
        text = t('dict.inUseBy', { name: label, by: used.map((u) => t(`dict.usedBy.${u}`)).join(', ') });
      } else if (e instanceof ApiProblem && e.status === 404) {
        refresh(dict);
        onclose();
        screen.push({ tone: 'danger', text: t('dict.gone', { name: label }) });
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
      failure.show(text, errorTone(e));
    } finally {
      busy = false;
    }
  }
</script>

<Dialog open onclose={close} title={t('dict.deleteTitle', { name: label })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>{t('action.cancel')}</Button>
    <Button bind:element={button} variant="danger" {busy} disabled={wait.left > 0} onclick={() => void userAction(remove)}>
      {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('action.delete')}
    </Button>
  {/snippet}
  <div style={STACK}>
    <DialogMessage text={failure.message} />
    <p style="margin: 0">{SOFT.includes(dict) ? t('dict.deleteSoft') : t('dict.deleteHard')}</p>
  </div>
</Dialog>
