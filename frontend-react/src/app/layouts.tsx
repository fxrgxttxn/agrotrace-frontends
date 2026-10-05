import type { ReactNode } from 'react';
import { Card, CardBody, Illustration, Page, type IllustrationName } from '../ui';

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
