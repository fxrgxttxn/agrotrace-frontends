import { t } from '../app/i18n';
import { Button } from './Button';
import { Card } from './Display';
import { Empty } from './Illustration';

/** A list or card area that failed to load: what failed, one «Повторить» button (spec §10.1: error = what and what to
 * do). */
export function LoadFailed({ text, busy, onRetry }: { text: string; busy?: boolean; onRetry: () => void }) {
  return (
    <Card>
      <Empty
        art="empty-search"
        text={text}
        action={
          <Button variant="primary" busy={busy} onClick={onRetry}>
            {t('action.retry')}
          </Button>
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
