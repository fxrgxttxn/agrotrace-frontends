<script lang="ts">
  import { t } from './i18n';
  import DateInput from '../ui/DateInput.svelte';
  import Field from '../ui/Field.svelte';

  let {
    id,
    label,
    value,
    min,
    max,
    onchange,
  }: {
    id: string;
    label: string;
    value: string;
    min?: string;
    max?: string;
    onchange: (iso: string | null) => void;
  } = $props();

  let latest: string | null = null;
  $effect.pre(() => {
    latest = value || null;
  });
  let error = $state<string | null>(null);
</script>

<Field {id} {label} error={error ? t(error) : null}>
  <DateInput
    value={value || null}
    {min}
    {max}
    onchange={(iso) => {
      latest = iso;
      if (iso && iso !== value) onchange(iso);
    }}
    onvalidate={(err) => {
      error = err;
      if (!err && latest === null && value) onchange(null);
    }}
  />
</Field>
