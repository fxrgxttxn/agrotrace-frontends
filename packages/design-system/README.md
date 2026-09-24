# @agrotrace/design-system — «Поле»

Общие CSS-токены, шрифты и компоненты `at-*` для трёх frontend-реализаций (React, Angular, Svelte).
Разметка в этом файле — **контракт**: каждый фреймворк воспроизводит её один в один (классы, атрибуты,
ARIA), CSS не дублируется и не переопределяется.

Витрина: `packages/design-system/showcase/*.html` (`?theme=light|dark`; без параметра — обе темы рядом).
Проверки: `./at.sh pnpm --filter @agrotrace/design-system test` (контраст, отсутствие цветов-литералов),
`./at.sh ds:test` (axe, скриншоты, 360 px — в контейнере Playwright).

## Подключение

```ts
import '@agrotrace/design-system/index.css'; // шрифты + токены + база + компоненты
```

Шрифты (Geologica 600/700, Onest 400/500/600, JetBrains Mono 400/500; latin + cyrillic) лежат в `fonts/`
и подключаются из `fonts.css`; пересборка — `pnpm --filter @agrotrace/design-system fonts`.

## Темы и токены

- Светлая тема — `:root`; тёмная — по `prefers-color-scheme: dark` (если на `<html>` нет `data-theme="light"`)
  или явно `data-theme="dark"`. Переключатель в профиле ставит `data-theme` на `<html>`; «системная» — снимает.
- `data-theme` на любом элементе переключает тему только внутри него.
- Цвета — только `var(--c-*)` / `var(--status-*)`; литералы цветов допустимы лишь в `tokens.css` (тест).
- `--c-ink-muted` не используется для текста на `--c-surface-sunk` (контраст ниже 4.5).
- Группы статусов: `--status-{neutral|attention|ok|move|danger|danger-solid}-{bg|fg}`; для графа и графиков —
  `--status-<kebab-статус>-{bg|fg}` (например `--status-recalled-bg`) и `--status-recalled`.
- Отступы `--sp-1…--sp-12`, радиусы `--r-s|m|l|pill`, тень `--shadow-1`, шрифты `--font-display|body|mono`,
  шкала `--fs-12…--fs-36` + `--lh-*`, движение `--dur-fast`, `--dur`, `--ease`.
- `--touch` — минимальная зона нажатия: 40 px, 44 px при ширине < 768 px. `--gutter` — поля страницы (32/24/16).
- Брейкпоинты (в `@media` — числами): 360 / 768 / 1024 / 1280.

## База

- `.at-mono` — коды партий, номера накладных, ИНН.
- `.at-visually-hidden` — текст только для экранных дикторов.
- Фокус — `:focus-visible`, кольцо 2 px `--c-focus`, отступ 2 px. Не убирать `outline` в компонентах фреймворков.
- `prefers-reduced-motion: reduce` отключает все анимации и переходы.

---

## Формы

### Кнопка `at-button`

```html
<button class="at-button" type="button" data-variant="primary" data-size="m">
  <svg class="at-button__icon" aria-hidden="true"><use href="#i-truck" /></svg>
  Отгрузить
</button>
```

| Атрибут                             | Значения                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `data-variant`                      | `primary` (основное действие экрана, одно), `secondary` (по умолчанию), `ghost`, `danger` (необратимые: «Запустить отзыв») |
| `data-size`                         | `m` (по умолчанию, 40/44 px), `s` (32 px видимой высоты, зона нажатия остаётся 40/44 px)                                   |
| `data-icon-only`                    | квадратная кнопка из одной иконки; **обязателен** `aria-label`                                                             |
| `disabled` / `aria-disabled="true"` | недоступна (`aria-disabled` — когда нужен фокус и подсказка)                                                               |
| `aria-busy="true"`                  | выполняется: подпись скрыта, на её месте три «борозды»; клики не проходят                                                  |

Ссылка-кнопка: `<a class="at-button" href="…">` — те же атрибуты. Текст кнопки называет результат («Принять», «Отгрузить»).
Клавиатура: нативная (Enter/Space).

### Поле формы `at-field`

```html
<div class="at-field" data-invalid>
  <label class="at-field__label" for="mass">Масса</label>
  <input class="at-input" id="mass" aria-invalid="true" aria-describedby="mass-error" />
  <p class="at-field__error" id="mass-error" role="alert">Обязательное поле</p>
</div>
```

- Элемент ошибки выводится **только** при ошибке; `data-invalid` на `.at-field`, `aria-invalid="true"` и
  `aria-describedby` — на контроле. Без подсказок-пояснений под полями.
- Группа флажков/переключателей: `<fieldset class="at-field"><legend class="at-field__label">…</legend>
  <div class="at-field__options" data-direction="column">…</div></fieldset>`.

### Текстовые поля

```html
<input class="at-input" id="name" /> <input class="at-input at-mono" id="inn" inputmode="numeric" />
<!-- коды, ИНН -->
<textarea class="at-textarea" id="comment"></textarea>
<input class="at-input" type="date" id="harvestedAt" />
<!-- at-date: нативный календарь -->
```

Состояния: hover, focus (граница `--c-field` + кольцо), `aria-invalid="true"`, `disabled`, `readonly`
(пунктирная граница — рассчитанные значения). На < 768 px текст 16 px (iOS не масштабирует).

### Поле с единицей `at-input-group`

```html
<div class="at-input-group">
  <input class="at-input" id="mass" inputmode="decimal" />
  <span class="at-input-group__suffix">кг</span>
</div>
```

Число выравнивается вправо, к единице (`кг`, `га`, `мг/кг`). Ошибка и недоступность берутся с вложенного `input`.

### Список `at-select`

```html
<select class="at-select" id="category">
  <option>Зерно</option>
</select>
```

Нативный `<select>`; клавиатура — нативная.

### Поиск с подсказками `at-combobox`

```html
<div class="at-combobox">
  <input
    class="at-input"
    id="product"
    role="combobox"
    aria-autocomplete="list"
    autocomplete="off"
    aria-expanded="true"
    aria-controls="product-list"
    aria-activedescendant="product-opt-2"
  />
  <ul class="at-combobox__list" role="listbox" id="product-list" aria-label="Продукт">
    <li role="option" id="product-opt-1" aria-selected="true">
      <span>Пшеница озимая</span><span class="at-combobox__meta">Зерно</span>
    </li>
    <li role="option" id="product-opt-2" aria-selected="false" data-active>
      <span><mark>Пше</mark>ница яровая</span>
    </li>
    <li role="option" id="product-opt-3" aria-selected="false" aria-disabled="true">…</li>
  </ul>
</div>
```

- Закрыт: `aria-expanded="false"` на поле и `hidden` на списке.
- `data-active` — подсвеченный с клавиатуры вариант (тот же, что в `aria-activedescendant`); `aria-selected="true"` — выбранный.
- Загрузка/пусто — строка `<li class="at-combobox__status" role="presentation">` (при загрузке: `<span class="at-spinner" aria-hidden="true"></span>Поиск`, поле с `aria-busy="true"`; пусто: «Ничего не найдено.»).
- Серверный поиск: запрос с задержкой ~250 мс после ввода; совпадение выделяется `<mark>`.
- Клавиатура: ↓ — открыть / следующий; ↑ — предыдущий; Home / End — первый / последний (при открытом списке);
  Enter — выбрать подсвеченный и закрыть; Esc — закрыть без выбора; Tab — закрыть, фокус дальше.
  Фокус остаётся на поле; клик по варианту не уводит фокус (`mousedown` → `preventDefault`).

### Флажок `at-check`, переключатель `at-radio`

```html
<label class="at-check"><input type="checkbox" /><span>Email</span></label>
<label class="at-radio"><input type="radio" name="decision" value="APPROVE" /><span>Допустить</span></label>
```

Нативные контролы: Space — отметить; стрелки — переход между `radio` одной группы. Частичный выбор — свойство
`indeterminate` (JS). Ошибка — `aria-invalid="true"` на `input`. Высота строки — `--touch`.

### Выключатель `at-switch`

```html
<button class="at-switch" type="button" role="switch" aria-checked="true">Уведомления в Telegram</button>
```

Текст кнопки — доступное имя. Enter/Space переключают `aria-checked`. Недоступен — `disabled`.

### Файл `at-file`

```html
<div class="at-field">
  <span class="at-field__label" id="proto-label">Протокол анализа</span>
  <div class="at-file">
    <!-- data-dragover пока файл над зоной; data-invalid при ошибке -->
    <label class="at-file__drop">
      <input type="file" accept="application/pdf,image/*" aria-labelledby="proto-label" />
      <svg class="at-file__icon" aria-hidden="true"><use href="#i-upload" /></svg>
      <span class="at-file__action">Выбрать файл</span>
      <span class="at-file__hint">PDF, JPG или PNG до 10 МБ</span>
    </label>
    <ul class="at-file__list">
      <li class="at-file__item">
        <!-- data-error: ошибка файла, текст в .at-file__size -->
        <span class="at-file__preview"><img src="blob:…" alt="" /></span>
        <!-- или текст «PDF» с aria-hidden -->
        <span class="at-file__body">
          <span class="at-file__name">protokol.pdf</span>
          <span class="at-file__size">1,2 МБ</span>
          <progress
            class="at-file__progress"
            max="100"
            value="64"
            aria-label="Загрузка protokol.pdf"
          ></progress>
        </span>
        <button
          class="at-button"
          data-variant="ghost"
          data-size="s"
          data-icon-only
          type="button"
          aria-label="Удалить protokol.pdf"
        >
          <svg class="at-button__icon" aria-hidden="true"><use href="#i-close" /></svg>
        </button>
      </li>
    </ul>
  </div>
</div>
```

`input[type=file]` скрыт визуально, но фокусируем: Tab — на зону, Enter/Space — диалог выбора. Перетаскивание:
`dragover`/`dragleave`/`drop` на `.at-file` ставят/снимают `data-dragover`. Элемент файла — «семенная бирка».
`progress` — только пока идёт загрузка.

### Индикатор `at-spinner`

`<span class="at-spinner" aria-hidden="true"></span>` — три борозды, прорисовываются слева направо (без вращения).
Цвет — `currentColor`. Состояние загрузки области сообщается `aria-busy="true"` на ней.
