<script lang="ts">
  import { localDate } from './dates';
  import type { SchemaForm } from './forms.svelte';
  import DateInput from '../ui/DateInput.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';

  let {
    f,
    id,
    dateName,
    timeName,
    dateLabel,
    timeLabel,
  }: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    f: SchemaForm<any, any>;
    id: string;
    dateName: string;
    timeName: string;
    dateLabel: string;
    timeLabel: string;
  } = $props();
</script>

<div style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr))">
  <Field id="{id}-date" label={dateLabel} error={f.error(dateName)}>
    <DateInput
      name={dateName}
      bind:value={f.values[dateName]}
      max={localDate()}
      onvalidate={(err) => f.mark(dateName, err)}
    />
  </Field>
  <Field id="{id}-time" label={timeLabel} error={f.error(timeName)}>
    <Input type="time" name={timeName} bind:value={f.values[timeName]} />
  </Field>
</div>
