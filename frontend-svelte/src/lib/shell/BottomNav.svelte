<script lang="ts">
  import { beforeNavigate } from '$app/navigation';
  import { goto } from '../app/goto';
  import { flushSync } from 'svelte';
  import { t } from '../app/i18n';
  import { BOTTOM_NAV_ITEMS, isCurrent, NOTIFICATIONS_ITEM, PROFILE_ITEM, type NavItem } from '../app/nav';
  import { skipRouteFocus } from '../app/routeFocus';
  import Dialog from '../ui/Dialog.svelte';
  import Icon from '../ui/Icon.svelte';

  let { items, pathname }: { items: NavItem[]; pathname: string } = $props();

  let open = $state(false);

  beforeNavigate(() => {
    open = false;
  });
  const main = $derived(items.slice(0, BOTTOM_NAV_ITEMS));
  const more = $derived([...items.slice(BOTTOM_NAV_ITEMS), NOTIFICATIONS_ITEM, PROFILE_ITEM]);
</script>

<nav class="at-bottom-nav" aria-label={t('shell.mainMenu')}>
  {#each main as item (item.key)}
    <a
      class="at-bottom-nav__link"
      href={item.href}
      aria-current={isCurrent(item, pathname) ? 'page' : undefined}
      ><Icon name={item.icon} class="at-bottom-nav__icon" />{t(item.short ?? item.label)}</a
    >
  {/each}
  <button
    class="at-bottom-nav__link"
    type="button"
    aria-expanded={open ? 'true' : 'false'}
    aria-controls="more-menu"
    onclick={() => (open = true)}><Icon name="more" class="at-bottom-nav__icon" />{t('nav.more')}</button
  >
</nav>
<Dialog
  {open}
  onclose={() => (open = false)}
  id="more-menu"
  titleId="more-title"
  title={t('nav.more')}
  lightDismiss
  initialFocus="title"
>
  <nav aria-label={t('shell.otherSections')}>
    <ul class="at-sidebar__list">
      {#each more as item (item.key)}
        <li>
          <a
            class="at-sidebar__link"
            href={item.href}
            aria-current={isCurrent(item, pathname) ? 'page' : undefined}
            onclick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              const here = `${location.pathname}${location.search}` === item.href;
              if (!here) skipRouteFocus(item.href);
              flushSync(() => (open = false));
              void goto(item.href, { keepFocus: true, replaceState: here });
            }}><Icon name={item.icon} class="at-sidebar__icon" /><span class="at-sidebar__label">{t(item.label)}</span></a
          >
        </li>
      {/each}
    </ul>
  </nav>
</Dialog>
