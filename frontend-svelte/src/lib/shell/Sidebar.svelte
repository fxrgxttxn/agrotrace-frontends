<script lang="ts">
  import { t } from '../app/i18n';
  import { isCurrent, type NavItem } from '../app/nav';
  import { withBase } from '../app/paths';
  import Icon from '../ui/Icon.svelte';
  import BrandMark from './BrandMark.svelte';

  let { items, pathname }: { items: NavItem[]; pathname: string } = $props();
</script>

<nav class="at-sidebar" aria-label={t('shell.mainMenu')}>
  <a class="at-sidebar__brand" href={withBase('/')} title="AgroTrace"><BrandMark /><span class="at-sidebar__label">AgroTrace</span></a>
  <ul class="at-sidebar__list">
    {#each items as item (item.key)}
      <li>
        <a
          class="at-sidebar__link"
          href={withBase(item.href)}
          aria-current={isCurrent(item, pathname) ? 'page' : undefined}
          title={t(item.label)}
        >
          <Icon name={item.icon} class="at-sidebar__icon" />
          <span class="at-sidebar__label">{t(item.label)}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>
