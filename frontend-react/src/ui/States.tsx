import { t } from '../app/i18n';
import { Button } from './Button';
import { Card } from './Display';
import { Empty } from './Illustration';

/** A list or card area that failed to load: what failed and one button (spec §10.1: error = what and what to do).
 * With `onReset` (the server rejected the list's filters, 400) the button resets them instead of retrying. */
export function LoadFailed({
  text,
  busy,
  onRetry,
  onReset,
}: {
  text: string;
  busy?: boolean;
  onRetry: () => void;
  onReset?: () => void;
}) {
  return (
    <Card>
      <Empty
        art="empty-search"
        text={onReset ? t('filters.invalid') : text}
        action={
          onReset ? (
            <Button variant="primary" onClick={onReset}>
              {t('filters.reset')}
            </Button>
          ) : (
            <Button variant="primary" busy={busy} onClick={onRetry}>
              {t('action.retry')}
            </Button>
          )
        }
      />
    </Card>
  );
}

/** Loading placeholder of an area (`aria-busy`, README «Загрузка»). */
export function AreaLoading({ blocks = 2 }: { blocks?: number }) {
  return (
    <div aria-busy="true" style={{ display: 'grid', gap: 'var(--sp-3)' }}>
      <span className="at-visually-hidden">{t('shell.loading')}</span>
      {Array.from({ length: blocks }, (_, i) => (
        <span key={i} className="at-skeleton" data-shape="block"></span>
      ))}
    </div>
  );
}
