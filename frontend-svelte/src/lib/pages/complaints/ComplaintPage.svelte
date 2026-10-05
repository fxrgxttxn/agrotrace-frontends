<script lang="ts">
  import { page } from '$app/state';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDateTime } from '@agrotrace/i18n';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { complaintActions, COMPLAINT_TONE } from '../../app/recalls';
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
  import DecisionCard from './DecisionCard.svelte';

  type Complaint = Schemas['Complaint'];
  const GAP = 'display: grid; gap: var(--sp-5)';
  const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

  const id = $derived(page.params.id ?? '');
  const screen = screenScope();
  let reviewing = $state(false);
  const reviewWait = new Countdown();
  let reviewButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => reviewWait.left,
    () => reviewButton,
  );
  const refocus = { current: false };

  const complaintQuery = query(
    () => ['complaint', id],
    ([, cid]) => call<Complaint>(session.api.GET('/complaints/{id}', { params: { path: { id: String(cid) } } })),
    { failed: 'complaints.cardFailed' },
  );
  const complaint = $derived(complaintQuery.data);
  const notFound = $derived(
    !complaint && complaintQuery.error instanceof ApiProblem && complaintQuery.error.status === 404,
  );
  const can = $derived(complaint ? complaintActions(complaint.status) : []);

  let wasFetching = false;
  $effect(() => {
    const fetching = complaintQuery.fetching;
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

  function changed(next: Complaint) {
    complaintQuery.set(next, cache.generation);
    void cache.invalidate(['complaints']);
  }
  function describe(e: unknown): string {
    if (e instanceof ApiProblem && (e.code === 'INVALID_TRANSITION' || e.status === 404)) {
      refocus.current = true;
      void cache.invalidate(['complaint', id]);
      void cache.invalidate(['complaints']);
      if (e.code === 'INVALID_TRANSITION')
        return t('complaints.stateChanged', {
          status: enumLabel(t, 'ComplaintStatus', String(e.params?.from ?? '')),
        });
    }
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      refocus.current = true;
      void cache.invalidate(['complaint', id]);
      return t('complaints.versionConflict');
    }
    return errorText(e);
  }

  async function review(c: Complaint) {
    reviewing = true;
    try {
      const next = await call<Complaint>(
        session.api.POST('/complaints/{id}/review', { params: { path: { id: c.id } }, body: {} }),
      );
      changed(next);
      screen.done({ tone: 'ok', text: t('complaints.reviewed') });
    } catch (e) {
      if (!screen.alive()) return;
      if (e instanceof ApiProblem && e.status === 429) reviewWait.start(retryAfterOf(e));
      screen.push({ tone: errorTone(e), text: describe(e) });
    } finally {
      reviewing = false;
    }
  }
</script>

{#snippet batchLink()}<a class="at-mono" href="/batches/{complaint!.batch.id}">{complaint!.batch.publicCode}</a>{/snippet}
{#snippet recallLink()}<a href="/recalls/{complaint!.recallId}">{t('complaints.recallLink')}</a>{/snippet}
{#snippet labLink()}<a href="/batches/{complaint!.batch.id}?tab=tests">{t('complaints.labLink')}</a>{/snippet}

{#if notFound}
  <Page title={t('page.complaint')}>
    <Card>
      <Empty art="not-found" text={t('complaints.notFound')}>
        {#snippet action()}<Button variant="primary" href="/complaints">{t('complaints.toList')}</Button>{/snippet}
      </Empty>
    </Card>
  </Page>
{:else}
  {#snippet pageActions()}
    <Button
      bind:element={reviewButton}
      variant="primary"
      busy={reviewing}
      disabled={reviewWait.left > 0}
      onclick={() => void userAction(() => review(complaint!))}
    >
      {reviewWait.left > 0 ? t('auth.retryIn', { seconds: reviewWait.left }) : t('complaints.review')}
    </Button>
  {/snippet}
  <Page actions={complaint && can.includes('review') ? pageActions : undefined} title={complaint ? t('complaints.title', { code: complaint.batch.publicCode }) : t('page.complaint')}>
    {#if !complaint && complaintQuery.failed}
      <AreaFailed
        text={t('complaints.cardFailed')}
        busy={complaintQuery.fetching}
        onretry={() => void userAction(complaintQuery.refetch)}
      />
    {:else if !complaint}
      <AreaLoading />
    {:else}
      {@const c = complaint}
      {@const facts = [
        { key: 'batch', term: t('complaints.batch'), value: batchLink },
        { key: 'created', term: t('complaints.createdAt'), value: at(c.createdAt) },
        { key: 'contact', term: t('complaints.contact'), value: c.contact ?? t('complaints.noContact') },
        ...(c.inspector ? [{ key: 'inspector', term: t('complaints.inspector'), value: c.inspector.fullName }] : []),
        ...(c.decision
          ? [{ key: 'decision', term: t('complaints.decision'), value: enumLabel(t, 'ComplaintDecisionType', c.decision) }]
          : []),
        ...(c.decidedAt ? [{ key: 'decided', term: t('complaints.decidedAt'), value: at(c.decidedAt) }] : []),
        ...(c.recallId ? [{ key: 'recall', term: t('page.recall'), value: recallLink }] : []),
        ...(c.labTestId ? [{ key: 'lab', term: t('recalls.labTest'), value: labLink }] : []),
      ]}
      <div style={GAP}>
        <Card>
          <CardHeader title={c.batch.product.name}>
            <Chip tone={COMPLAINT_TONE[c.status]} size="l">{enumLabel(t, 'ComplaintStatus', c.status)}</Chip>
          </CardHeader>
          <CardBody>
            <div style="display: grid; gap: var(--sp-4)">
              <dl class="at-card__facts">
                <div style="grid-column: 1 / -1">
                  <dt>{t('complaints.text')}</dt>
                  <dd style="white-space: pre-line">{c.text}</dd>
                </div>
                {#if c.decisionComment}
                  <div style="grid-column: 1 / -1">
                    <dt>{t('complaints.comment')}</dt>
                    <dd>{c.decisionComment}</dd>
                  </div>
                {/if}
              </dl>
              <CardFacts {facts} />
            </div>
          </CardBody>
        </Card>
        {#if can.includes('decide')}
          {#key c.id}
            <DecisionCard complaint={c} {describe} ondone={changed} />
          {/key}
        {/if}
      </div>
    {/if}
  </Page>
{/if}
