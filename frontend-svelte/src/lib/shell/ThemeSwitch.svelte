<script lang="ts">
  import { t } from '../app/i18n';
  import { theme, type ThemeChoice } from '../app/theme.svelte';
  import FieldSet from '../ui/FieldSet.svelte';
  import Radio from '../ui/Radio.svelte';

  const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];
</script>

<FieldSet legend={t('theme.label')} direction="row">
  {#each THEMES as choice (choice)}
    <Radio name="theme" value={choice} checked={theme.choice === choice} onchange={() => theme.set(choice)}
      >{t(`theme.${choice}`)}</Radio
    >
  {/each}
</FieldSet>
