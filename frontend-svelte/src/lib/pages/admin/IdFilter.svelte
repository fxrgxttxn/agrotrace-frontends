<script lang="ts">
  import { t } from '../../app/i18n';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';

  let {
    id,
    label,
    value,
    onchange,
  }: { id: string; label: string; value: string; onchange: (v: string | null) => void } = $props();

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let text = $derived(value);
  const bad = $derived(text.trim() !== '' && !UUID.test(text.trim()));
</script>

<Field {id} {label} error={bad ? t('validation.uuid') : null}>
  <Input
    mono
    autocomplete="off"
    value={text}
    oninput={(e) => {
      const v = e.currentTarget.value;
      text = v;
      if (v.trim() === '') onchange(null);
      else if (UUID.test(v.trim())) onchange(v.trim().toLowerCase());
    }}
  />
</Field>
