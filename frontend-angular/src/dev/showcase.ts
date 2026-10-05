import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { BATCH_STATUSES } from '@agrotrace/domain';
import { ThemeSwitchComponent } from '../app/shell/theme-switch';
import {
  ILLUSTRATIONS,
  ToastService,
  UI,
  type ComboOption,
  type DateError,
  type FileItem,
  type SortState,
  type TimelineEntry,
  type Tone,
} from '../app/ui';

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
const SECTION = 'margin-bottom: var(--sp-8)';
const HEADING = 'font: 600 var(--fs-18) / var(--lh-18) var(--font-display)';
const ROW = 'display: flex; flex-wrap: wrap; gap: var(--sp-4); align-items: flex-start';

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI, ThemeSwitchComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { id: 'main', tabindex: '-1' },
  templateUrl: './showcase.html',
})
export class ShowcasePage {
  protected readonly SECTION = SECTION;
  protected readonly HEADING = HEADING;
  protected readonly ROW = ROW;
  protected readonly statuses = BATCH_STATUSES;
  protected readonly tones = TONES;
  protected readonly arts = ILLUSTRATIONS;
  protected readonly rows = ROWS;
  protected readonly rowKey = (r: Row) => r.id;
  protected readonly rowLabel = (r: Row) => `Выбрать ${r.code}`;
  protected readonly hrefFor = (p: number) => `/_ds?page=${p}`;
  private readonly toasts = inject(ToastService);

  protected readonly on = signal(true);
  protected readonly tab = signal('history');
  protected readonly iso = signal<string | null>('2026-08-14');
  protected readonly dateError = signal<DateError | null>(null);
  protected readonly query = signal('');
  protected readonly chosen = signal<string | null>(null);
  protected readonly options = computed(() =>
    PRODUCTS.filter((o) =>
      o.label.toLocaleLowerCase('ru').includes(this.query().trim().toLocaleLowerCase('ru')),
    ),
  );
  protected readonly sort = signal<SortState | null>(null);
  protected readonly selected = signal<ReadonlySet<string>>(new Set(['1']));
  protected readonly selection = computed(() => ({
    selected: this.selected(),
    allLabel: 'Выбрать все партии',
    rowLabel: this.rowLabel,
  }));
  protected readonly open = signal(false);
  protected readonly code = signal('');
  protected readonly files: FileItem[] = [
    { key: '1', name: 'protokol.pdf', sizeText: '1,2 МБ', kind: 'PDF', progress: 64 },
  ];
  protected readonly badFiles: FileItem[] = [
    { key: '1', name: 'scan.pdf', sizeText: 'Файл слишком большой', kind: 'PDF', error: true },
  ];
  protected readonly timeline: TimelineEntry[] = [
    { key: '1', at: '2026-08-14T08:00', atText: '14.08.2026, 08:00', title: 'Создана', tone: 'neutral' },
    {
      key: '2',
      at: '2026-08-19T11:05',
      atText: '19.08.2026, 11:05',
      title: 'Допущена',
      tone: 'ok',
      meta: 'Мария Соколова, ФГБУ «Липецкая МВЛ»',
    },
  ];

  protected pickProduct(o: ComboOption): void {
    this.chosen.set(o.value);
    this.query.set(o.label);
  }

  protected toast(danger: boolean): void {
    this.toasts.push(
      danger
        ? { tone: 'danger', text: 'Отгрузка возможна после 25.09.2026', detail: 'Срок ожидания препарата' }
        : { tone: 'ok', text: 'Партия AT-2026-000123 отгружена' },
    );
  }
}
