<script lang="ts">
  import { untrack } from 'svelte';
  import { base } from '$app/paths';
  import { withVariant, type SafetyStatus } from '@agrotrace/api-client/public';
  import { formatLocalDate, photoCredit } from '@agrotrace/i18n/public';
  import { ART } from './art';
  import Art from './Art.svelte';
  import { BatchQuery, initials } from './data.svelte';
  import Failed from './Failed.svelte';
  import { LOCALE, t } from './i18n';
  import Loading from './Loading.svelte';
  import NotFound from './NotFound.svelte';
  import { publicFrame } from './frame.svelte';
  import { timeline } from './timeline';

  let { code }: { code: string } = $props();

  const SAFETY_ICON: Record<SafetyStatus, string> = { SAFE: 'check', RECALLED: 'alert', BLOCKED: 'alert', UNKNOWN: 'clock' };
  const date = (iso: string) => formatLocalDate(iso, LOCALE);
  const query = new BatchQuery(untrack(() => code));
  const batchState = $derived(query.state);
  const batch = $derived(batchState.status === 'ok' ? batchState.batch : null);
  const title = $derived(batch ? batch.product.name : t('page.publicBatch'));
  publicFrame(() => title);
  const credit = $derived(batch ? photoCredit(batch.product.imageUrl) : null);
  const captionParts = t('public.photo').split(/\{(\w+)\}/);
</script>

<main class="at-page at-public" id="main" tabindex="-1">
  <div class="at-page__header"><h1 class="at-page__title" tabindex="-1">{title}</h1></div>
  <div class="at-public__stack">
  {#if batchState.status === 'loading'}
    <Loading />
  {:else if batchState.status === 'notFound'}
    <NotFound />
  {:else if batchState.status === 'failed'}
    <Failed failure={batchState.failure} busy={batchState.busy} onretry={query.retry} />
  {:else if batch}
    {@const b = batch}
    {@const lab = b.labSummary}
    <article class="at-card" data-furrow="">
      <div class="at-card__body">
        {#if b.safety === 'RECALLED'}
          <div class="at-public__warning">
            <Art art={ART.recallWarning} />
            <h2 class="at-public__warning-title">{t('public.recallTitle')}</h2>
            <p class="at-public__warning-text">{t('public.safetyNote.RECALLED')}</p>
          </div>
        {/if}
        <div class="at-public__hero">
          {#if b.product.imageUrl}
            <figure class="at-public__photo">
              <img src={withVariant(b.product.imageUrl, 480)} alt="" width="480" height="360" fetchpriority="high" />
              {#if credit}
                <figcaption>
                  {captionParts[0]}<a href={credit.source} rel="noopener noreferrer" target="_blank">{credit.author}</a
                  >{captionParts[2]}<a href={credit.licenseUrl} rel="noopener noreferrer" target="_blank"
                    >{credit.license}</a
                  >{captionParts[4]}
                </figcaption>
              {/if}
            </figure>
          {/if}
          <div class="at-public__summary">
            <p class="at-public__status" data-safety={b.safety}>
              <svg class="at-public__status-icon" aria-hidden="true"><use href="#i-{SAFETY_ICON[b.safety]}" /></svg>{t(
                `status.safety.${b.safety}`,
              )}
            </p>
            {#if b.safety === 'BLOCKED' || b.safety === 'UNKNOWN'}
              <p class="at-public__note">{t(`public.safetyNote.${b.safety}`)}</p>
            {/if}
            <dl class="at-card__facts">
              <div><dt>{t('public.code')}</dt><dd><span class="at-mono">{b.publicCode}</span></dd></div>
            </dl>
          </div>
        </div>
      </div>
    </article>
    <article class="at-card">
      <header class="at-card__header"><h2 class="at-card__title">{t('public.origin')}</h2></header>
      <div class="at-card__body">
        <p class="at-public__org">
          {#if b.origin.logoUrl}<span class="at-avatar" data-size="l" data-shape="square"
              ><img src={withVariant(b.origin.logoUrl, 96)} alt="" /></span
            >{:else}<span class="at-avatar" data-size="l" data-shape="square" aria-hidden="true"
              >{initials(b.origin.farmName)}</span
            >{/if}<span
            ><span class="at-public__org-type">{t(b.producedAt ? 'public.producer' : 'public.farm')}</span>{b.origin
              .farmName}</span
          >
        </p>
        <dl class="at-card__facts">
          <div><dt>{t('public.region')}</dt><dd>{b.origin.region.name}</dd></div
          >{#if b.harvestedAt}<div><dt>{t('public.harvestedAt')}</dt><dd>{date(b.harvestedAt)}</dd></div>{/if}{#if b.producedAt}<div><dt>{t('public.producedAt')}</dt><dd>{date(b.producedAt)}</dd></div>{/if}
        </dl>
      </div>
    </article>
    <article class="at-card">
      <header class="at-card__header"><h2 class="at-card__title">{t('public.path')}</h2></header>
      <div class="at-card__body">
        <ol
          class="at-timeline"
          use:timeline={b.path.map((s) => ({
            at: s.from,
            atText: s.to
              ? t('public.period', { from: date(s.from), to: date(s.to) })
              : t('public.since', { date: date(s.from) }),
            orgName: s.orgName,
            logoUrl: s.logoUrl,
            typeText: t(`orgType.${s.orgType}`),
          }))}
        ></ol>
      </div>
    </article>
    <article class="at-card">
      <header class="at-card__header"><h2 class="at-card__title">{t('public.lab')}</h2></header>
      <div class="at-card__body">
        {#if lab.total === 0}
          <p class="at-public__note">{t('public.labNone')}</p>
        {:else}
          <dl class="at-card__facts">
            <div><dt>{t('public.labTotal')}</dt><dd>{lab.total}</dd></div
            ><div><dt>{t('public.labPassed')}</dt><dd>{lab.passed}</dd></div
            >{#if lab.lastDate && lab.lastConclusion}<div>
                <dt>{t('public.labLast')}</dt><dd
                  ><span class="at-public__lab-last"
                    >{date(lab.lastDate)}<span class="at-chip" data-tone={lab.lastConclusion === 'PASS' ? 'ok' : 'danger'}
                      >{t(`labConclusion.${lab.lastConclusion}`)}</span
                    ></span
                  ></dd
                >
              </div>
            {/if}
          </dl>
        {/if}
      </div>
    </article>
    <div class="at-public__actions">
      <a class="at-button" data-variant="primary" href="{base}/p/{encodeURIComponent(b.publicCode)}/complaint"
        >{t('public.report')}</a
      >
    </div>
  {/if}
  </div>
</main>
