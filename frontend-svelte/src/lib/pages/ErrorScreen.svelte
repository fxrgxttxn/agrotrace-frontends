<script lang="ts">
  import { t } from '../app/i18n';
  import { session } from '../app/session.svelte';
  import Shell from '../shell/Shell.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import Empty from '../ui/Empty.svelte';
  import type { IllustrationName } from '../ui/illustrations';
  import Page from '../ui/Page.svelte';
  import PageLoading from '../ui/PageLoading.svelte';
  import AuthLayout from './AuthLayout.svelte';

  let { title, art, text }: { title: string; art: IllustrationName; text: string } = $props();
</script>

{#snippet empty(signedIn: boolean)}
  <Empty {art} {text}>
    {#snippet action()}
      <Button variant="primary" href={signedIn ? '/' : '/login'}>{signedIn ? t('action.home') : t('action.login')}</Button>
    {/snippet}
  </Empty>
{/snippet}

{#if session.status === 'loading'}
  <PageLoading />
{:else if session.status === 'authenticated' && session.me}
  <Shell me={session.me}>
    <Page {title}><Card>{@render empty(true)}</Card></Page>
  </Shell>
{:else}
  <AuthLayout {title}>{@render empty(false)}</AuthLayout>
{/if}
