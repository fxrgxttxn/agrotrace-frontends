import { withVariant, type PublicBatch, type SafetyStatus } from '@agrotrace/api-client/public';
import { formatLocalDate, photoCredit } from '@agrotrace/i18n/public';
import { ArtSvg } from '../ui/Art';
import { Avatar, CardBody, CardFacts, CardHeader, ChipView, Timeline } from '../ui/DisplayBase';
import { Icon, type IconName } from '../ui/Icon';
import { useBatch } from './data';
import { LOCALE, t } from './i18n';
import { complaintPath, onLink } from './nav';
import { ART, Failed, Loading, NotFound, PublicPage } from './views';

const SAFETY_ICON: Record<SafetyStatus, IconName> = {
  SAFE: 'check',
  RECALLED: 'alert',
  BLOCKED: 'alert',
  UNKNOWN: 'clock',
};

const date = (iso: string) => formatLocalDate(iso, LOCALE);

function Hero({ batch }: { batch: PublicBatch }) {
  const { product, safety } = batch;
  const credit = photoCredit(product.imageUrl);
  return (
    <article className="at-card" data-furrow="">
      <CardBody>
        {safety === 'RECALLED' && (
          <div className="at-public__warning">
            <ArtSvg art={ART.recallWarning} />
            <h2 className="at-public__warning-title">{t('public.recallTitle')}</h2>
            <p className="at-public__warning-text">{t('public.safetyNote.RECALLED')}</p>
          </div>
        )}
        <div className="at-public__hero">
          {product.imageUrl && (
            <figure className="at-public__photo">
              <img
                src={withVariant(product.imageUrl, 480)}
                alt=""
                width={480}
                height={360}
                fetchPriority="high"
              />
              {credit && (
                <figcaption>
                  {t('public.photo')
                    .split(/\{(\w+)\}/)
                    .map((part, i) =>
                      i % 2 === 0 ? (
                        part
                      ) : (
                        <a
                          key={part}
                          href={part === 'author' ? credit.source : credit.licenseUrl}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {part === 'author' ? credit.author : credit.license}
                        </a>
                      ),
                    )}
                </figcaption>
              )}
            </figure>
          )}
          <div className="at-public__summary">
            <p className="at-public__status" data-safety={safety}>
              <Icon name={SAFETY_ICON[safety]} className="at-public__status-icon" />
              {t(`status.safety.${safety}`)}
            </p>
            {(safety === 'BLOCKED' || safety === 'UNKNOWN') && (
              <p className="at-public__note">{t(`public.safetyNote.${safety}`)}</p>
            )}
            <CardFacts
              facts={[{ term: t('public.code'), value: <span className="at-mono">{batch.publicCode}</span> }]}
            />
          </div>
        </div>
      </CardBody>
    </article>
  );
}

function Origin({ batch }: { batch: PublicBatch }) {
  const { origin } = batch;
  const facts = [{ term: t('public.region'), value: origin.region.name }];
  if (batch.harvestedAt) facts.push({ term: t('public.harvestedAt'), value: date(batch.harvestedAt) });
  if (batch.producedAt) facts.push({ term: t('public.producedAt'), value: date(batch.producedAt) });
  return (
    <article className="at-card">
      <CardHeader title={t('public.origin')} />
      <CardBody>
        <p className="at-public__org">
          <Avatar
            name={origin.farmName}
            src={origin.logoUrl ? withVariant(origin.logoUrl, 96) : null}
            size="l"
            shape="square"
            decorative
          />
          <span>
            <span className="at-public__org-type">
              {t(batch.producedAt ? 'public.producer' : 'public.farm')}
            </span>
            {origin.farmName}
          </span>
        </p>
        <CardFacts facts={facts} />
      </CardBody>
    </article>
  );
}

function Path({ batch }: { batch: PublicBatch }) {
  return (
    <article className="at-card">
      <CardHeader title={t('public.path')} />
      <CardBody>
        <Timeline
          items={batch.path.map((s, i) => ({
            key: `${i}`,
            at: s.from,
            atText: s.to
              ? t('public.period', { from: date(s.from), to: date(s.to) })
              : t('public.since', { date: date(s.from) }),
            title: s.orgName,
            meta: (
              <>
                <Avatar
                  name={s.orgName}
                  src={s.logoUrl ? withVariant(s.logoUrl, 96) : null}
                  size="s"
                  shape="square"
                  decorative
                />
                {t(`orgType.${s.orgType}`)}
              </>
            ),
          }))}
        />
      </CardBody>
    </article>
  );
}

function Lab({ batch }: { batch: PublicBatch }) {
  const lab = batch.labSummary;
  return (
    <article className="at-card">
      <CardHeader title={t('public.lab')} />
      <CardBody>
        {lab.total === 0 ? (
          <p className="at-public__note">{t('public.labNone')}</p>
        ) : (
          <CardFacts
            facts={[
              { term: t('public.labTotal'), value: lab.total },
              { term: t('public.labPassed'), value: lab.passed },
              ...(lab.lastDate && lab.lastConclusion
                ? [
                    {
                      term: t('public.labLast'),
                      value: (
                        <span className="at-public__lab-last">
                          {date(lab.lastDate)}
                          <ChipView tone={lab.lastConclusion === 'PASS' ? 'ok' : 'danger'}>
                            {t(`labConclusion.${lab.lastConclusion}`)}
                          </ChipView>
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </CardBody>
    </article>
  );
}

export function BatchPage({ code }: { code: string }) {
  const { state, retry } = useBatch(code);
  const title = state.status === 'ok' ? state.batch.product.name : t('page.publicBatch');
  return (
    <PublicPage title={title}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'notFound' && <NotFound />}
      {state.status === 'failed' && <Failed failure={state.failure} busy={state.busy} onRetry={retry} />}
      {state.status === 'ok' && (
        <>
          <Hero batch={state.batch} />
          <Origin batch={state.batch} />
          <Path batch={state.batch} />
          <Lab batch={state.batch} />
          <div className="at-public__actions">
            <a
              className="at-button"
              data-variant="primary"
              href={complaintPath(state.batch.publicCode)}
              onClick={onLink}
            >
              {t('public.report')}
            </a>
          </div>
        </>
      )}
    </PublicPage>
  );
}
