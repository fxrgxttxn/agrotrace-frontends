import type { ReactNode } from 'react';
import { Card, CardBody, Illustration, Page, type IllustrationName } from '../ui';

// Screens outside the cabinet shell (login, 2FA, password, registration, invite, 403/404 without a session, the
// «unavailable» screen): a narrow `at-page` with its header (README «Страница») and the content in a card below. Only
// the login screen carries the furrow band (README «Карточка»).

const NARROW = { maxWidth: '30rem' } as const;
const CENTERED = { display: 'block', marginInline: 'auto' } as const;

export function AuthLayout({
  title,
  furrow,
  art,
  children,
}: {
  title: string;
  furrow?: boolean;
  art?: IllustrationName;
  children: ReactNode;
}) {
  return (
    <Page title={title} main style={NARROW}>
      <Card furrow={furrow}>
        <CardBody>
          {art && <Illustration name={art} style={CENTERED} />}
          {children}
        </CardBody>
      </Card>
    </Page>
  );
}
