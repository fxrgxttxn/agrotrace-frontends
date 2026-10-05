<script lang="ts">
  import { ApiProblem } from '@agrotrace/api-client';
  import { formatBytes } from '@agrotrace/i18n';
  import { tooLargeText, typesText } from './admin';
  import { Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from './api.svelte';
  import { untrack } from 'svelte';
  import { FormAlert, type DialogAlert } from './forms.svelte';
  import { userAction } from './focusRescue';
  import { LOCALE, t } from './i18n';
  import Button from '../ui/Button.svelte';
  import FileField, { type FileItem } from '../ui/FileField.svelte';

  let {
    id,
    label,
    hint,
    types,
    maxBytes,
    upload,
    ondone,
    dialogAlert,
  }: {
    id: string;
    label: string;
    hint: string;
    types: readonly string[];
    maxBytes: number;
    upload: (file: File) => Promise<void>;
    ondone?: () => void;
    dialogAlert?: DialogAlert;
  } = $props();

  const inDialog = untrack(() => dialogAlert);
  const alert = inDialog ?? new FormAlert();
  $effect(() => () => {
    if (!inDialog) alert.clear();
  });
  let picked = $state<{ file: File; url: string; error?: string } | null>(null);
  let busy = $state(false);
  const wait = new Countdown();
  $effect(() => () => wait.stop());
  let button = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => wait.left,
    () => button,
  );
  $effect(() => {
    const url = picked?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  });

  function pick(files: File[]) {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!types.includes(file.type)) error = t('files.unsupported', { allowed: typesText(types) });
    else if (file.size > maxBytes) error = tooLargeText(maxBytes);
    picked = { file, url: URL.createObjectURL(file), error };
  }

  async function send() {
    if (!picked || picked.error) return;
    alert.clear();
    busy = true;
    try {
      await upload(picked.file);
      picked = null;
      ondone?.();
    } catch (e) {
      let error: string | undefined;
      if (e instanceof ApiProblem && e.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(e.params?.maxBytes) || maxBytes);
      else if (e instanceof ApiProblem && e.code === 'UNSUPPORTED_MEDIA_TYPE')
        error = t('files.unsupported', {
          allowed: typesText(Array.isArray(e.params?.allowed) ? e.params.allowed : types),
        });
      else if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors?.file?.[0]) error = t(e.errors.file[0]);
      if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
      if (error && picked) picked = { ...picked, error };
      if (!(inDialog && error)) alert.show(error ?? errorText(e), error ? 'danger' : errorTone(e));
    } finally {
      busy = false;
    }
  }

  const items = $derived<FileItem[]>(
    picked
      ? [
          {
            key: 'image',
            name: picked.file.name,
            sizeText: picked.error ?? formatBytes(picked.file.size, LOCALE),
            error: Boolean(picked.error),
            ...(picked.error ? { kind: typesText([picked.file.type]) } : { previewUrl: picked.url }),
            ...(busy ? { progress: null } : {}),
          },
        ]
      : [],
  );
</script>

<div style="display: grid; gap: var(--sp-3)">
  <FileField
    {id}
    {label}
    accept={types.join(',')}
    {hint}
    files={items}
    onfiles={pick}
    onremove={() => (picked = null)}
    error={picked?.error}
    disabled={busy}
  />
  {#if picked && !picked.error}
    <div>
      <Button
        bind:element={button}
        variant="primary"
        icon="upload"
        {busy}
        disabled={wait.left > 0}
        onclick={() => void userAction(send)}
      >
        {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('action.upload')}
      </Button>
    </div>
  {/if}
</div>
