<script lang="ts">
  import { t } from '../../app/i18n';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';

  /** An id filter: the URL changes on a whole UUID or when the text is cleared (not while typing). */
  let {
    id,
    label,
    value,
    onchange,
  }: { id: string; label: string; value: string; onchange: (v: string | null) => void } = $props();

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // The URL can change without typing (a narrowing link, «Сбросить фильтры»): the field follows it.
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
