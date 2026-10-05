<script lang="ts">
  import { page } from '$app/state';
  import { ApiProblem } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import { FormAlert } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { CONCLUSION_TONE, LAB_STATUS_TONE } from '../../app/labTests';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Page from '../../ui/Page.svelte';
  import { at, GAP, isNormsMismatch, type LabProblems, type LabTest } from './lab';
  import ProtocolCard from './ProtocolCard.svelte';
  import ResultsForm from './ResultsForm.svelte';
  import ResultsTable from './ResultsTable.svelte';

  const id = $derived(page.params.id ?? '');
  const screen = screenScope();
  const alert = new FormAlert();
  let sampling = $state(false);
  const sampleWait = new Countdown();
  let sampleButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => sampleWait.left,
    () => sampleButton,
  );
  const refocus = { current: false };

  function reread() {
    refocus.current = true;
    void cache.invalidate(['labTest', id]);
    void cache.invalidate(['labTests']);
  }

  function describe(e: unknown): { text: string; tone: 'danger' | 'attention' } {
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      reread();
      return { text: t('lab.versionConflict'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      reread();
      const from = String(e.params?.from ?? '');
      return { text: t('lab.stateChanged', { status: enumLabel(t, 'LabTestStatus', from) }), tone: 'danger' };
    }
    if (isNormsMismatch(e)) {
      reread();
      return { text: t('lab.normsChanged'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.status === 404) reread();
    return { text: errorText(e), tone: errorTone(e) };
  }
  const problems: LabProblems = {
    alert,
    describe,
    fail: (e) => {
      const p = describe(e);
      if (screen.alive()) alert.show(p.text, p.tone);
      return p;
    },
  };

  const testQuery = query(
    () => ['labTest', id],
    ([, tid]) => call<LabTest>(session.api.GET('/lab-tests/{id}', { params: { path: { id: String(tid) } } })),
    { failed: 'lab.testFailed' },
  );
  const test = $derived(testQuery.data);
  const notFound = $derived(!test && testQuery.error instanceof ApiProblem && testQuery.error.status === 404);
  const can = (a: string) => Boolean(test?.actions.includes(a as never));

  let wasFetching = false;
  $effect(() => {
    const fetching = testQuery.fetching;
    if (fetching) {
      wasFetching = true;
      return;
    }
    if (!wasFetching) return;
    wasFetching = false;
    if (!refocus.current) return;
    refocus.current = false;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected)
        document.querySelector<HTMLElement>('h1.at-page__title')?.focus();
    }, 0);
    return () => clearTimeout(timer);
  });

  function changed(next: LabTest) {
    testQuery.set(next, cache.generation);
    void cache.invalidate(['labTests']);
    void cache.invalidate(['dashboard']);
    void cache.invalidate(['batch']);
  }

  async function sample(x: LabTest) {
    alert.clear();
    sampling = true;
    try {
      const next = await call<LabTest>(
        session.api.POST('/lab-tests/{id}/sample', {
          params: { path: { id: x.id }, header: { 'If-Match': x.version } },
          body: {},
        }),
      );
      changed(next);
      screen.done({ tone: 'ok', text: t('lab.sampled', { code: x.batch.publicCode }) });
    } catch (e) {
      if (!screen.alive()) return;
      if (e instanceof ApiProblem && e.status === 429) sampleWait.start(retryAfterOf(e));
      problems.fail(e);
    } finally {
      sampling = false;
    }
  }
</script>

{#snippet batchLink()}<a class="at-mono" href="/batches/{test!.batch.id}">{test!.batch.publicCode}</a>{/snippet}
{#snippet due()}
  {at(test!.dueAt)}{#if test!.overdue}
    <!-- eslint-disable-next-line svelte/no-useless-mustaches -->
    {' '}<Chip tone="danger">{t('labTests.overdue')}</Chip>
  {/if}
{/snippet}
{#snippet conclusionChip()}{#if test?.conclusion}<Chip tone={CONCLUSION_TONE[test.conclusion]}
      >{enumLabel(t, 'LabConclusion', test.conclusion)}</Chip
    >{/if}{/snippet}

{#if notFound}
  <Page title={t('page.labTest')}>
    <Card>
      <Empty art="not-found" text={t('lab.notFound')}>
        {#snippet action()}<Button variant="primary" href="/lab/tests">{t('lab.toList')}</Button>{/snippet}
      </Empty>
    </Card>
  </Page>
{:else}
  {#snippet pageActions()}
    <Button
      bind:element={sampleButton}
      variant="primary"
      icon="flask"
      busy={sampling}
      disabled={sampleWait.left > 0}
      onclick={() => void userAction(() => sample(test!))}
    >
      {sampleWait.left > 0 ? t('auth.retryIn', { seconds: sampleWait.left }) : t('lab.sample')}
    </Button>
  {/snippet}
  <Page actions={test && can('sample') ? pageActions : undefined} title={test ? t('lab.title', { code: test.batch.publicCode }) : t('page.labTest')}>
    {#if !test && testQuery.failed}
      <AreaFailed text={t('lab.testFailed')} busy={testQuery.fetching} onretry={() => void userAction(testQuery.refetch)} />
    {:else if !test}
      <AreaLoading />
    {:else}
      {@const x = test}
      {@const facts = [
        { key: 'batch', term: t('lab.batch'), value: batchLink },
        { key: 'lab', term: t('labTests.lab'), value: x.lab.name },
        { key: 'reason', term: t('labTests.reason'), value: enumLabel(t, 'LabTestReason', x.reason) },
        { key: 'created', term: t('lab.createdAt'), value: at(x.createdAt) },
        { key: 'due', term: t('labTests.dueAt'), value: due },
        ...(x.sampledAt ? [{ key: 'sampled', term: t('lab.sampledAt'), value: at(x.sampledAt) }] : []),
        ...(x.escalatedAt ? [{ key: 'escalated', term: t('lab.escalatedAt'), value: at(x.escalatedAt) }] : []),
        ...(x.completedAt ? [{ key: 'completed', term: t('lab.completedAt'), value: at(x.completedAt) }] : []),
        ...(x.conclusion ? [{ key: 'conclusion', term: t('labTests.conclusion'), value: conclusionChip }] : []),
      ]}
      <div style={GAP}>
        <Card>
          <CardHeader title={x.batch.product.name}>
            <Chip tone={LAB_STATUS_TONE[x.status]} size="l">{enumLabel(t, 'LabTestStatus', x.status)}</Chip>
          </CardHeader>
          <CardBody><CardFacts {facts} /></CardBody>
        </Card>
        {#if !can('submitResults')}
          <ResultsTable test={x} />
        {:else if x.norms.length === 0}
          <Card>
            <CardHeader title={t('lab.results')} />
            <CardBody><p style="margin: 0">{t('lab.noNorms')}</p></CardBody>
          </Card>
        {:else}
          {#key x.id}
            <ResultsForm test={x} {problems} ondone={changed} />
          {/key}
        {/if}
        <ProtocolCard test={x} canUpload={can('uploadProtocol')} />
      </div>
    {/if}
  </Page>
{/if}
