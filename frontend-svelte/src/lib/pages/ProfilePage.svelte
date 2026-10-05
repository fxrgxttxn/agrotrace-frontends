<script lang="ts">
  import { t } from '../app/i18n';
  import { session } from '../app/session.svelte';
  import ThemeSwitch from '../shell/ThemeSwitch.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import CardBody from '../ui/CardBody.svelte';
  import CardHeader from '../ui/CardHeader.svelte';
  import Page from '../ui/Page.svelte';
  import { CARD_GRID } from './layout';
  import AvatarCard from './profile/AvatarCard.svelte';
  import ChannelsCard from './profile/ChannelsCard.svelte';
  import PersonalCard from './profile/PersonalCard.svelte';
  import TwoFactorCard from './profile/TwoFactorCard.svelte';

  const me = $derived(session.me);
  const tfa = $derived(!!me && (me.roles.includes('INSPECTOR') || me.roles.includes('ADMIN')));
</script>

<Page title={t('page.profile')}>
  {#snippet actions()}
    <Button icon="logout" onclick={() => void session.signOut()}>{t('action.logout')}</Button>
  {/snippet}
  {#if me}
    <div style={CARD_GRID}>
      <PersonalCard {me} />
      <AvatarCard {me} />
      <ChannelsCard />
      {#if tfa}<TwoFactorCard {me} />{/if}
      <Card>
        <CardHeader title={t('profile.appearance')} />
        <CardBody><ThemeSwitch /></CardBody>
      </Card>
    </div>
  {/if}
</Page>
