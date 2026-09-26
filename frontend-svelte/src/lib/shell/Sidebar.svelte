<script lang="ts">
  import { t } from '../app/i18n';
  import { isCurrent, type NavItem } from '../app/nav';
  import Icon from '../ui/Icon.svelte';
  import BrandMark from './BrandMark.svelte';

  /** `at-sidebar` (README «Боковое меню»): ≥ 1024 px with labels, 768–1023 px icons only (`title` shows the name). */
  /** `pathname`: the section to mark current — the target of a navigation in progress already (FM10). */
  let { items, pathname }: { items: NavItem[]; pathname: string } = $props();
</script>

<nav class="at-sidebar" aria-label={t('shell.mainMenu')}>
  <a class="at-sidebar__brand" href="/" title="AgroTrace"><BrandMark /><span class="at-sidebar__label">AgroTrace</span></a>
  <ul class="at-sidebar__list">
    {#each items as item (item.key)}
      <li>
        <a
          class="at-sidebar__link"
          href={item.href}
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
