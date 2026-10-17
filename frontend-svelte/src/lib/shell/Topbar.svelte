<script lang="ts">
  import { withVariant, type Me } from '@agrotrace/api-client';
  import { t } from '../app/i18n';
  import { bellCount } from '../app/live.svelte';
  import { withBase } from '../app/paths';
  import Avatar from '../ui/Avatar.svelte';
  import Icon from '../ui/Icon.svelte';

  let { me, unread }: { me: Me; unread: number } = $props();

  const count = $derived(bellCount(unread));
  const logo = $derived(me.organization.logoUrl);
</script>

<header class="at-topbar">
  <div class="at-topbar__org">
    <Avatar name={me.organization.name} src={logo ? withVariant(logo, 96) : null} shape="square" decorative />
    <span class="at-topbar__org-name">{me.organization.name}</span>
  </div>
  <div class="at-topbar__actions">
    <a class="at-bell" href={withBase('/notifications')} aria-label={count ? t('shell.bellUnread', { count }) : t('shell.bell')}>
      <Icon name="bell" class="at-bell__icon" />
      {#if count}<span class="at-bell__count" aria-hidden="true">{count}</span>{/if}
    </a>
    <a class="at-topbar__profile" href={withBase('/profile')} aria-label={t('shell.profileOf', { name: me.fullName })}>
      <Avatar name={me.fullName} src={me.avatarUrl ? withVariant(me.avatarUrl, 96) : null} hidden />
    </a>
  </div>
</header>
