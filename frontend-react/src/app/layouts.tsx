import { useEffect, type ReactNode } from 'react';
import { Card, CardBody, CardHeader, Illustration, type IllustrationName } from '../ui';

// Screens outside the cabinet shell (login, 2FA, password, registration, invite; the «unavailable» screen): one
// narrow column of a design-system page with a card. Only the login screen carries the furrow band (README «Карточка»).

const NARROW = { maxWidth: '30rem' } as const;

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
  useEffect(() => {
    document.title = `${title} — AgroTrace`;
  }, [title]);
  return (
    <main className="at-page" id="main" tabIndex={-1} style={NARROW}>
      <Card furrow={furrow}>
        <CardHeader title={title} level={1} />
        <CardBody>
          {art && <Illustration name={art} style={{ display: 'block', marginInline: 'auto' }} />}
          {children}
        </CardBody>
      </Card>
    </main>
  );
}
