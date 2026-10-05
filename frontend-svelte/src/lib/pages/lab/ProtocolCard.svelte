<script lang="ts">
  import { ApiProblem } from '@agrotrace/api-client';
  import { formatBytes } from '@agrotrace/i18n';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { FormAlert } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import FileField, { type FileItem } from '../../ui/FileField.svelte';
  import { PROTOCOL_MAX_BYTES, STACK, type LabTest } from './lab';

  let { test, canUpload }: { test: LabTest; canUpload: boolean } = $props();

  const screen = screenScope();
  const alert = new FormAlert();
  $effect(() => () => alert.clear());
  let picked = $state<{ file: File; error?: string } | null>(null);
  let busy = $state(false);
  const wait = new Countdown();
  $effect(() => () => wait.stop());
  let uploadButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => wait.left,
    () => uploadButton,
  );
  const protocol = $derived(test.protocol);

  const isPdf = (file: File) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const tooLargeText = (max: number) => t('files.tooLarge', { max: formatBytes(max, LOCALE) });
  const unsupportedText = () => t('files.unsupported', { allowed: 'PDF' });

  function pick(files: File[]) {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!isPdf(file)) error = unsupportedText();
    else if (file.size > PROTOCOL_MAX_BYTES) error = tooLargeText(PROTOCOL_MAX_BYTES);
    picked = { file, error };
  }

  async function upload() {
    if (!picked || picked.error) return;
    alert.clear();
    busy = true;
    try {
      const body = new FormData();
      body.append('file', picked.file);
      await call(session.api.PUT('/lab-tests/{id}/protocol', { params: { path: { id: test.id } }, body: body as never }));
      picked = null;
      await cache.invalidate(['labTest', test.id]);
      void cache.invalidate(['labTests']);
      screen.done({ tone: 'ok', text: t('lab.protocolSaved') });
    } catch (e) {
      if (!screen.alive()) return;
      let error: string | undefined;
      if (e instanceof ApiProblem && e.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(e.params?.maxBytes) || PROTOCOL_MAX_BYTES);
      else if (e instanceof ApiProblem && e.code === 'UNSUPPORTED_MEDIA_TYPE') error = unsupportedText();
      else if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors?.file?.[0]) error = t(e.errors.file[0]);
      if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
      if (error && picked) picked = { ...picked, error };
      alert.show(error ?? errorText(e), error ? 'danger' : errorTone(e));
    } finally {
      busy = false;
    }
  }

  const items = $derived<FileItem[]>(
    picked
      ? [
          {
            key: 'protocol',
            name: picked.file.name,
            sizeText: picked.error ?? formatBytes(picked.file.size, LOCALE),
            error: Boolean(picked.error),
            kind: 'PDF',
            ...(busy ? { progress: null } : {}),
          },
        ]
      : [],
  );
</script>

{#if protocol || canUpload}
  <Card>
    <CardHeader title={t('lab.protocol')} />
    <CardBody>
      <div style={STACK}>
        {#if protocol}
          <div style="display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center">
            <Button variant="secondary" icon="download" href={protocol.url} data-sveltekit-reload>{t('lab.protocolDownload')}</Button>
            <span class="at-table__sub">{protocol.originalName}, {formatBytes(protocol.sizeBytes, LOCALE)}</span>
          </div>
        {:else}
          <p style="margin: 0">{t('lab.protocolNone')}</p>
        {/if}
        {#if canUpload}
          <FileField
            id="protocol-file"
            label={t('field.file')}
            accept="application/pdf,.pdf"
            hint={t('lab.protocolHint')}
            files={items}
            onfiles={pick}
            onremove={() => (picked = null)}
            error={picked?.error}
            disabled={busy}
          />
        {/if}
      </div>
    </CardBody>
    {#if canUpload && picked && !picked.error}
      <CardFooter>
        <Button
          bind:element={uploadButton}
          variant="primary"
          icon="upload"
          {busy}
          disabled={wait.left > 0}
          onclick={() => void userAction(upload)}
        >
          {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : protocol ? t('lab.protocolReplace') : t('action.upload')}
        </Button>
      </CardFooter>
    {/if}
  </Card>
{/if}
