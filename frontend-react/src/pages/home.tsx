import { t } from '../app/i18n';
import { useSession } from '../app/session';
import { useTheme, type ThemeChoice } from '../app/theme';
import { Button, Card, CardBody, FieldSet, Page, Radio } from '../ui';

export function DashboardPage() {
  return <Page title={t('page.dashboard')} />;
}

const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];

/** Theme choice (spec §9.3: system by default, light, dark). */
export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return (
    <FieldSet legend={t('theme.label')} direction="row">
      {THEMES.map((choice) => (
        <Radio
          key={choice}
          name="theme"
          value={choice}
          checked={theme === choice}
          onChange={() => setTheme(choice)}
        >
          {t(`theme.${choice}`)}
        </Radio>
      ))}
    </FieldSet>
  );
}

export function ProfilePage() {
  const { signOut } = useSession();
  return (
    <Page
      title={t('page.profile')}
      actions={
        <Button icon="logout" onClick={() => void signOut()}>
          {t('action.logout')}
        </Button>
      }
    >
      <Card>
        <CardBody>
          <ThemeSwitch />
        </CardBody>
      </Card>
    </Page>
  );
}

export function NotificationsPage() {
  return <Page title={t('page.notifications')} />;
}
