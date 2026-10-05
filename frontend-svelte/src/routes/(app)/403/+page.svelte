<script lang="ts">
  import { t } from '$lib/app/i18n';
  import ErrorScreen from '$lib/pages/ErrorScreen.svelte';
</script>

<ErrorScreen title={t('page.forbidden')} art="forbidden" text={t('empty.forbidden')} />
