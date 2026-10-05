import { useState, type ReactNode } from 'react';
import { BATCH_STATUSES } from '@agrotrace/domain';
import { BarChart } from '../charts/BarChart';
import { ThemeSwitch } from '../shell/ThemeSwitch';
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
  useToast,
  type ComboOption,
  type IllustrationName,
  type SortState,
  type Tone,
} from '../ui';

const ARTS: IllustrationName[] = [
  'empty-fields',
  'empty-batches',
  'empty-waybills',
  'empty-lab',
  'empty-recalls',
  'empty-complaints',
  'empty-notifications',
  'empty-search',
  'not-found',
  'forbidden',
  'login',
  'recall-warning',
];
const TONES: Tone[] = ['neutral', 'attention', 'ok', 'move', 'danger', 'danger-solid'];
const PRODUCTS: ComboOption[] = [
  { value: 'w1', label: 'Пшеница озимая', meta: 'Зерно' },
  { value: 'w2', label: 'Пшеница яровая', meta: 'Зерно' },
  { value: 'b1', label: 'Ячмень яровой', meta: 'Зерно' },
  { value: 'm1', label: 'Молоко сырое', meta: 'Молоко', disabled: true },
];
const ROWS = [
  { id: '1', code: 'AT-2026-000123', product: 'Пшеница озимая', status: 'Approved', mass: '12 480,000' },
  { id: '2', code: 'AT-2026-000118', product: 'Ячмень яровой', status: 'InTransit', mass: '8 050,500' },
  { id: '3', code: 'AT-2026-000097', product: 'Пшеница озимая', status: 'Recalled', mass: '3 900,000' },
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`ds-${id}`} style={{ marginBottom: 'var(--sp-8)' }}>
      <h2 id={`ds-${id}`} style={{ font: '600 var(--fs-18) / var(--lh-18) var(--font-display)' }}>
        {title}
      </h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
        {children}
      </div>
    </section>
  );
}

function ComboDemo() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const options = PRODUCTS.filter((o) =>
    o.label.toLocaleLowerCase('ru').includes(q.trim().toLocaleLowerCase('ru')),
  );
  return (
    <Field id="ds-product" label="Продукт">
      <Combobox
        listLabel="Продукт"
        query={q}
        onQueryChange={setQ}
        options={options}
        selected={sel}
        onSelect={(o) => {
          setSel(o.value);
          setQ(o.label);
        }}
      />
    </Field>
  );
}

function DateDemo() {
  const [iso, setIso] = useState<string | null>('2026-08-14');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Field id="ds-date" label="Дата уборки" error={err ? 'Недопустимый формат даты' : null}>
      <DateInput value={iso} onChange={setIso} onValidate={(e) => setErr(e)} max="2026-09-25" />
    </Field>
  );
}

function TableDemo() {
  const [sort, setSort] = useState<SortState | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set(['1']));
  return (
    <div style={{ width: '100%' }}>
      <Table
        cards
        caption="Партии"
        rows={ROWS}
        rowKey={(r) => r.id}
        sort={sort}
        onSort={setSort}
        sortOptions={[
          { value: 'massKg,desc', label: 'Масса, по убыванию' },
          { value: 'code,asc', label: 'Код партии' },
        ]}
        selection={{
          selected: sel,
          onChange: setSel,
          allLabel: 'Выбрать все партии',
          rowLabel: (r) => `Выбрать ${r.code}`,
        }}
        columns={[
          {
            key: 'code',
            header: 'Партия',
            primary: true,
            sortField: 'code',
            cell: (r) => <TablePrimary to="/_ds" code={r.code} sub={r.product} />,
          },
          { key: 'status', header: 'Статус', status: true, cell: (r) => <Chip status={r.status} /> },
          { key: 'mass', header: 'Масса, кг', numeric: true, sortField: 'massKg', cell: (r) => r.mass },
        ]}
        actions={(r) =>
          r.status === 'Approved' ? (
            <Button size="s" icon="truck">
              Отгрузить
            </Button>
          ) : null
        }
      />
      <Pagination page={2} size={20} total={248} hrefFor={(p) => `/_ds?page=${p}`} />
    </div>
  );
}

function OverlayDemo() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const toast = useToast();
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Запустить отзыв
      </Button>
      <Button onClick={() => toast.push({ tone: 'ok', text: 'Партия AT-2026-000123 отгружена' })}>
        Тост
      </Button>
      <Button
        onClick={() =>
          toast.push({
            tone: 'danger',
            text: 'Отгрузка возможна после 25.09.2026',
            detail: 'Срок ожидания препарата',
          })
        }
      >
        Тост-ошибка
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Запустить отзыв"
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button variant="danger" disabled={code !== 'AT-2026-000123'} onClick={() => setOpen(false)}>
              Запустить отзыв
            </Button>
          </>
        }
      >
        <Field id="ds-recall-code" label="Код партии">
          <Input mono autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}

export function Showcase() {
  const [tab, setTab] = useState('history');
  const [on, setOn] = useState(true);
  return (
    <Page title="Витрина компонентов" main actions={<ThemeSwitch />}>
      <Section id="buttons" title="at-button">
        <Button variant="primary" icon="truck">
          Отгрузить
        </Button>
        <Button>Принять</Button>
        <Button variant="ghost">Отмена</Button>
        <Button variant="danger">Запустить отзыв</Button>
        <Button size="s">Маленькая</Button>
        <Button iconOnly icon="download" aria-label="Скачать список" />
        <Button variant="primary" busy>
          Сохранить
        </Button>
        <Button disabled>Недоступна</Button>
      </Section>

      <Section id="fields" title="at-field, at-input, at-date, at-combobox, at-select">
        <Field id="ds-mass" label="Масса" error="Обязательное поле">
          <Input />
        </Field>
        <Field id="ds-inn" label="ИНН">
          <Input mono inputMode="numeric" defaultValue="7701234567" />
        </Field>
        <Field id="ds-kg" label="Масса">
          <InputGroup inputMode="decimal" suffix="кг" defaultValue="12 480,000" />
        </Field>
        <Field id="ds-ro" label="Рассчитано">
          <Input readOnly value="98,40 %" />
        </Field>
        <Field id="ds-cat" label="Категория">
          <Select defaultValue="grain">
            <option value="grain">Зерно</option>
            <option value="milk">Молоко</option>
          </Select>
        </Field>
        <DateDemo />
        <ComboDemo />
        <Field id="ds-loading" label="Лаборатория">
          <Combobox
            listLabel="Лаборатория"
            query="аг"
            onQueryChange={() => {}}
            options={[]}
            loading
            onSelect={() => {}}
          />
        </Field>
        <Field id="ds-comment" label="Комментарий">
          <Textarea />
        </Field>
        <Field id="ds-off" label="Недоступно">
          <Input disabled />
        </Field>
      </Section>

      <Section id="choice" title="at-check, at-radio, at-switch">
        <FieldSet legend="Каналы">
          <Checkbox defaultChecked>Email</Checkbox>
          <Checkbox>Telegram</Checkbox>
          <Checkbox indeterminate>Частично</Checkbox>
        </FieldSet>
        <FieldSet legend="Решение" direction="row">
          <Radio name="ds-decision" value="APPROVE" defaultChecked>
            Допустить
          </Radio>
          <Radio name="ds-decision" value="REJECT">
            Отклонить
          </Radio>
        </FieldSet>
        <Switch checked={on} onChange={setOn}>
          Уведомления в Telegram
        </Switch>
      </Section>

      <Section id="file" title="at-file">
        <div style={{ width: 'min(100%, 420px)' }}>
          <FileField
            id="ds-proto"
            label="Протокол анализа"
            accept="application/pdf,image/*"
            hint="PDF, JPG или PNG до 10 МБ"
            files={[{ key: '1', name: 'protokol.pdf', sizeText: '1,2 МБ', kind: 'PDF', progress: 64 }]}
            onFiles={() => {}}
            onRemove={() => {}}
          />
        </div>
        <div style={{ width: 'min(100%, 420px)' }}>
          <FileField
            id="ds-proto2"
            label="Протокол анализа"
            accept="application/pdf"
            error="Файл слишком большой"
            files={[
              { key: '1', name: 'scan.pdf', sizeText: 'Файл слишком большой', kind: 'PDF', error: true },
            ]}
            onFiles={() => {}}
            onRemove={() => {}}
          />
        </div>
      </Section>

      <Section id="chips" title="at-chip">
        {BATCH_STATUSES.map((s) => (
          <Chip key={s} status={s} />
        ))}
        {TONES.map((tone) => (
          <Chip key={tone} tone={tone}>
            {tone}
          </Chip>
        ))}
        <Chip status="Recalled" size="l" />
      </Section>

      <Section id="table" title="at-table, at-pagination">
        <TableDemo />
      </Section>

      <Section id="card" title="at-card, at-tabs, at-stepper, at-timeline, at-progress, at-metric">
        <div style={{ width: 'min(100%, 420px)' }}>
          <Card>
            <CardHeader title="AT-2026-000123">
              <Chip status="Approved" />
            </CardHeader>
            <CardBody>
              <CardFacts
                facts={[
                  { term: 'Масса', value: '12 480,000 кг' },
                  { term: 'Держатель', value: 'КФХ Петров' },
                ]}
              />
            </CardBody>
            <CardFooter>
              <Button variant="primary">Отгрузить</Button>
            </CardFooter>
          </Card>
        </div>
        <div style={{ width: 'min(100%, 520px)' }}>
          <Tabs
            label="Партия AT-2026-000123"
            tabs={[
              { id: 'history', label: 'История' },
              { id: 'path', label: 'Путь' },
              { id: 'tests', label: 'Анализы', count: 3 },
            ]}
            selected={tab}
            onSelect={setTab}
            panel={(id) =>
              id === 'history' ? (
                <Timeline
                  items={[
                    {
                      key: '1',
                      at: '2026-08-14T08:00',
                      atText: '14.08.2026, 08:00',
                      title: 'Создана',
                      tone: 'neutral',
                    },
                    {
                      key: '2',
                      at: '2026-08-19T11:05',
                      atText: '19.08.2026, 11:05',
                      title: 'Допущена',
                      tone: 'ok',
                      meta: (
                        <>
                          <Avatar name="Мария Соколова" size="s" decorative />
                          Мария Соколова, ФГБУ «Липецкая МВЛ»
                        </>
                      ),
                    },
                  ]}
                />
              ) : id === 'path' ? (
                <Stepper label="Переработка" steps={['Входы', 'Выходы', 'Проверка баланса']} current={1} />
              ) : (
                <Progress id="ds-progress" label="Подтверждено" value={7} max={12} />
              )
            }
          />
        </div>
        <Metric label="Масса на складе" value="212,4" unit="т" spark={[3, 5, 4, 7, 6, 9]} />
        <Metric label="Доля брака" value="2,4" unit="%" tone="danger" spark={[1, 2, 2, 3, 5, 4]} />
        <Metric label="Задачи отзыва" value="2" delta="из них просрочено: 1" />
        <Progress id="ds-progress-danger" label="Изъято" value={2} max={12} tone="danger" />
      </Section>

      <Section id="chart" title="at-chart">
        <Card style={{ width: 'min(100%, 36rem)' }}>
          <CardHeader title="Доля брака по продуктам" />
          <CardBody>
            <BarChart
              title="Доля брака по продуктам"
              bars={[
                { key: 'w', label: 'Пшеница озимая', value: 12.5, display: '12,50%' },
                { key: 'm', label: 'Мука пшеничная высшего сорта', value: 4, display: '4,00%' },
                { key: 'b', label: 'Ячмень', value: 0, display: '0,00%' },
              ]}
              columns={[
                { key: 'name', header: 'Продукт', cell: (r: { name: string; share: string }) => r.name },
                { key: 'share', header: 'Доля брака, %', numeric: true, cell: (r) => r.share },
              ]}
              rows={[
                { name: 'Пшеница озимая', share: '12,50' },
                { name: 'Мука пшеничная высшего сорта', share: '4,00' },
                { name: 'Ячмень', share: '0,00' },
              ]}
              rowKey={(r) => r.name}
            />
          </CardBody>
        </Card>
      </Section>

      <Section id="feedback" title="at-dialog, at-toast, at-spinner, at-skeleton, at-avatar">
        <OverlayDemo />
        <Spinner />
        <div aria-busy="true" style={{ display: 'grid', gap: 'var(--sp-2)', width: 240 }}>
          <Skeleton width="60%" />
          <Skeleton shape="block" />
          <Skeleton shape="circle" />
        </div>
        <Avatar name="Иван Петров" />
        <Avatar name="Иван Петров" size="l" />
        <Avatar name="КФХ Петров" shape="square" size="l" />
      </Section>

      <Section id="art" title="Иллюстрации, at-empty">
        {ARTS.map((art) => (
          <Card key={art}>
            <CardBody>
              <Illustration name={art} />
              <p className="at-mono">{art}</p>
            </CardBody>
          </Card>
        ))}
        <Card>
          <Empty
            art="empty-batches"
            text="Партий пока нет."
            action={<Button variant="primary">Зарегистрировать партию</Button>}
          />
        </Card>
      </Section>
    </Page>
  );
}
