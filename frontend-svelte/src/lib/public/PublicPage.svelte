<script lang="ts">
  import { createT } from '@agrotrace/i18n';

  // Public QR pages (/p/:publicCode, /p/:publicCode/complaint): no session, no shell, no cabinet module (spec §9.6;
  // S8 fills them in and keeps the public path light). Same markup as the React public entry.
  const t = createT('ru');

  let { kind, code }: { kind: 'batch' | 'complaint' | 'none'; code?: string } = $props();

  const title = $derived(
    kind === 'batch' ? t('page.publicBatch') : kind === 'complaint' ? t('page.publicComplaint') : t('page.notFound'),
  );
  $effect(() => {
    document.title = `${title} — AgroTrace`;
  });
</script>

<main class="at-page" id="main" tabindex="-1">
  <div class="at-page__header">
    <h1 class="at-page__title">{title}</h1>
  </div>
  {#if kind !== 'none' && code !== undefined}<p class="at-mono">{code}</p>{/if}
</main>
