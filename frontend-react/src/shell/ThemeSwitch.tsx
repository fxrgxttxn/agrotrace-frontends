import { t } from '../app/i18n';
import { useTheme, type ThemeChoice } from '../app/theme';
import { FieldSet, Radio } from '../ui';

const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];

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
