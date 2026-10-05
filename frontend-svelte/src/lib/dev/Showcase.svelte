<script lang="ts">
  import { BATCH_STATUSES } from '@agrotrace/domain';
  import ThemeSwitch from '../shell/ThemeSwitch.svelte';
  import {
    Avatar,
    Button,
    Card,
    CardBody,
    CardFacts,
    CardFooter,
    CardHeader,
    Checkbox,
    Chip,
    Combobox,
    DateInput,
    Dialog,
    Empty,
    Field,
    FieldSet,
    FileField,
    Illustration,
    ILLUSTRATIONS,
    Input,
    InputGroup,
    Metric,
    Page,
    Pagination,
    Progress,
    Radio,
    Select,
    Skeleton,
    Spinner,
    Stepper,
    Switch,
    Table,
    TablePrimary,
    Tabs,
    Textarea,
    Timeline,
    toasts,
    type ComboOption,
    type SortState,
    type Tone,
  } from '../ui';

  const TONES: Tone[] = ['neutral', 'attention', 'ok', 'move', 'danger', 'danger-solid'];
  const PRODUCTS: ComboOption[] = [
    { value: 'w1', label: 'Пшеница озимая', meta: 'Зерно' },
    { value: 'w2', label: 'Пшеница яровая', meta: 'Зерно' },
    { value: 'b1', label: 'Ячмень яровой', meta: 'Зерно' },
    { value: 'm1', label: 'Молоко сырое', meta: 'Молоко', disabled: true },
  ];
  interface Row {
    id: string;
    code: string;
    product: string;
    status: string;
    mass: string;
  }
  const ROWS: Row[] = [
    { id: '1', code: 'AT-2026-000123', product: 'Пшеница озимая', status: 'Approved', mass: '12 480,000' },
    { id: '2', code: 'AT-2026-000118', product: 'Ячмень яровой', status: 'InTransit', mass: '8 050,500' },
    { id: '3', code: 'AT-2026-000097', product: 'Пшеница озимая', status: 'Recalled', mass: '3 900,000' },
  ];

  let query = $state('');
  let chosen = $state<string | null>(null);
  const options = $derived(
    PRODUCTS.filter((o) => o.label.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))),
  );
  let iso = $state<string | null>('2026-08-14');
  let dateError = $state<string | null>(null);
  let sort = $state<SortState | null>(null);
  let selected = $state<Set<string>>(new Set(['1']));
  let open = $state(false);
  let code = $state('');
  let tab = $state('history');
  let on = $state(true);

  const SECTION = 'margin-bottom: var(--sp-8)';
  const HEADING = 'font: 600 var(--fs-18) / var(--lh-18) var(--font-display)';
  const ROW_STYLE = 'display: flex; flex-wrap: wrap; gap: var(--sp-4); align-items: flex-start';
</script>

{#snippet section(id: string, title: string, body: import('svelte').Snippet)}
  <section aria-labelledby="ds-{id}" style={SECTION}>
    <h2 id="ds-{id}" style={HEADING}>{title}</h2>
    <div style={ROW_STYLE}>{@render body()}</div>
  </section>
{/snippet}

{#snippet buttons()}
  <Button variant="primary" icon="truck">Отгрузить</Button>
  <Button>Принять</Button>
  <Button variant="ghost">Отмена</Button>
  <Button variant="danger">Запустить отзыв</Button>
  <Button size="s">Маленькая</Button>
  <Button iconOnly icon="download" aria-label="Скачать список" />
  <Button variant="primary" busy>Сохранить</Button>
  <Button disabled>Недоступна</Button>
{/snippet}

{#snippet fields()}
  <Field id="ds-mass" label="Масса" error="Обязательное поле"><Input /></Field>
  <Field id="ds-inn" label="ИНН"><Input mono inputmode="numeric" value="7701234567" /></Field>
  <Field id="ds-kg" label="Масса"><InputGroup inputmode="decimal" suffix="кг" value="12 480,000" /></Field>
  <Field id="ds-ro" label="Рассчитано"><Input readonly value="98,40 %" /></Field>
  <Field id="ds-cat" label="Категория">
    <Select value="grain"><option value="grain">Зерно</option><option value="milk">Молоко</option></Select>
  </Field>
  <Field id="ds-date" label="Дата уборки" error={dateError ? 'Недопустимый формат даты' : null}>
    <DateInput bind:value={iso} onvalidate={(e) => (dateError = e)} max="2026-09-25" />
  </Field>
  <Field id="ds-product" label="Продукт">
    <Combobox
      listLabel="Продукт"
      bind:query
      {options}
      selected={chosen}
      onselect={(o) => {
        chosen = o.value;
        query = o.label;
      }}
    />
  </Field>
  <Field id="ds-loading" label="Лаборатория">
    <Combobox listLabel="Лаборатория" query="аг" options={[]} loading onselect={() => {}} />
  </Field>
  <Field id="ds-comment" label="Комментарий"><Textarea /></Field>
  <Field id="ds-off" label="Недоступно"><Input disabled /></Field>
{/snippet}

{#snippet choice()}
  <FieldSet legend="Каналы">
    <Checkbox checked>Email</Checkbox>
    <Checkbox>Telegram</Checkbox>
    <Checkbox indeterminate>Частично</Checkbox>
  </FieldSet>
  <FieldSet legend="Решение" direction="row">
    <Radio name="ds-decision" value="APPROVE" checked>Допустить</Radio>
    <Radio name="ds-decision" value="REJECT">Отклонить</Radio>
  </FieldSet>
  <Switch checked={on} onchange={(v) => (on = v)}>Уведомления в Telegram</Switch>
{/snippet}

{#snippet file()}
  <div style="width: min(100%, 420px)">
    <FileField
      id="ds-proto"
      label="Протокол анализа"
      accept="application/pdf,image/*"
      hint="PDF, JPG или PNG до 10 МБ"
      files={[{ key: '1', name: 'protokol.pdf', sizeText: '1,2 МБ', kind: 'PDF', progress: 64 }]}
      onfiles={() => {}}
      onremove={() => {}}
    />
  </div>
  <div style="width: min(100%, 420px)">
    <FileField
      id="ds-proto2"
      label="Протокол анализа"
      accept="application/pdf"
      error="Файл слишком большой"
      files={[{ key: '1', name: 'scan.pdf', sizeText: 'Файл слишком большой', kind: 'PDF', error: true }]}
      onfiles={() => {}}
      onremove={() => {}}
    />
  </div>
{/snippet}

{#snippet chips()}
  {#each BATCH_STATUSES as s (s)}<Chip status={s} />{/each}
  {#each TONES as tone (tone)}<Chip {tone}>{tone}</Chip>{/each}
  <Chip status="Recalled" size="l" />
{/snippet}

{#snippet table()}
  <div style="width: 100%">
    <Table
      cards
      caption="Партии"
      rows={ROWS}
      rowKey={(r) => r.id}
      {sort}
      onsort={(s) => (sort = s)}
      sortOptions={[
        { value: 'massKg,desc', label: 'Масса, по убыванию' },
        { value: 'code,asc', label: 'Код партии' },
      ]}
      selection={{
        selected,
        onchange: (next) => (selected = next),
        allLabel: 'Выбрать все партии',
        rowLabel: (r) => `Выбрать ${r.code}`,
      }}
      columns={[
        { key: 'code', header: 'Партия', primary: true, sortField: 'code' },
        { key: 'status', header: 'Статус', status: true },
        { key: 'mass', header: 'Масса, кг', numeric: true, sortField: 'massKg', text: (r) => r.mass },
      ]}
    >
      {#snippet cell(r, c)}
        {#if c.key === 'code'}<TablePrimary href="/_ds" code={r.code} sub={r.product} />{:else if c.key === 'status'}<Chip
            status={r.status}
          />{:else}{r.mass}{/if}
      {/snippet}
      {#snippet actions(r)}
        {#if r.status === 'Approved'}<Button size="s" icon="truck">Отгрузить</Button>{/if}
      {/snippet}
    </Table>
    <Pagination page={2} size={20} total={248} hrefFor={(p) => `/_ds?page=${p}`} />
  </div>
{/snippet}

{#snippet cards()}
  <div style="width: min(100%, 420px)">
    <Card>
      <CardHeader title="AT-2026-000123"><Chip status="Approved" /></CardHeader>
      <CardBody>
        <CardFacts
          facts={[
            { term: 'Масса', value: '12 480,000 кг' },
            { term: 'Держатель', value: 'КФХ Петров' },
          ]}
        />
      </CardBody>
      <CardFooter><Button variant="primary">Отгрузить</Button></CardFooter>
    </Card>
  </div>
  <div style="width: min(100%, 520px)">
    <Tabs
      label="Партия AT-2026-000123"
      tabs={[
        { id: 'history', label: 'История' },
        { id: 'path', label: 'Путь' },
        { id: 'tests', label: 'Анализы', count: 3 },
      ]}
      selected={tab}
      onselect={(id) => (tab = id)}
    >
      {#snippet panel(id)}
        {#if id === 'history'}
          <Timeline
            items={[
              { key: '1', at: '2026-08-14T08:00', atText: '14.08.2026, 08:00', title: 'Создана', tone: 'neutral' },
              {
                key: '2',
                at: '2026-08-19T11:05',
                atText: '19.08.2026, 11:05',
                title: 'Допущена',
                tone: 'ok',
                meta: 'Мария Соколова, ФГБУ «Липецкая МВЛ»',
              },
            ]}
          >
            {#snippet meta(it)}
              {#if it.key === '2'}<Avatar name="Мария Соколова" size="s" decorative />{/if}{it.meta}
            {/snippet}
          </Timeline>
        {:else if id === 'path'}
          <Stepper label="Переработка" steps={['Входы', 'Выходы', 'Проверка баланса']} current={1} />
        {:else}
          <Progress id="ds-progress" label="Подтверждено" value={7} max={12} />
        {/if}
      {/snippet}
    </Tabs>
  </div>
  <Metric label="Масса на складе" value="212,4" unit="т" spark={[3, 5, 4, 7, 6, 9]} />
  <Metric label="Доля брака" value="2,4" unit="%" tone="danger" spark={[1, 2, 2, 3, 5, 4]} />
  <Progress id="ds-progress-danger" label="Изъято" value={2} max={12} tone="danger" />
{/snippet}

{#snippet feedback()}
  <Button variant="danger" onclick={() => (open = true)}>Запустить отзыв</Button>
  <Button onclick={() => toasts.push({ tone: 'ok', text: 'Партия AT-2026-000123 отгружена' })}>Тост</Button>
  <Button
    onclick={() =>
      toasts.push({ tone: 'danger', text: 'Отгрузка возможна после 25.09.2026', detail: 'Срок ожидания препарата' })}
    >Тост-ошибка</Button
  >
  <Dialog {open} onclose={() => (open = false)} title="Запустить отзыв">
    <Field id="ds-recall-code" label="Код партии"><Input mono autocomplete="off" bind:value={code} /></Field>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (open = false)}>Отмена</Button>
      <Button variant="danger" disabled={code !== 'AT-2026-000123'} onclick={() => (open = false)}
        >Запустить отзыв</Button
      >
    {/snippet}
  </Dialog>
  <Spinner />
  <div aria-busy="true" style="display: grid; gap: var(--sp-2); width: 240px">
    <Skeleton width="60%" />
    <Skeleton shape="block" />
    <Skeleton shape="circle" />
  </div>
  <Avatar name="Иван Петров" />
  <Avatar name="Иван Петров" size="l" />
  <Avatar name="КФХ Петров" shape="square" size="l" />
{/snippet}

{#snippet art()}
  {#each ILLUSTRATIONS as name (name)}
    <Card><CardBody><Illustration {name} /><p class="at-mono">{name}</p></CardBody></Card>
  {/each}
  <Card>
    <Empty art="empty-batches" text="Партий пока нет.">
      {#snippet action()}<Button variant="primary">Зарегистрировать партию</Button>{/snippet}
    </Empty>
  </Card>
{/snippet}

<Page title="Витрина компонентов" main>
  {#snippet actions()}<ThemeSwitch />{/snippet}
  {@render section('buttons', 'at-button', buttons)}
  {@render section('fields', 'at-field, at-input, at-date, at-combobox, at-select', fields)}
  {@render section('choice', 'at-check, at-radio, at-switch', choice)}
  {@render section('file', 'at-file', file)}
  {@render section('chips', 'at-chip', chips)}
  {@render section('table', 'at-table, at-pagination', table)}
  {@render section('card', 'at-card, at-tabs, at-stepper, at-timeline, at-progress, at-metric', cards)}
  {@render section('feedback', 'at-dialog, at-toast, at-spinner, at-skeleton, at-avatar', feedback)}
  {@render section('art', 'Иллюстрации, at-empty', art)}
</Page>
