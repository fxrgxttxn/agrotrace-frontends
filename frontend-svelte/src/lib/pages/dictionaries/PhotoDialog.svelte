<script lang="ts">
  import { untrack } from 'svelte';
  import { withVariant } from '@agrotrace/api-client';
  import { IMAGE_TYPES, UPLOAD_MAX_BYTES } from '../../app/admin';
  import { call } from '../../app/api.svelte';
  import { t } from '../../app/i18n';
  import ImageUpload from '../../app/ImageUpload.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import { refresh, STACK, type Product } from './dictionaries';

  /** The photo of a product (JPG, PNG, WebP up to 5 MB): the current one and the upload. */
  let { product: shown, onclose }: { product: Product; onclose: () => void } = $props();
  const screen = screenScope();
  // The product of this dialog (its owner forgets it as the dialog closes, before the success is said).
  const product = untrack(() => shown);
</script>

<Dialog open {onclose} title={t('dict.photoTitle', { name: product.name })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={onclose}>{t('action.cancel')}</Button>
  {/snippet}
  <div style={STACK}>
    {#if product.imageUrl}
      <img
        src={withVariant(product.imageUrl, 480)}
        alt={t('dict.photoAlt', { name: product.name })}
        style="max-width: 100%; max-height: 12rem; border-radius: var(--r-m); justify-self: start"
      />
    {/if}
    <ImageUpload
      id="photo-file"
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
