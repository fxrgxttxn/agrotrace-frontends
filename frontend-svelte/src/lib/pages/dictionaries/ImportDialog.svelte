<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiProblem } from '@agrotrace/api-client';
  import { enumLabel, formatBytes } from '@agrotrace/i18n';
  import {
    IMPORT_ACCEPT,
    IMPORT_HEADER,
    IMPORT_TYPES,
    importFileProblem,
    isImportFile,
    tooLargeText,
    typesText,
    UPLOAD_MAX_BYTES,
    type DictName,
  } from '../../app/admin';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { DialogAlert } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import FileField, { type FileItem } from '../../ui/FileField.svelte';
  import { refresh, STACK, type Report } from './dictionaries';

  let { name, onclose, ondone }: { name: DictName; onclose: () => void; ondone: (r: Report) => void } = $props();

  const screen = screenScope();
  const dict = untrack(() => name);
  let picked = $state<{ file: File; error?: string } | null>(null);
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

  function pick(files: File[]) {
    const file = files[0];
    if (!file) return;
    failure.clear();
    let error: string | undefined;
    if (!isImportFile(file)) error = t('files.unsupported', { allowed: typesText(IMPORT_TYPES) });
    else if (file.size > UPLOAD_MAX_BYTES) error = tooLargeText(UPLOAD_MAX_BYTES);
    picked = { file, error };
  }

  async function send() {
    if (!picked || picked.error) return;
    failure.clear();
    busy = true;
    try {
      const body = new FormData();
      body.append('file', picked.file);
      const report = await call<Report>(
        session.api.POST('/dictionaries/{name}/import', { params: { path: { name: dict } }, body: body as never }),
      );
      refresh(dict);
      if (screen.alive()) ondone(report);
      screen.done({
        tone: report.errors.length ? 'attention' : 'ok',
        text: t('dict.import.done', {
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          rejected: new Set(report.errors.map((x) => x.row)).size,
        }),
      });
    } catch (e) {
      if (!screen.alive()) return;
      const problem = importFileProblem(e, dict);
      if (problem && picked) picked = { ...picked, error: problem };
      if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
      if (!problem) failure.show(errorText(e), errorTone(e));
    } finally {
      busy = false;
    }
  }

  const items = $derived<FileItem[]>(
    picked
      ? [
          {
            key: 'import',
            name: picked.file.name,
            sizeText: picked.error ?? formatBytes(picked.file.size, LOCALE),
            error: Boolean(picked.error),
            kind: picked.file.name.toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV',
            ...(busy ? { progress: null } : {}),
          },
        ]
      : [],
  );
</script>

<Dialog open onclose={close} title={t('dict.import.title', { name: enumLabel(t, 'DictionaryName', dict) })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>{t('action.cancel')}</Button>
    <Button
      bind:element={button}
      variant="primary"
      icon="upload"
      {busy}
      disabled={!picked || Boolean(picked.error) || wait.left > 0}
      onclick={() => void userAction(send)}
    >
      {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('dict.import.send')}
    </Button>
  {/snippet}
  <div style={STACK}>
    <DialogMessage text={failure.message} />
    <FileField
      id="import-file"
      label={t('field.file')}
      accept={IMPORT_ACCEPT}
      hint={t('dict.import.hint', { header: IMPORT_HEADER[dict] })}
      files={items}
      onfiles={pick}
      onremove={() => (picked = null)}
      error={picked?.error}
      disabled={busy}
    />
  </div>
</Dialog>
