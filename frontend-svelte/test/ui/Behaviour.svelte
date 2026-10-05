<script lang="ts">
  import {
    Button,
    Combobox,
    DateInput,
    Dialog,
    Field,
    Table,
    Tabs,
    Toasts,
    toasts,
    type ComboOption,
    type DateError,
    type SortState,
  } from '../../src/lib/ui';
  import { t } from '../../src/lib/app/i18n';

  let {
    name,
    min,
    max,
    onsearch,
    loading = false,
    options,
    lightDismiss = false,
    elsewhere = false,
  }: {
    name: string;
    min?: string;
    max?: string;
    onsearch?: (q: string) => void;
    loading?: boolean;
    options?: ComboOption[];
    lightDismiss?: boolean;
    elsewhere?: boolean;
  } = $props();

  const OPTIONS: ComboOption[] = [
    { value: '1', label: 'Пшеница озимая', meta: 'Зерно' },
    { value: '2', label: 'Пшеница яровая', disabled: true },
    { value: '3', label: 'Ячмень' },
  ];

  let iso = $state<string | null>('2026-08-14');
  let dateError = $state<DateError | null>(null);
  let q = $state('');
  let sel = $state<string | null>(null);
  let tab = $state('a');
  let open = $state(false);
  let sort = $state<SortState | null>({ field: 'code', dir: 'asc' });
  let selected = $state<Set<string>>(new Set());
  const rows = [
    { id: 'a', code: 'AT-1' },
    { id: 'b', code: 'AT-2' },
  ];
</script>

{#if name === 'date'}
  <Field id="d" label="Дата уборки" error={dateError ? t(dateError) : null}>
    <DateInput bind:value={iso} onvalidate={(e) => (dateError = e)} {min} {max} />
  </Field>
  <output>{iso ?? 'null'}</output>
{:else if name === 'combobox'}
  <Field id="p" label="Продукт">
    <Combobox
      listLabel="Продукт"
      bind:query={q}
      {onsearch}
      options={options ?? OPTIONS}
      {loading}
      selected={sel}
      onselect={(o) => {
        sel = o.value;
        q = o.label;
      }}
    />
  </Field>
{:else if name === 'tabs'}
  <Tabs
    label="Партия"
    tabs={[
      { id: 'a', label: 'История' },
      { id: 'b', label: 'Путь' },
      { id: 'c', label: 'Граф' },
    ]}
    selected={tab}
    onselect={(id) => (tab = id)}
  >
    {#snippet panel(id)}panel {id}{/snippet}
  </Tabs>
{:else if name === 'dialog'}
  <Button onclick={() => (open = true)}>Открыть</Button>
  <Dialog {open} onclose={() => (open = false)} title="Запустить отзыв" {lightDismiss}>
    <label for="code">Код партии</label>
    <input id="code" />
  </Dialog>
{:else if name === 'dialog-mounted'}
  <Button onclick={() => (open = true)}>Открыть</Button>
  <Button>Другое</Button>
  {#if open}
    <Dialog open onclose={() => (open = false)} title="Фото">
      <label for="file">Файл</label>
      <input id="file" />
      <Button
        onclick={() => {
          if (elsewhere) (document.querySelectorAll('button')[1] as HTMLElement).focus();
          open = false;
        }}>Готово</Button
      >
    </Dialog>
  {/if}
{:else if name === 'toasts'}
  <button onclick={() => toasts.push({ tone: 'ok', text: 'тост ok' })}>push ok</button>
  <button onclick={() => toasts.push({ tone: 'danger', text: 'тост danger' })}>push danger</button>
  <Toasts />
{:else if name === 'table'}
  <Table
    cards
    {rows}
    rowKey={(r) => r.id}
    {sort}
    onsort={(s) => (sort = s)}
    sortOptions={[
      { value: 'code,asc', label: 'Код' },
      { value: 'code,desc', label: 'Код, обратно' },
    ]}
    selection={{
      selected,
      onchange: (next) => (selected = next),
      allLabel: 'Выбрать все партии',
      rowLabel: (r) => `Выбрать ${r.code}`,
    }}
    columns={[{ key: 'code', header: 'Партия', sortField: 'code', text: (r) => r.code }]}
  />
{/if}
