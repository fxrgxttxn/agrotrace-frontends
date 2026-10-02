<script lang="ts">
  import ru from '@agrotrace/i18n/public/ru.json';
  import { publicT } from '@agrotrace/i18n/public';

  // Public QR pages (/p/:publicCode, /p/:publicCode/complaint): no session, no shell, no cabinet module (spec §9.6;
  // S8 fills them in and keeps the public path light). Same markup as the React public entry. Ruling FM35: the
  // public page imports only `@agrotrace/i18n/public` plus the active locale's subset dictionary, never the full
  // `@agrotrace/i18n` (JS budget, spec §9.6).
  const t = publicT(ru, 'ru');

  let { kind, code }: { kind: 'batch' | 'complaint' | 'none'; code?: string } = $props();

  const title = $derived(
    kind === 'batch' ? t('page.publicBatch') : kind === 'complaint' ? t('page.publicComplaint') : t('public.notFound'),
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
