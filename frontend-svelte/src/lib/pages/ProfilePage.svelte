<script lang="ts">
  import { t } from '../app/i18n';
  import { session } from '../app/session.svelte';
  import ThemeSwitch from '../shell/ThemeSwitch.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import CardBody from '../ui/CardBody.svelte';
  import CardHeader from '../ui/CardHeader.svelte';
  import Page from '../ui/Page.svelte';

  // `/profile` of the app shell: logout and the theme (S2 adds the personal data, avatar, channels, 2FA cards).
</script>

<Page title={t('page.profile')}>
  {#snippet actions()}
    <Button icon="logout" onclick={() => void session.signOut()}>{t('action.logout')}</Button>
  {/snippet}
  <div style="display: grid; gap: var(--sp-4)">
    <Card>
      <CardHeader title={t('profile.appearance')} />
      <CardBody><ThemeSwitch /></CardBody>
    </Card>
  </div>
</Page>
