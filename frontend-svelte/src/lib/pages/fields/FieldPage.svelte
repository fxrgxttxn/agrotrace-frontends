<script lang="ts">
  import { page } from '$app/state';
  import { ApiProblem } from '@agrotrace/api-client';
  import { formatDecimal } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import { dictionary } from '../../app/dictionaries';
  import { userAction } from '../../app/focusRescue';
  import { DialogAlert } from '../../app/forms.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import FieldMap from '../../maps/FieldMap.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Page from '../../ui/Page.svelte';
  import { FORM_GRID } from '../layout';
  import { viewerOf } from '../viewer';
  import FieldFormReady from './FieldFormReady.svelte';
  import { dateOrDash, GAP, type FieldT } from './fields';
  import Treatments from './Treatments.svelte';

  const id = $derived(page.params.id ?? '');
  const viewer = $derived(viewerOf(session.me!));
  const regions = dictionary('regions');
  const screen = screenScope();
  const born = cache.generation;
  let dialog = $state<'edit' | 'delete' | null>(null);
  let editKey = $state(0);
  let deleting = $state(false);
  const failure = new DialogAlert();
  $effect(() => {
    if (dialog !== 'delete') failure.handOff();
  });

  const fieldQuery = query(
    () => ['field', id],
    ([, fieldId]) => call<FieldT>(session.api.GET('/fields/{id}', { params: { path: { id: String(fieldId) } } })),
    { failed: 'fields.failed' },
  );
  const field = $derived(fieldQuery.data);
  const notFound = $derived(
    !field && fieldQuery.error instanceof ApiProblem && fieldQuery.error.status === 404,
  );

  async function remove() {
    const current = field;
    if (!current) return;
    deleting = true;
    failure.clear();
    try {
      await call(session.api.DELETE('/fields/{id}', { params: { path: { id: current.id } } }));
      if (screen.alive()) dialog = null;
      cache.forget(['field', current.id]);
      void cache.invalidate(['fields']);
      screen.done({ tone: 'ok', text: t('fields.deleted', { name: current.name }) });
      screen.navigate('/fields');
    } catch (e) {
      if (screen.alive()) failure.problem(e);
    } finally {
      deleting = false;
    }
  }

  function openEdit() {
    if (!regions.data && regions.failed) {
      screen.push({ tone: 'danger', text: t('fields.regionsFailed') });
      void regions.refetch();
      return;
    }
    editKey += 1;
    dialog = 'edit';
  }
</script>

{#if notFound}
  <Page title={t('page.field')}>
    <Card>
      <Empty art="not-found" text={t('fields.notFound')}>
        {#snippet action()}<Button variant="primary" href="/fields">{t('fields.toList')}</Button>{/snippet}
      </Empty>
    </Card>
  </Page>
{:else}
  {#snippet pageActions()}
    <Button variant="primary" href="/batches/new?fieldId={field!.id}">{t('fields.batch')}</Button>
    <Button onclick={openEdit}>{t('fields.edit')}</Button>
    <Button variant="ghost" icon="trash" onclick={() => (dialog = 'delete')}>{t('fields.delete')}</Button>
  {/snippet}
  <Page actions={viewer.farmer && field ? pageActions : undefined} title={field?.name ?? t('page.field')}>
    {#if !field && fieldQuery.failed}
      <AreaFailed text={t('fields.failed')} busy={fieldQuery.fetching} onretry={() => void userAction(fieldQuery.refetch)} />
    {:else if !field}
      <AreaLoading />
    {:else}
      {@const facts = [
        ...(viewer.overseer ? [{ key: 'farm', term: t('fields.farm'), value: field.organization.name }] : []),
        { key: 'region', term: t('fields.region'), value: field.region.name },
        { key: 'area', term: t('fields.area'), value: formatDecimal(field.areaHa, LOCALE) },
        { key: 'count', term: t('fields.treatments'), value: String(field.treatmentsCount) },
        { key: 'last', term: t('fields.lastTreatment'), value: dateOrDash(field.lastTreatmentAt) },
        ...(field.geometry ? [] : [{ key: 'geo', term: t('field.geometry'), value: t('fields.noGeometry') }]),
      ]}
      <div style={GAP}>
        <Card>
          <CardBody><CardFacts {facts} /></CardBody>
        </Card>
        <FieldMap fields={[field]} />
        <Treatments {field} farmer={viewer.farmer} />
      </div>
    {/if}
    {#if field && regions.data}
      {#key editKey}
        <FieldFormReady
          id="field-edit"
          {field}
          submitLabel={t('action.save')}
          regions={regions.data}
          dialog={{ open: dialog === 'edit', title: t('fields.editTitle'), onclose: () => (dialog = null) }}
          onsaved={(f) => {
            if (screen.alive()) dialog = null;
            fieldQuery.set(f, born);
            void cache.invalidate(['fields']);
            screen.done({ tone: 'ok', text: t('fields.saved', { name: f.name }) });
          }}
        />
      {/key}
    {/if}
    <Dialog open={dialog === 'delete'} onclose={() => (dialog = null)} title={t('fields.deleteTitle')}>
      {#snippet actions()}
        <Button variant="ghost" onclick={() => (dialog = null)}>{t('action.cancel')}</Button>
        <Button variant="danger" busy={deleting} onclick={() => void userAction(remove)}>{t('fields.delete')}</Button>
      {/snippet}
      <div style={FORM_GRID}>
        <DialogMessage text={failure.message} />
        <p style="margin: 0">{t('fields.deleteText', { name: field?.name ?? '' })}</p>
      </div>
    </Dialog>
  </Page>
{/if}
