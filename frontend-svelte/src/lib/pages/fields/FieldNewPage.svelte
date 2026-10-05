<script lang="ts">
  import { cache } from '../../app/cache.svelte';
  import { t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import Page from '../../ui/Page.svelte';
  import FieldForm from './FieldForm.svelte';

  const screen = screenScope();
</script>

<Page title={t('page.fieldNew')}>
  <Card style="max-width: 40rem">
    <CardBody>
      <FieldForm
        id="field-new"
        submitLabel={t('fields.add')}
        onsaved={(f) => {
          void cache.invalidate(['fields']);
          screen.done({ tone: 'ok', text: t('fields.created', { name: f.name }) });
          screen.navigate(`/fields/${f.id}`);
        }}
      />
    </CardBody>
  </Card>
</Page>
