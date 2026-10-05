<script lang="ts">
  import { untrack } from 'svelte';
  import { withVariant } from '@agrotrace/api-client';
  import { IMAGE_TYPES, UPLOAD_MAX_BYTES } from '../../app/admin';
  import { call } from '../../app/api.svelte';
  import { DialogAlert } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import ImageUpload from '../../app/ImageUpload.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import { refresh, STACK, type Product } from './dictionaries';

  let { product: shown, onclose }: { product: Product; onclose: () => void } = $props();
  const screen = screenScope();
  const product = untrack(() => shown);
  const failure = new DialogAlert();
  const close = () => {
    failure.handOff();
    onclose();
  };
</script>

<Dialog open onclose={close} title={t('dict.photoTitle', { name: product.name })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>{t('action.cancel')}</Button>
  {/snippet}
  <div style={STACK}>
    <DialogMessage text={failure.message} />
    {#if product.imageUrl}
      <img
        src={withVariant(product.imageUrl, 480)}
        alt={t('dict.photoAlt', { name: product.name })}
        style="max-width: 100%; max-height: 12rem; border-radius: var(--r-m); justify-self: start"
      />
    {/if}
    <ImageUpload
      id="photo-file"
      dialogAlert={failure}
      label={t('field.file')}
      hint={t('dict.photoHint')}
      types={IMAGE_TYPES}
      maxBytes={UPLOAD_MAX_BYTES}
      upload={async (file) => {
        const body = new FormData();
        body.append('file', file);
        await call(
          session.api.PUT('/dictionaries/products/{id}/image', {
            params: { path: { id: product.id } },
            body: body as never,
          }),
        );
      }}
      ondone={() => {
        refresh('products');
        if (screen.alive()) onclose();
        screen.done({ tone: 'ok', text: t('dict.photoSaved', { name: product.name }) });
      }}
    />
  </div>
</Dialog>
