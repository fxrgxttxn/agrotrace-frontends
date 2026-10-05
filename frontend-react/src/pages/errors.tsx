import { t } from '../app/i18n';
import { AuthLayout } from '../app/layouts';
import { useSession } from '../app/session';
import { ButtonLink, Card, Empty, Page, type IllustrationName } from '../ui';

function ErrorScreen({ title, art, text }: { title: string; art: IllustrationName; text: string }) {
  const { state } = useSession();
  const signedIn = state.status === 'authenticated';
  const empty = (
    <Empty
      art={art}
      text={text}
      action={
        <ButtonLink variant="primary" to={signedIn ? '/' : '/login'}>
          {signedIn ? t('action.home') : t('action.login')}
        </ButtonLink>
      }
    />
  );
  if (!signedIn) return <AuthLayout title={title}>{empty}</AuthLayout>;
  return (
    <Page title={title}>
      <Card>{empty}</Card>
    </Page>
  );
}

export function ForbiddenPage() {
  return <ErrorScreen title={t('page.forbidden')} art="forbidden" text={t('empty.forbidden')} />;
}

export function NotFoundPage() {
  return <ErrorScreen title={t('page.notFound')} art="not-found" text={t('empty.notFound')} />;
}
