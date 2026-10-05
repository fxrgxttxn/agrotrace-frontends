<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ApiProblem, withVariant, type FileRef, type Me } from '@agrotrace/api-client';
  import { formatBytes } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { cache, screenAlive } from '../../app/cache.svelte';
  import { FormAlert } from '../../app/forms.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { userAction } from '../../app/focusRescue';
  import { session } from '../../app/session.svelte';
  import Avatar from '../../ui/Avatar.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import FileField, { type FileItem } from '../../ui/FileField.svelte';
  import { toasts } from '../../ui/toast-store.svelte';
  import { FORM_GRID, ROW } from '../layout';

  let { me }: { me: Me } = $props();

  const AVATAR_MAX_BYTES = 2097152;
  const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const TYPE_NAMES: Record<string, string> = {
    'image/jpeg': 'JPG',
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/svg+xml': 'SVG',
    'application/pdf': 'PDF',
  };
  const typesText = (types: readonly unknown[]) => types.map((m) => TYPE_NAMES[String(m)] ?? String(m)).join(', ');
  const tooLargeText = (max: number) => t('files.tooLarge', { max: formatBytes(max, LOCALE) });

  interface Picked {
    file: File;
    url: string;
    error?: string;
  }

  const alive = screenAlive();
  const alert = new FormAlert();
  let picked = $state<Picked | null>(null);
  let busy = $state<'upload' | 'delete' | null>(null);

  function drop() {
    if (picked) URL.revokeObjectURL(picked.url);
    picked = null;
  }
  onDestroy(() => {
    drop();
    alert.clear();
  });

  function pick(files: File[]) {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!AVATAR_TYPES.includes(file.type)) error = t('files.unsupported', { allowed: typesText(AVATAR_TYPES) });
    else if (file.size > AVATAR_MAX_BYTES) error = tooLargeText(AVATAR_MAX_BYTES);
    drop();
    picked = { file, url: URL.createObjectURL(file), error };
  }

  function changed(text: string, generation: number, known: Partial<Me>): void {
    if (!session.patchMe(known, generation)) return;
    toasts.push({ tone: 'ok', text });
    void session.reloadMe();
  }

  async function upload() {
    if (!picked || picked.error) return;
    alert.clear();
    busy = 'upload';
    const generation = cache.generation;
    try {
      const body = new FormData();
      body.append('file', picked.file);
      const stored = await call<FileRef>(session.api.PUT('/me/avatar', { body: body as never }));
      if (alive()) drop();
      changed(t('profile.avatarSaved'), generation, { avatarUrl: stored.url });
    } catch (err) {
      if (!alive()) return;
      let error: string | undefined;
      if (err instanceof ApiProblem && err.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(err.params?.maxBytes) || AVATAR_MAX_BYTES);
      else if (err instanceof ApiProblem && err.code === 'UNSUPPORTED_MEDIA_TYPE')
        error = t('files.unsupported', {
          allowed: typesText(Array.isArray(err.params?.allowed) ? err.params.allowed : AVATAR_TYPES),
        });
      else if (err instanceof ApiProblem && err.code === 'VALIDATION' && err.errors?.file?.[0])
        error = t(err.errors.file[0]);
      if (error && picked) picked = { ...picked, error };
      else if (!error) alert.problem(err);
    } finally {
      busy = null;
    }
  }

  async function remove() {
    alert.clear();
    busy = 'delete';
    const generation = cache.generation;
    try {
      await call(session.api.DELETE('/me/avatar'));
      changed(t('profile.avatarDeleted'), generation, { avatarUrl: null });
    } catch (err) {
      if (alive()) alert.problem(err);
    } finally {
      busy = null;
    }
  }

  const items: FileItem[] = $derived(
    picked
      ? [
          {
            key: 'avatar',
            name: picked.file.name,
            sizeText: picked.error ?? formatBytes(picked.file.size, LOCALE),
            error: Boolean(picked.error),
            previewUrl: picked.error ? undefined : picked.url,
            kind: picked.error ? (TYPE_NAMES[picked.file.type] ?? '') : undefined,
          },
        ]
      : [],
  );
</script>

<Card>
  <CardHeader title={t('profile.avatar')} />
  <CardBody>
    <div style={FORM_GRID}>
      <div style={ROW}>
        <Avatar name={me.fullName} src={me.avatarUrl ? withVariant(me.avatarUrl, 96) : null} size="l" />
        {#if me.avatarUrl}
          <Button variant="ghost" icon="trash" busy={busy === 'delete'} onclick={() => void userAction(remove)}
            >{t('profile.deleteAvatar')}</Button
          >
        {/if}
      </div>
      <FileField
        id="avatar-file"
        label={t('field.file')}
        accept={AVATAR_TYPES.join(',')}
        hint={t('profile.avatarHint')}
        files={items}
        onfiles={pick}
        onremove={drop}
        error={picked?.error}
        disabled={busy !== null}
      />
    </div>
  </CardBody>
  {#if picked && !picked.error}
    <CardFooter>
      <Button variant="primary" icon="upload" busy={busy === 'upload'} onclick={() => void userAction(upload)}
        >{t('action.upload')}</Button
      >
    </CardFooter>
  {/if}
</Card>
