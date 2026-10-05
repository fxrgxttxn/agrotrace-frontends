<script lang="ts">
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
    Toasts,
  } from '../../src/lib/ui';
  import BarChart from '../../src/lib/charts/BarChart.svelte';
  import type { Column } from '../../src/lib/ui/table';

  type ChartRow = { name: string; tested: number; failed: number; share: string };
  const chartColumns: Column<ChartRow>[] = [
    { key: 'name', header: 'Продукт', primary: true, text: (r) => r.name },
    { key: 'tested', header: 'Проверено', numeric: true, text: (r) => String(r.tested) },
    { key: 'failed', header: 'С превышением', numeric: true, text: (r) => String(r.failed) },
    { key: 'share', header: 'Доля брака, %', numeric: true, text: (r) => r.share },
  ];
  const chartRows: ChartRow[] = [{ name: 'Пшеница озимая', tested: 8, failed: 1, share: '12,50' }];

  let { name }: { name: string } = $props();

  const noop = () => {};
  const rows = [{ id: '1', code: 'AT-2026-000123', product: 'Пшеница озимая', status: 'Approved', mass: '12 480,000' }];
  type Row = (typeof rows)[number];
</script>

{#snippet sokolova()}<span class="at-avatar" data-size="s">…</span>Мария Соколова, ФГБУ «Липецкая МВЛ»{/snippet}

{#if name === 'button'}
  <Button variant="primary" size="m" icon="truck">Отгрузить</Button>
{:else if name === 'button-states'}
  <Button variant="primary" busy>Сохранить</Button>
  <Button iconOnly icon="download" aria-label="Скачать список" />
  <Button disabled>Отгрузить</Button>
{:else if name === 'field-error'}
  <Field id="mass" label="Масса" error="Обязательное поле"><Input /></Field>
{:else if name === 'field'}
  <Field id="name" label="Название"><Input /></Field>
{:else if name === 'fieldset'}
  <FieldSet legend="Тема" direction="row">
    <Radio name="theme" value="system">Системная</Radio>
    <Radio name="theme" value="light">Светлая</Radio>
  </FieldSet>
{:else if name === 'inputs'}
  <Input id="name" /> <Input mono id="inn" inputmode="numeric" />
  <Textarea id="comment" />
{:else if name === 'date'}
  <DateInput id="harvestedAt" value="" />
{:else if name === 'input-group'}
  <InputGroup id="mass" inputmode="decimal" suffix="кг" />
{:else if name === 'select'}
  <Select id="category"><option>Зерно</option></Select>
{:else if name === 'combobox'}
  <Combobox
    id="product"
    listLabel="Продукт"
    query="Пше"
    options={[
      { value: 'w', label: 'Пшеница озимая', meta: 'Зерно' },
      { value: 's', label: 'Пшеница яровая' },
      { value: 'x', label: '…', disabled: true },
    ]}
    selected="w"
    onselect={noop}
  />
{:else if name === 'combobox-states'}
  <Combobox id="lab" listLabel="Лаборатория" query="аг" options={[]} loading onselect={noop} />
  <Combobox id="org" listLabel="Организация" query="zz" options={[]} onselect={noop} />
  <Combobox id="region" listLabel="Регион" query="" options={[]} onselect={noop} />
{:else if name === 'combobox-empty'}
  <Combobox id="r" listLabel="Регион" query="" options={[]} onselect={noop} />
{:else if name === 'combobox-closed'}
  <Combobox id="p" listLabel="Продукт" query="" options={[{ value: 'a', label: 'Пшеница' }]} onselect={noop} />
{:else if name === 'check'}
  <Checkbox>Email</Checkbox>
  <Radio name="decision" value="APPROVE">Допустить</Radio>
{:else if name === 'switch'}
  <Switch checked onchange={noop}>Уведомления в Telegram</Switch>
{:else if name === 'file'}
  <FileField
    id="proto"
    label="Протокол анализа"
    accept="application/pdf,image/*"
    hint="PDF, JPG или PNG до 10 МБ"
    files={[{ key: '1', name: 'protokol.pdf', sizeText: '1,2 МБ', previewUrl: 'blob:…', progress: 64 }]}
    onfiles={noop}
    onremove={noop}
  />
{:else if name === 'file-error'}
  <FileField
    id="proto"
    label="Протокол анализа"
    accept="application/pdf"
    error="Файл слишком большой"
    files={[{ key: '1', name: 'protokol.pdf', sizeText: 'Файл слишком большой', kind: 'PDF', error: true }]}
    onfiles={noop}
    onremove={noop}
  />
{:else if name === 'file-empty'}
  <FileField id="f" label="Файл" files={[]} onfiles={noop} onremove={noop} />
{:else if name === 'spinner'}
  <Spinner />
{:else if name === 'chip'}
  <Chip status="Approved" />
  <Chip tone="move">Отправлена</Chip>
{:else if name === 'card'}
  <Card>
    <CardHeader title="…">…</CardHeader>
    <CardBody><CardFacts facts={[{ term: 'Масса', value: '12 480,000 кг' }]} /></CardBody>
    <CardFooter>…кнопки…</CardFooter>
  </Card>
{:else if name === 'table'}
  <Table
    cards
    {rows}
    rowKey={(r: Row) => r.id}
    sort={{ field: 'massKg', dir: 'desc' }}
    onsort={noop}
    sortOptions={[
      { value: 'massKg,desc', label: 'Масса, по убыванию' },
      { value: 'code,asc', label: 'Код партии' },
    ]}
    selection={{
      selected: new Set(['1']),
      onchange: noop,
      allLabel: 'Выбрать все партии',
      rowLabel: (r: Row) => `Выбрать ${r.code}`,
    }}
    columns={[
      { key: 'code', header: 'Партия', primary: true, sortField: 'code' },
      { key: 'status', header: 'Статус', status: true },
      { key: 'mass', header: 'Масса, кг', numeric: true, sortField: 'massKg' },
    ]}
  >
    {#snippet cell(r: Row, c: { key: string })}
      {#if c.key === 'code'}<TablePrimary href="/batches/…" code={r.code} sub={r.product} />{:else if c.key === 'status'}<Chip
          status={r.status}
        />{:else}{r.mass}{/if}
    {/snippet}
    {#snippet actions()}<Button variant="secondary" size="s">Отгрузить</Button>{/snippet}
  </Table>
{:else if name === 'table-unsorted'}
  <Table
    cards
    {rows}
    rowKey={(r: Row) => r.id}
    sort={null}
    onsort={noop}
    sortOptions={[{ value: 'massKg,desc', label: 'Масса, по убыванию' }]}
    columns={[{ key: 'mass', header: 'Масса, кг', numeric: true, sortField: 'massKg', text: (r: Row) => r.mass }]}
  />
{:else if name === 'pagination'}
  <Pagination page={1} size={20} total={248} hrefFor={(p) => `/batches?page=${p}`} />
{:else if name === 'pagination-buttons'}
  <Pagination page={2} size={200} total={450} label="Страницы отклонённых строк" onpage={noop} />
{:else if name === 'tabs'}
  <Tabs
    label="Партия AT-2026-000123"
    tabs={[
      { id: 'history', label: 'История' },
      { id: 'tests', label: 'Анализы', count: 3 },
    ]}
    selected="history"
    onselect={noop}
  >
    {#snippet panel()}…{/snippet}
  </Tabs>
{:else if name === 'dialog'}
  <Dialog open onclose={noop} title="Запустить отзыв" titleId="recall-title">
    <Field id="recall-code" label="Код партии"><Input mono autocomplete="off" /></Field>
    {#snippet actions()}
      <Button variant="ghost">Отмена</Button>
      <Button variant="danger" disabled>Запустить отзыв</Button>
    {/snippet}
  </Dialog>
{:else if name === 'dialog-plain'}
  <Dialog open onclose={noop} title="Просмотр">Текст</Dialog>
{:else if name === 'toasts'}
  <Toasts />
{:else if name === 'stepper'}
  <Stepper label="Переработка" steps={['Входы', 'Выходы', 'Проверка баланса']} current={1} />
{:else if name === 'timeline'}
  <Timeline items={[{ key: '1', at: '2026-08-19T11:05', atText: '19.08.2026, 11:05', title: 'Допущена', tone: 'ok' }]}>
    {#snippet meta()}{@render sokolova()}{/snippet}
  </Timeline>
{:else if name === 'empty'}
  <Empty art="empty-batches" text="Партий пока нет.">
    {#snippet action()}<Button variant="primary">Зарегистрировать партию</Button>{/snippet}
  </Empty>
{:else if name === 'skeleton'}
  <Skeleton width="40%" />
  <Skeleton shape="block" />
{:else if name === 'avatar'}
  <Avatar name="Иван Петров" src="…" />
  <Avatar name="Иван Петров" />
  <Avatar name="КФХ Петров" src="…" size="l" shape="square" />
{:else if name === 'metric'}
  <Metric label="Масса на складе" value="212,4" unit="т" spark={[1, 3, 2, 5]} />
{:else if name === 'progress'}
  <Progress id="recall-progress" label="Подтверждено" value={7} max={12} />
{:else if name === 'chart'}
  <Card>
    <CardHeader title="Доля брака по продуктам" />
    <CardBody>
      <BarChart
        title="Доля брака по продуктам"
        bars={[
          { key: 'w', label: 'Пшеница озимая', value: 12.5, display: '12,50%' },
          { key: 'b', label: 'Ячмень', value: 0, display: '0,00%' },
        ]}
        columns={chartColumns}
        rows={chartRows}
        rowKey={(r) => r.name}
      />
    </CardBody>
  </Card>
{:else if name === 'page'}
  <Page title="Партии">
    {#snippet actions()}<Button variant="primary" href="/batches/new">Зарегистрировать партию</Button>{/snippet}
  </Page>
{/if}
