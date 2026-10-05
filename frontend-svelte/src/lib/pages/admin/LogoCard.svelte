<script lang="ts">
  import { withVariant } from '@agrotrace/api-client';
  import { IMAGE_TYPES } from '../../app/admin';
  import { call } from '../../app/api.svelte';
  import { t } from '../../app/i18n';
  import ImageUpload from '../../app/ImageUpload.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Avatar from '../../ui/Avatar.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';

  const LOGO_MAX_BYTES = 2097152;
  const LOGO_TYPES = [...IMAGE_TYPES, 'image/svg+xml'];
  const screen = screenScope();
  const org = $derived(session.me!.organization);
</script>

<Card>
  <CardHeader title={t('users.logo')} />
  <CardBody>
    <div style="display: flex; flex-wrap: wrap; gap: var(--sp-4); align-items: flex-start">
      <Avatar name={org.name} src={org.logoUrl ? withVariant(org.logoUrl, 96) : null} size="l" shape="square" />
      <div style="flex: 1 1 16rem; min-width: 0">
        <ImageUpload
          id="logo-file"
          label={t('field.file')}
          hint={t('users.logoHint')}
          types={LOGO_TYPES}
          maxBytes={LOGO_MAX_BYTES}
          upload={async (file) => {
            const body = new FormData();
            body.append('file', file);
            await call(
              session.api.PUT('/organizations/{id}/logo', { params: { path: { id: org.id } }, body: body as never }),
            );
          }}
          ondone={() => {
            screen.done({ tone: 'ok', text: t('users.logoSaved') });
            if (screen.sameSession()) void session.reloadMe();
          }}
        />
      </div>
    </div>
  </CardBody>
</Card>
