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
- `--c-ink-muted` не используется для текста на `--c-surface-sunk` (контраст ниже 4.5). Текст
  недоступного поля и единица недоступной `at-input-group` (на заливке `--c-surface-sunk`) — `--c-ink-disabled` (≥ 4.5).
- Группы статусов: `--status-{neutral|attention|ok|move|danger|danger-solid}-{bg|fg}`; для графа и графиков —
  `--status-<kebab-статус>-{bg|fg}` (например `--status-recalled-bg`) и `--status-recalled`.
- Отступы `--sp-1…--sp-12`, радиусы `--r-s|m|l|pill`, тень `--shadow-1`, шрифты `--font-display|body|mono`,
  шкала `--fs-12…--fs-36` + `--lh-*`, движение `--dur-fast`, `--dur`, `--ease`.
- `--touch` — минимальная зона нажатия: 40 px, 44 px при ширине < 768 px. `--gutter` — поля страницы (32/24/16).
- Брейкпоинты (в `@media` — числами): 360 / 768 / 1024 / 1280 (и 1440 — ширина, с которой действия строки таблицы
  стоят в ряд, «Таблица»).

## База

- `.at-mono` — коды партий, номера накладных, ИНН.
- `.at-visually-hidden` — текст только для экранных дикторов.
- Фокус — `:focus-visible`, кольцо 2 px `--c-focus`, отступ 2 px. Не убирать `outline` в компонентах фреймворков.
- `prefers-reduced-motion: reduce` отключает все анимации и переходы.

---

## Иконки и иллюстрации

**Иконки** — собственный набор из 40 штук: `icons/<имя>.svg`, список и порядок — `icons/manifest.json`.
Сетка 24, штрих 1.75, скруглённые концы и стыки, `currentColor`, без заливки; геометрия в пределах 2…22
(поле 2 px), радиусы контейнеров 1.5 или 2. Спрайт `sprite.svg` собирается скриптом
(`pnpm --filter @agrotrace/design-system build:sprite`) и коммитится; тест падает, если он устарел.

Спрайт вставляется в документ один раз (первым потомком `<body>`), иконка ссылается на символ `#i-<имя>`:

```html
<svg class="at-button__icon" aria-hidden="true"><use href="#i-truck" /></svg>
```

Размер и цвет задаёт компонент (`width/height`, `color`); иконка без подписи — только внутри элемента с
`aria-label`.

**Иллюстрации** — `illustrations/<имя>.svg`, 240 × 160, плоские, цвета только `style="fill: var(--c-…)"`
(3–4 токена палитры + `--c-surface` для вырезов), мотив борозд. Фреймворки **инлайнят** их как компоненты
(через `<img>` токены не работают и тёмная тема теряется), добавляя `class="at-empty__art" aria-hidden="true"`.
Идентификаторов внутри нет, поэтому несколько иллюстраций на странице не конфликтуют.

Иллюстрация ставится **только на `--c-surface`** (карточка, `at-empty` внутри карточки или страницы с фоном
surface): вырезы нарисованы цветом `--c-surface` и на другом фоне станут видимыми пятнами.

Инлайн по фреймворкам:

- **React** — компонент на каждую иллюстрацию; в JSX атрибут `style` — объект
  (`style={{ fill: 'var(--c-straw)' }}`), `stroke-width` → `strokeWidth` и т.д. Удобнее всего сгенерировать
  компоненты из файлов (например, svgr с сохранением `style`), не переписывать руками.
- **Angular** — разметку SVG вставлять прямо в шаблон компонента. `[innerHTML]` не подходит: санитайзер
  Angular вырезает SVG-элементы и атрибут `style`; `bypassSecurityTrustHtml` не использовать.
- **Svelte** — разметку SVG вставлять прямо в `.svelte`-компонент (атрибут `style` работает как есть).

| Имя                                                                                                                                        | Где                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `empty-fields`, `empty-batches`, `empty-waybills`, `empty-lab`, `empty-recalls`, `empty-complaints`, `empty-notifications`, `empty-search` | пустые состояния                        |
| `not-found`, `forbidden`                                                                                                                   | страницы 404 / 403                      |
| `login`                                                                                                                                    | экран входа                             |
| `recall-warning`                                                                                                                           | предупреждение об отзыве на QR-странице |

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

Состояния. `data-variant` пишется всегда (в том числе `secondary`), `data-size` — только когда задан; так DOM одинаков
во всех трёх фреймворках:

```html
<button class="at-button" type="button" data-variant="primary" aria-busy="true">Сохранить</button>
<button class="at-button" type="button" data-variant="secondary" data-icon-only aria-label="Скачать список">
  <svg class="at-button__icon" aria-hidden="true"><use href="#i-download" /></svg>
</button>
<button class="at-button" type="button" data-variant="secondary" disabled>Отгрузить</button>
```

### Поле формы `at-field`

```html
<div class="at-field" data-invalid>
  <label class="at-field__label" for="mass">Масса</label>
  <input class="at-input" id="mass" aria-invalid="true" aria-describedby="mass-error" />
  <p class="at-field__error" id="mass-error" role="alert">Обязательное поле</p>
</div>
```

- Предупреждение, которое не запрещает действие (живая проверка перед отправкой, например баланс масс переработки), —
  `<p class="at-field__warning">…</p>` в цвете `--status-attention-fg` внутри живой области (`aria-live="polite"`);
  ошибка поля — только `at-field__error`.
- Элемент ошибки выводится **только** при ошибке; `data-invalid` на `.at-field`, `aria-invalid="true"` и
  `aria-describedby` — на контроле. Без подсказок-пояснений под полями. Id ошибки — `<id контрола>-error`.
- Отправка с ошибками (и «Далее» шага мастера — проверка полей этого шага): фокус — на первый контрол с
  `aria-invalid="true"` в порядке формы, включая комбобокс и выбор организации (/recalls/new — партия, /waybills/new —
  получатель), а не на первое поле, известное библиотеке форм. После первой попытки проверенные поля проверяются
  заново при каждом изменении — ошибка уходит, как только значение исправлено.
- Выбор строк таблицы как поле формы («Выберите хотя бы одну партию» — переработка, накладная): ошибка —
  `p.at-field__error` с `role="alert"` и id (`processing-inputs-error`, `waybill-items-error`) над таблицей; пока она
  есть, у флажка каждой строки `aria-invalid="true"` и `aria-describedby` = этот id (флажок «Выбрать все» — без), поэтому
  фокус неудачной отправки или «Далее» — на флажке первой строки.
- Без ошибки — ни `data-invalid`, ни `aria-invalid`, ни элемента ошибки:

```html
<div class="at-field">
  <label class="at-field__label" for="name">Название</label>
  <input class="at-input" id="name" />
</div>
```

- Группа флажков/переключателей (`data-direction`: `column` по умолчанию или `row`):

```html
<fieldset class="at-field">
  <legend class="at-field__label">Тема</legend>
  <div class="at-field__options" data-direction="row">
    <label class="at-radio"><input type="radio" name="theme" value="system" /><span>Системная</span></label>
    <label class="at-radio"><input type="radio" name="theme" value="light" /><span>Светлая</span></label>
  </div>
</fieldset>
```

### Текстовые поля

```html
<input class="at-input" id="name" /> <input class="at-input at-mono" id="inn" inputmode="numeric" />
<!-- коды, ИНН -->
<textarea class="at-textarea" id="comment"></textarea>
```

Состояния: hover, focus (граница `--c-field` + кольцо), `aria-invalid="true"`, `disabled`, `readonly`
(пунктирная граница — рассчитанные значения). На < 768 px текст 16 px (iOS не масштабирует).

### Дата `at-date`

```html
<div class="at-date">
  <input
    class="at-input"
    id="harvestedAt"
    inputmode="numeric"
    placeholder="ДД.ММ.ГГГГ"
    maxlength="10"
    autocomplete="off"
  />
  <button class="at-date__button" type="button" aria-label="Открыть календарь">
    <svg aria-hidden="true"><use href="#i-calendar" /></svg>
  </button>
  <input class="at-date__native" type="date" tabindex="-1" aria-hidden="true" />
</div>
```

Поле всегда показывает и принимает `ДД.ММ.ГГГГ`, независимо от языка браузера (нативный `type="date"` сам по себе
форматирует дату по локали браузера — поэтому он только календарь). Одинаково во всех трёх фреймворках:

- Значение модели — ISO-дата `YYYY-MM-DD` (как в контракте). Показ: `formatRuDate(iso)` из `@agrotrace/i18n`.
- Ввод: на каждое `input` — `text.value = maskRuDateInput(text.value)` (цифры, точки ставятся сами, вставка ISO
  конвертируется). Модель: `parseRuDate(text.value)` → ISO или `null`; `null` при непустом тексте после `blur` —
  ошибка поля `validation.date.format` (`at-field__error`, `aria-invalid`).
- Кнопка календаря: `native.value = parseRuDate(text.value) ?? ''`, затем `native.showPicker()`. На `change` нативного
  поля: `text.value = formatRuDate(native.value)`, фокус возвращается в текстовое поле.
- Клавиатура: Tab — текстовое поле, затем кнопка календаря (Enter/Space открывают его); нативное поле вне порядка
  табуляции (`tabindex="-1"`, `aria-hidden`).
- Ограничения диапазона (`min`/`max`, ISO, включительно) ставятся на нативное поле (календарь не даёт выбрать дату
  вне диапазона) и проверяются для введённого текста: после успешного `parseRuDate` —
  `isWithinRuDateBounds(iso, min, max)` из `@agrotrace/i18n`; `false` — ошибка поля `validation.range`.
  Пример: дата уборки — `max` = сегодня.
- `disabled` — на обоих `input` и на кнопке.

### Дата и время

Момент, который вводит человек (когда внесена обработка, когда убран урожай), — два поля рядом: дата `at-date` и время
`HH:MM` (нативный `type="time"`). Подписи — «Дата …» и «Время …» (например, «Дата уборки», «Время уборки»):

```html
<div style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr))">
  <div class="at-field">
    <label class="at-field__label" for="batch-harvested-date">Дата уборки</label>
    <div class="at-date">…как в «Дата», max — сегодня (локальная дата)…</div>
  </div>
  <div class="at-field">
    <label class="at-field__label" for="batch-harvested-time">Время уборки</label>
    <input class="at-input" id="batch-harvested-time" type="time" />
  </div>
</div>
```

- Дата и время — в часовом поясе зрителя; отправляется момент UTC (`…Z`, целые секунды). Показ сохранённых моментов —
  тоже в местном времени (`formatLocalDateTime`). Фильтры и поля «только дата» остаются датами UTC, как в контракте.
- Время обязательно, если дата выбрана («Обязательное поле» — у поля времени). Новое значение: дата пуста, время —
  текущее.
- Не позже текущего момента: сегодняшняя дата с более поздним временем — ошибка у поля времени «Время не может быть
  позже текущего»; дата позже сегодняшней — ошибка у поля даты «Дата не может быть в будущем».
- При изменении записи, пока дата и время не тронуты, отправляется исходный момент как есть (с секундами).

### Поле с единицей `at-input-group`

```html
<div class="at-input-group">
  <input class="at-input" id="mass" inputmode="decimal" />
  <span class="at-input-group__suffix">кг</span>
</div>
```

Число выравнивается вправо, к единице (`кг`, `га`, `мг/кг`). Ошибка и недоступность берутся с вложенного `input`.
У недоступного поля значение и единица — `--c-ink-disabled` (контраст ≥ 4.5 на `--c-surface-sunk`: единица — текст
рядом с полем, WCAG 1.4.3 её не освобождает).

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
      <span><mark>Пше</mark>ница озимая</span><span class="at-combobox__meta">Зерно</span>
    </li>
    <li role="option" id="product-opt-2" aria-selected="false" data-active>
      <span><mark>Пше</mark>ница яровая</span>
    </li>
    <li role="option" id="product-opt-3" aria-selected="false" aria-disabled="true"><span>…</span></li>
  </ul>
</div>
```

- Пример — открытый список после ввода «Пше». Id: список `<id поля>-list`, варианты `<id поля>-opt-<N>` (с 1). Подпись
  варианта — всегда в `<span>`, совпадение с введённым текстом (без учёта регистра, первое) — в `<mark>`; `.at-combobox__meta` —
  необязательная вторая подпись.
- Закрыт: `aria-expanded="false"` на поле, `hidden` на списке, `aria-activedescendant` нет.
- `data-active` — подсвеченный с клавиатуры вариант (тот же, что в `aria-activedescendant`); `aria-selected="true"` — выбранный.
- Загрузка / нет вариантов — вместо `ul[role=listbox]` (пустой listbox — недопустимая ARIA) тот же контейнер с тем же id как
  живая область `role="status"`. Она **никогда не скрывается** атрибутом `hidden` (иначе объявление теряется): закрытое поле
  оставляет её пустой, а пустой `.at-combobox__list` не отображается (`:empty`). Текст — только при открытом списке:
  загрузка — `<span class="at-spinner" aria-hidden="true"></span>Поиск` и `aria-busy="true"` на поле; пусто после ввода —
  «Ничего не найдено.»; до первого ввода — пусто.

```html
<div class="at-combobox">
  <input
    class="at-input"
    id="lab"
    role="combobox"
    aria-autocomplete="list"
    autocomplete="off"
    aria-expanded="true"
    aria-controls="lab-list"
    aria-busy="true"
  />
  <div class="at-combobox__list" id="lab-list" role="status">
    <p class="at-combobox__status"><span class="at-spinner" aria-hidden="true"></span>Поиск</p>
  </div>
</div>
<div class="at-combobox">
  <input
    class="at-input"
    id="org"
    role="combobox"
    aria-autocomplete="list"
    autocomplete="off"
    aria-expanded="true"
    aria-controls="org-list"
  />
  <div class="at-combobox__list" id="org-list" role="status">
    <p class="at-combobox__status">Ничего не найдено.</p>
  </div>
</div>
<div class="at-combobox">
  <input
    class="at-input"
    id="region"
    role="combobox"
    aria-autocomplete="list"
    autocomplete="off"
    aria-expanded="false"
    aria-controls="region-list"
  />
  <div class="at-combobox__list" id="region-list" role="status"></div>
</div>
```

- Закрытое поле с вариантами — `<ul class="at-combobox__list" role="listbox" id="…" aria-label="…" hidden>` с теми же `li`.
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
      <input id="proto" type="file" accept="application/pdf,image/*" aria-labelledby="proto-label" />
      <svg class="at-file__icon" aria-hidden="true"><use href="#i-upload" /></svg>
      <span class="at-file__action">Выбрать файл</span>
      <span class="at-file__hint" id="proto-hint">PDF, JPG или PNG до 10 МБ</span>
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

`input[type=file]` скрыт визуально, но фокусируем: Tab — на зону, Enter/Space — диалог выбора. Id поля — у `input`
(`<id>`), подпись — `<id>-label`, ошибка — `<id>-error`, подсказка — `<id>-hint` (на неё может ссылаться `aria-describedby`
соседнего поля: у контура GeoJSON формат описан подсказкой файла контура — плейсхолдер исчезает при вводе). Перетаскивание: `data-dragover` стоит, пока файл над `.at-file`
(`dragenter`/`dragleave` считаются парами — переход между вложенными элементами зоны не снимает его), снимается на `drop`.
Элемент файла — «семенная бирка». `progress` — только пока идёт загрузка. Нет файлов — нет `ul.at-file__list`; нет
подсказки — нет `.at-file__hint`.

Ошибка (поле и файл), файл без превью (PDF), файл над зоной, без подсказки:

```html
<div class="at-field" data-invalid>
  <span class="at-field__label" id="proto-label">Протокол анализа</span>
  <div class="at-file" data-dragover data-invalid>
    <label class="at-file__drop">
      <input
        id="proto"
        type="file"
        accept="application/pdf"
        aria-labelledby="proto-label"
        aria-invalid="true"
        aria-describedby="proto-error"
      />
      <svg class="at-file__icon" aria-hidden="true"><use href="#i-upload" /></svg>
      <span class="at-file__action">Выбрать файл</span>
    </label>
    <ul class="at-file__list">
      <li class="at-file__item" data-error>
        <span class="at-file__preview" aria-hidden="true">PDF</span>
        <span class="at-file__body">
          <span class="at-file__name">protokol.pdf</span>
          <span class="at-file__size">Файл слишком большой</span>
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
  <p class="at-field__error" id="proto-error" role="alert">Файл слишком большой</p>
</div>
```

### Индикатор `at-spinner`

```html
<span class="at-spinner" aria-hidden="true"></span>
```

`<span class="at-spinner" aria-hidden="true"></span>` — борозда, которую «пашут»: пунктирная колея и сплошной отрезок,
идущий слева направо (без вращения; читается как прогресс, не как иконка). Цвет — `currentColor`. Цикличное движение —
исключение для индикаторов загрузки (ТЗ п. 10.1.6); при `prefers-reduced-motion` отрезок стоит в начале колеи. Состояние загрузки области сообщается `aria-busy="true"` на ней.

---

## Данные и обратная связь

### Статус `at-chip`

```html
<span class="at-chip" data-status="Approved">Допущена</span>
<!-- статусы партии -->
<span class="at-chip" data-tone="move">Отправлена</span>
<!-- прочие сущности -->
```

- `data-status` — значение `BatchStatus` из контракта; группа цвета — по ТЗ п. 10.3. Текст — из `@agrotrace/i18n`
  (`status.batch.*`), цвет никогда не единственный носитель смысла.
- `Recalled` — сплошная глиняная плашка; `WrittenOff` — перечёркнутое кольцо вместо точки.
- `data-tone`: `neutral | attention | ok | move | danger | danger-solid` (накладные, анализы, отзывы, задачи).
  Накладные: DRAFT — `neutral`, SENT — `move`, ACCEPTED — `ok`, REJECTED — `danger`. Отзывы: OPEN — `danger`, CLOSED — `ok`.
  Задачи изъятия: OPEN — `attention`, OVERDUE — `danger`, CONFIRMED — `ok`; задача после `dueAt` показывается «Просрочено» сразу
  (now > dueAt, правило домена), не дожидаясь эскалации планировщиком. Жалобы: NEW — `attention`, IN_REVIEW — `move`,
  DECIDED — `neutral`.
  Организации: PENDING и MANUAL_CHECK — `attention`, ACTIVE — `ok`, REJECTED — `neutral`, SUSPENDED — `danger`. Пользователи: INVITED —
  `attention`, ACTIVE — `ok`, BLOCKED — `danger`. Строка справочника при «Показывать удалённые»: удалена — `neutral`, действует — `ok`.
- `data-size="l"` — крупная плашка (шапка карточки партии, QR-страница).

### Карточка `at-card`

```html
<article class="at-card">
  <header class="at-card__header">
    <h2 class="at-card__title">…</h2>
    …
  </header>
  <div class="at-card__body">
    <dl class="at-card__facts">
      <div>
        <dt>Масса</dt>
        <dd>12 480,000 кг</dd>
      </div>
      …
    </dl>
  </div>
  <footer class="at-card__footer">…кнопки…</footer>
</article>
```

`data-furrow` — полоса борозд 36 px сверху; **только** публичная QR-страница и экран входа.

### Таблица `at-table`

```html
<!-- только для data-cards: заменяет шапку таблицы на < 768 px -->
<div class="at-table-mobilebar">
  <label class="at-check"><input type="checkbox" /><span>Выбрать все</span></label>
  <label class="at-table-mobilebar__sort">
    <span class="at-visually-hidden">Сортировка</span>
    <select class="at-select">
      <option value="massKg,desc">Масса, по убыванию</option>
      <option value="code,asc">Код партии</option>
    </select>
  </label>
</div>
<div class="at-table-wrap">
  <table class="at-table" data-cards>
    <thead>
      <tr>
        <th class="at-table__select" scope="col">
          <label class="at-check"><input type="checkbox" aria-label="Выбрать все партии" /></label>
        </th>
        <th scope="col" aria-sort="none"><button class="at-table__sort" type="button">Партия</button></th>
        <th scope="col">Статус</th>
        <th scope="col" data-numeric aria-sort="descending">
          <button class="at-table__sort" type="button">Масса, кг</button>
        </th>
        <th scope="col"><span class="at-visually-hidden">Действия</span></th>
      </tr>
    </thead>
    <tbody>
      <tr data-selected>
        <td class="at-table__select">
          <label class="at-check"
            ><input type="checkbox" checked aria-label="Выбрать AT-2026-000123"
          /></label>
        </td>
        <td data-label="Партия" data-primary>
          <span class="at-table__primary"
            ><a class="at-mono" href="/batches/…">AT-2026-000123</a
            ><span class="at-table__sub">Пшеница озимая</span></span
          >
        </td>
        <td data-label="Статус" data-status-cell>
          <span class="at-chip" data-status="Approved">Допущена</span>
        </td>
        <td data-label="Масса, кг" data-numeric>12 480,000</td>
        <td class="at-table__actions">
          <button class="at-button" data-variant="secondary" data-size="s" type="button">Отгрузить</button>
        </td>
      </tr>
    </tbody>
  </table>
</div>
```

- Сортировка: `aria-sort` (`ascending | descending | none`) на `th`, кнопка `.at-table__sort` внутри; Enter/Space — сменить порядок.
  Сортируемые столбцы отражаются в URL (ТЗ п. 9.3).
- `data-numeric` — числа вправо. Выбранная строка: `data-selected` на `tr` (солома) **и** `checked` на её флажке —
  состояние для вспомогательных технологий несёт флажок (у `tr` в обычной таблице нет роли с `aria-selected`).
- Зоны нажатия: `.at-table__sort` и флажки выбора визуально мелкие, но их зона нажатия — 40 × 40 (44 × 44 на < 768 px)
  за счёт невидимого `::before`.
- `data-cards` — на < 768 px строка становится карточкой: `td[data-label]` показывает подпись из атрибута,
  `td[data-primary]` и `td[data-status-cell]` — первая строка карточки (ссылка и `.at-table__sub` заголовка переносятся
  по словам и внутри длинных кодов — ничего не уходит под статус и за край экрана), `.at-table__actions` — кнопки во всю ширину.
  Пустая ячейка действий скрывается. `data-label` = текст заголовка столбца. Шапка (`thead`) в режиме карточек
  скрыта (`display: none`); сортировка и «Выбрать все» — в `.at-table-mobilebar` над карточками (один `select`
  «поле: направление», значение то же, что у сортировки в URL; флажок «Выбрать все» — то же состояние, что флажок
  в шапке, включая `indeterminate`). Действия строки остаются на каждой карточке. На ≥ 768 px `.at-table-mobilebar`
  скрыт. Значение сортировки — как в URL и в контракте: `поле,направление` (`massKg,desc`). Пока список не отсортирован
  (в URL нет `sort`), первым идёт недоступный вариант-заглушка с пустым значением, и выбран он:

```html
<label class="at-table-mobilebar__sort">
  <span class="at-visually-hidden">Сортировка</span>
  <select class="at-select">
    <option value="" disabled>По умолчанию</option>
    <option value="massKg,desc">Масса, по убыванию</option>
  </select>
</label>
```

- Поле ввода в ячейке (заявленная масса накладной, масса входа переработки): `div.at-field` без `label` — **прямой
  потомок** `td`; имя даёт `aria-label` контрола («Заявленная масса AT-2026-000123»), ошибка — как у поля (`<id>-error`,
  `aria-describedby`). Поле строки недоступно (`disabled`), пока строка не выбрана. В режиме карточек такая ячейка
  (`td:has(> .at-field)`) — подпись над полем, поле во всю ширину карточки:

```html
<td data-label="Заявлено, кг">
  <div class="at-field">
    <div class="at-input-group">
      <input
        class="at-input"
        id="declared-1"
        inputmode="decimal"
        aria-label="Заявленная масса AT-2026-000123"
      />
      <span class="at-input-group__suffix">кг</span>
    </div>
  </div>
</td>
```

- Несколько действий строки (одобрить / отклонить / изменить; изменить / фото / удалить) стоят в одной ячейке подряд с
  промежутком `--sp-2`, по середине строки; второстепенные — кнопки-иконки (`data-icon-only`, имя — `aria-label` с названием
  строки: «Удалить Пшеница озимая»). Столбцов столько, чтобы на 1280 px действия были видны без прокрутки таблицы:
  вторичные данные — строкой `at-table__sub` под основными (тип и регион организации, роль и «руководитель организации»).
- На 768–1439 px: текстовые кнопки действий строки стоят столбиком — каждая во всю ширину ячейки (по
  самой широкой в столбце), промежуток `--sp-2`; строка с одной кнопкой выглядит так же, как строки со столбиком (кнопка
  на том же месте и той же ширины). Ячейка, где есть кнопки-иконки, остаётся рядом (как раньше). Длинное слово в
  `td[data-primary]` переносится внутри слова. Разметка та же — только CSS. Организации: тип и регион — вторая строка
  `at-table__sub` под ИНН в ячейке названия («Продавец, Ивановская область», `orgs.typeRegionOf`), отдельного столбца нет —
  так на 768–1439 px все действия видны без прокрутки таблицы.
- Кнопки действий строки пишутся с `data-size="s"`; на карточках (< 768 px) CSS даёт им обычный размер (зона нажатия
  ≥ 44 px, иконка 20 px, кнопка-иконка — квадрат без отступов), разметка та же.
- `.at-table-wrap` прокручивается по горизонтали на любой ширине (таблица без `data-cards` не расширяет страницу);
  в режиме карточек прокрутки нет.

### Пагинация `at-pagination`

```html
<nav class="at-pagination" aria-label="Страницы">
  <p class="at-pagination__summary">1–20 из 248</p>
  <ul class="at-pagination__pages">
    <li>
      <button class="at-pagination__item" type="button" aria-label="Предыдущая страница" disabled>
        <svg aria-hidden="true"><use href="#i-chevron-left" /></svg>
      </button>
    </li>
    <li><a class="at-pagination__item" href="/batches?page=1" aria-current="page">1</a></li>
    <li><a class="at-pagination__item" href="/batches?page=2">2</a></li>
    <li><span class="at-pagination__gap" aria-hidden="true">…</span></li>
    <li><a class="at-pagination__item" href="/batches?page=13">13</a></li>
    <li>
      <a class="at-pagination__item" href="/batches?page=2" aria-label="Следующая страница">
        <svg aria-hidden="true"><use href="#i-chevron-right" /></svg>
      </a>
    </li>
  </ul>
</nav>
```

- Номера: первая, последняя, текущая ± 1; пропуск ровно одной страницы показывает её номер, больше — `…`
  (`at-pagination__gap`). Одна страница — только «1».
- Ссылки — полный путь с остальными параметрами URL (фильтры, сортировка), меняется только `page`. Нет предыдущей или
  следующей страницы — вместо ссылки `button` с `disabled`. Сводка «с–по из всего»; при 0 записей — «0–0 из 0».
- Страницы без URL (длинный список внутри карточки, который уже целиком пришёл с сервера, — «Отклонённые строки» отчёта
  об импорте, по 200): та же разметка, но каждый номер и стрелка — `button type="button"` (текущая — с
  `aria-current="page"`), у `nav` — своё имя (не «Страницы», чтобы не повторять навигацию списка страницы). Стрелка,
  ставшая недоступной после нажатия, отдаёт фокус номеру текущей страницы. Внутри `at-card` подложка текущей страницы
  и наведения — `--c-ground`.

```html
<nav class="at-pagination" aria-label="Страницы отклонённых строк">
  <p class="at-pagination__summary">201–400 из 450</p>
  <ul class="at-pagination__pages">
    <li>
      <button class="at-pagination__item" type="button" aria-label="Предыдущая страница">
        <svg aria-hidden="true"><use href="#i-chevron-left" /></svg>
      </button>
    </li>
    <li><button class="at-pagination__item" type="button">1</button></li>
    <li><button class="at-pagination__item" type="button" aria-current="page">2</button></li>
    <li><button class="at-pagination__item" type="button">3</button></li>
    <li>
      <button class="at-pagination__item" type="button" aria-label="Следующая страница">
        <svg aria-hidden="true"><use href="#i-chevron-right" /></svg>
      </button>
    </li>
  </ul>
</nav>
```

### Вкладки `at-tabs`

```html
<div class="at-tabs" role="tablist" aria-label="Партия AT-2026-000123">
  <button
    class="at-tabs__tab"
    role="tab"
    id="tab-history"
    aria-selected="true"
    aria-controls="panel-history"
    tabindex="0"
    type="button"
  >
    История
  </button>
  <button
    class="at-tabs__tab"
    role="tab"
    id="tab-tests"
    aria-selected="false"
    aria-controls="panel-tests"
    tabindex="-1"
    type="button"
  >
    Анализы <span class="at-tabs__count">3</span>
  </button>
</div>
<div class="at-tabs__panel" role="tabpanel" id="panel-history" aria-labelledby="tab-history" tabindex="0">
  …
</div>
<div
  class="at-tabs__panel"
  role="tabpanel"
  id="panel-tests"
  aria-labelledby="tab-tests"
  tabindex="0"
  hidden
></div>
```

Роуминг-табиндекс: у выбранной вкладки явно `tabindex="0"`, у остальных `tabindex="-1"`. Панели выводятся
все (id `tab-<ключ>` / `panel-<ключ>`), неактивные — пустые и с `hidden`; содержимое есть только у панели выбранной вкладки. ← / → — соседняя вкладка (по кругу),
Home / End — первая / последняя; выбор при перемещении фокуса. Вкладка карточки партии отражается в `?tab=`.

### Диалог `at-dialog`

```html
<dialog class="at-dialog" aria-labelledby="recall-title">
  <!-- data-size="l" — широкий -->
  <div class="at-dialog__header">
    <h2 class="at-dialog__title" id="recall-title">Запустить отзыв</h2>
    <button class="at-button" data-variant="ghost" data-icon-only type="button" aria-label="Закрыть">
      <svg class="at-button__icon" aria-hidden="true"><use href="#i-close" /></svg>
    </button>
  </div>
  <div class="at-dialog__body">
    <div class="at-field">
      <label class="at-field__label" for="recall-code">Код партии</label>
      <input class="at-input at-mono" id="recall-code" autocomplete="off" />
    </div>
  </div>
  <div class="at-dialog__actions">
    <button class="at-button" data-variant="ghost" type="button">Отмена</button>
    <button class="at-button" data-variant="danger" type="button" disabled>Запустить отзыв</button>
  </div>
</dialog>
```

Открытие — `showModal()` (фокус-ловушка и Esc — нативные), закрытие — `close()`; фокус возвращается на кнопку,
открывшую диалог. Так же и когда диалог при закрытии убирается со страницы (рендерится только открытым): Esc, успех
(«Импорт» после импорта, «Фото» после Esc) — фокус на открывшей кнопке, если она ещё на странице, иначе на `h1`. Содержимое тела выводится только у открытого диалога.

- Начальный фокус: первый фокусируемый элемент тела диалога (для подтверждения отзыва — поле повтора кода партии);
  если в теле его нет — заголовок `.at-dialog__title` с `tabindex="-1"` (не кнопка «Закрыть» и не опасная кнопка).
- Щелчок по подложке (`::backdrop`, т. е. `event.target === dialog`) закрывает только диалоги без необратимого
  действия (меню «Ещё», просмотр). Диалоги подтверждения (отзыв, отказ в приёмке, изъятие) закрываются только
  кнопкой «Отмена», крестиком или Esc.
- Опасная кнопка подтверждения недоступна (`disabled`), пока повторённый код партии не совпадает. Отказ от накладной повторяет номер накладной
  («Номер накладной для подтверждения»), а не код партии. Ошибка действия в открытом диалоге выводится в теле диалога
  (`p.at-field__error` с `role="alert"`) — область тостов за модальным диалогом недоступна; введённое при ошибке
  сохраняется. Пока диалог открыт, тост страницы с этим сообщением **не** выводится (иначе ошибка звучит дважды). Если
  диалог закрывается (Отмена, крестик, Esc или экран закрыл его после перечитывания), а ошибка ещё в силе — её не сняли
  повторная попытка или успех, — после закрытия она выводится тостом страницы (React: `useDialogAlert`,
  `handOff`). Отказ файла (413/415/400 файла) говорится на самом файле и тостом не передаётся. Закрытие диалога (Отмена, крестик, Esc) очищает введённое — повторно открытый диалог снова просит номер. Подложка — `--c-backdrop`. На < 768 px диалог прижат к нижнему краю, кнопки растянуты.

### Уведомления `at-toast`

```html
<div class="at-toasts">
  <!-- один на приложение: две области -->
  <div class="at-toast-region" role="alert"></div>
  <!-- ↑ ошибки (data-tone="danger"); здесь пусто -->
  <div class="at-toast-region" aria-live="polite">
    <div class="at-toast" data-tone="ok">
      <!-- ok | attention | move | danger | neutral -->
      <p class="at-toast__text">
        Партия AT-2026-000123 отгружена<small>…вторая строка при необходимости…</small>
      </p>
      <button
        class="at-button"
        data-variant="ghost"
        data-size="s"
        data-icon-only
        type="button"
        aria-label="Закрыть"
      >
        <svg class="at-button__icon" aria-hidden="true"><use href="#i-close" /></svg>
      </button>
    </div>
  </div>
</div>
```

Ошибки (`data-tone="danger"`) добавляются в область `role="alert"` — объявляются сразу; остальные — в
`aria-live="polite"`. Обе области рендерятся всегда, с самого старта приложения, и никогда не скрываются
(`display: none`, `visibility: hidden`, `hidden`): иначе первое объявление теряется. Пустая область имеет нулевую
высоту; отступ между непустыми областями даёт CSS. Тост плавающий, поэтому у него единственная тень (ТЗ п. 10.5).
Автоскрытие через 5 с (ошибки — не скрываются сами). На < 768 px область — над нижней навигацией.

### Шаги `at-stepper`

```html
<ol class="at-stepper" aria-label="Переработка">
  <li class="at-stepper__step" data-done>
    <span class="at-stepper__marker">1</span><span class="at-stepper__label">Входы</span>
  </li>
  <li class="at-stepper__step" aria-current="step">
    <span class="at-stepper__marker">2</span><span class="at-stepper__label">Выходы</span>
  </li>
  <li class="at-stepper__step">
    <span class="at-stepper__marker">3</span><span class="at-stepper__label">Проверка баланса</span>
  </li>
</ol>
```

Соединитель — «борозда» из двух линий, пройденные — зелёные. На < 768 px подпись видна только у текущего шага.

Мастер переработки: на ≥ 768 px все шаги — карточки на одной странице, текущий шаг степпера — первый незаполненный;
на < 768 px — одна карточка шага с кнопками «Назад» и «Далее» (переход дальше только после проверки полей шага), на
последнем — кнопка действия. Заголовок карточки шага — `h2.at-card__title` с `tabindex="-1"`; при смене шага фокус
переходит на него. Ошибка сервера возвращает на шаг с первым полем ошибки.

### История `at-timeline`

```html
<ol class="at-timeline">
  <li class="at-timeline__item" data-tone="ok" data-current>
    <time class="at-timeline__time" datetime="2026-08-19T11:05">19.08.2026, 11:05</time>
    <p class="at-timeline__title">Допущена</p>
    <p class="at-timeline__meta">
      <span class="at-avatar" data-size="s">…</span>Мария Соколова, ФГБУ «Липецкая МВЛ»
    </p>
  </li>
</ol>
```

`data-tone` — группа статуса; `data-current` — последний шаг (заполненный маркер). Порядок — хронологический: история
статусов партии и путь по держателям идут от первого события к текущему, текущий — последний (витрина показывает
фрагмент).

### Пустое состояние `at-empty`

```html
<div class="at-empty">
  <svg class="at-empty__art" aria-hidden="true" viewBox="0 0 240 160">…illustrations/empty-batches.svg…</svg>
  <p class="at-empty__text">Партий пока нет.</p>
  <button class="at-button" data-variant="primary" type="button">Зарегистрировать партию</button>
</div>
```

Иллюстрация (инлайн, см. «Иконки и иллюстрации»), одна строка (из `@agrotrace/i18n`, `empty.*`) и одна кнопка.

### Загрузка `at-skeleton`

`data-shape`: `text` (по умолчанию), `block`, `circle`; ширина — `style="width: …"` только когда задана. Контейнер области — `aria-busy="true"`.

```html
<span class="at-skeleton" data-shape="text" style="width: 40%"></span>
<span class="at-skeleton" data-shape="block"></span>
```

### Аватар `at-avatar`

```html
<span class="at-avatar" data-size="m"><img src="…" alt="Иван Петров" /></span>
<span class="at-avatar" data-size="m" role="img" aria-label="Иван Петров">ИП</span>
<span class="at-avatar" data-size="l" data-shape="square"><img src="…" alt="КФХ Петров" /></span>
<!-- логотип -->
```

Размеры `s` 24, `m` 32 (по умолчанию), `l` 56 px. Рядом с именем картинка декоративная: `alt=""`, без `role`.

Инициалы (без картинки): первые буквы первых двух слов в порядке написания («Иван Петров» → «ИП», «Петров Иван
Сергеевич» → «ПИ»), кавычки и знаки перед словом пропускаются («ООО «Кубанский мукомол»» → «ОК»); одно слово — его
первые две буквы; в верхнем регистре.

### Показатель `at-metric`

```html
<div class="at-metric">
  <!-- data-tone="danger" — спарклайн глиной -->
  <p class="at-metric__label">Масса на складе</p>
  <p class="at-metric__value">212,4<span class="at-metric__unit">т</span></p>
  <div class="at-metric__spark" aria-hidden="true">
    <svg viewBox="0 0 96 32">…stroke="currentColor"…</svg>
  </div>
</div>
```

Вторая строка под числом (например, «из них просрочено: 1» у задач отзыва) — `<span class="at-metric__delta">` последним
потомком `.at-metric__value`, после единицы. Значения — как их дал сервер, без округления на клиенте.

### Прогресс `at-progress`

```html
<div class="at-progress">
  <!-- data-tone="danger" -->
  <span class="at-progress__label" id="recall-progress">Подтверждено</span>
  <span class="at-progress__value">7 из 12</span>
  <progress class="at-progress__bar" max="12" value="7" aria-labelledby="recall-progress"></progress>
</div>
```

В ячейке таблицы (реестр отзывов) подпись уже есть в заголовке столбца: `.at-progress__label` остаётся (имя полосы через
`aria-labelledby`), но получает `at-visually-hidden`; значение «N из M» прижато вправо. Длинная подпись переносится и
никогда не наезжает на значение. Просроченные задачи — `data-tone="danger"` и строка `at-table__sub` «просрочено: N» под
полосой.

### Граф `at-graph`

```html
<div class="at-graph">
  <!-- data-fullscreen — на весь экран -->
  <div class="at-graph__canvas" role="img" aria-label="Граф партии AT-2026-000097: …"></div>
  <!-- сюда монтируется Cytoscape -->
  <div class="at-graph__toolbar">…кнопки s, icon-only…</div>
  <ul class="at-graph__legend" aria-label="Обозначения">
    <li><span class="at-chip" data-status="Recalled">Отозвана</span></li>
  </ul>
</div>
```

Цвета узлов — `--status-<статус>-bg|fg` (читаются через `getComputedStyle`; при смене темы граф перерисовывается).
Узел вне области видимости пользователя (`accessible: false`) — пунктирная граница `--c-line-strong` без прозрачности
(контраст графики ≥ 3 : 1), ведёт на публичную страницу `/p/<код>`. На < 768 px граф открывается кнопкой в режиме
`data-fullscreen`; Esc и кнопка «Закрыть» выходят из него.

- Полноэкранный режим: всё остальное на странице, кроме стека тостов `.at-toasts` (объявления должны звучать),
  получает `inert` (Tab не выходит из блока, экранные дикторы не читают закрытое), фокусируемые предки блока (панель вкладки с `tabindex="0"`) на это время получают `tabindex="-1"`; фокус
  при открытии — на кнопку закрытия, при закрытии — на кнопку, открывшую блок. Узкий высокий холст
  раскладывается сверху вниз, широкий — слева направо.
- Под графом те же узлы выводятся таблицей (`at-table`: партия, статус, держатель, связь, использованная масса) — для
  клавиатуры и экранных дикторов.
- **Карта полей** (Яндекс.Карты, только при ключе API) использует ту же разметку `at-graph` (холст, панель, полноэкранный
  режим и его правила); без ключа карта не выводится, остаётся таблица.
- Если библиотеку графа или карты не удалось загрузить, в холсте — строка `role="alert"` с текстом ошибки.

### График `at-chart`

Горизонтальные столбцы (Apache ECharts, SVG) внутри `at-card`; заголовок графика — `h2.at-card__title` карточки.

```html
<article class="at-card">
  <header class="at-card__header"><h2 class="at-card__title">Доля брака по продуктам</h2></header>
  <div class="at-card__body">
    <div class="at-chart" style="--at-chart-rows: 2">
      <!-- aria-busy="true" на время обновления: прежний рисунок приглушён -->
      <div
        class="at-chart__canvas"
        role="img"
        aria-label="Доля брака по продуктам: Пшеница озимая — 12,50%; Ячмень — 0,00%"
      ></div>
      <details class="at-chart__data">
        <summary class="at-chart__data-toggle">Таблица значений</summary>
        <div class="at-table-wrap">
          <table class="at-table" data-cards>
            <caption class="at-visually-hidden">
              Доля брака по продуктам
            </caption>
            <thead>
              <tr>
                <th scope="col">Продукт</th>
                <th scope="col" data-numeric>Проверено</th>
                <th scope="col" data-numeric>С превышением</th>
                <th scope="col" data-numeric>Доля брака, %</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td data-label="Продукт" data-primary>Пшеница озимая</td>
                <td data-label="Проверено" data-numeric>8</td>
                <td data-label="С превышением" data-numeric>1</td>
                <td data-label="Доля брака, %" data-numeric>12,50</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>
  </div>
</article>
```

- Форма — по правилам `dataviz`: номинальные категории (продукты, хозяйства, регионы, статусы) — **один ряд одного
  цвета** `--c-field` (без легенды: ряд называет заголовок карточки), столбец не толще 20 px, скругление 4 px только
  у конца значения, сетка — сплошные линии 1 px `--c-line`, подписи осей — `--c-ink-muted`, значение у конца
  столбца — `--c-ink` (текст никогда не цвета ряда). Статусные цвета и `--c-clay` в графиках не используются (пара
  `--c-field`/`--c-clay` неразличима при протанопии — проверено валидатором `dataviz`). При смене темы график
  перерисовывается с новыми значениями токенов (`getComputedStyle`).
- Высота холста — `--at-chart-rows` (число столбцов): 40 px на столбец + 32 px оси; внутренней прокрутки нет.
- Названия: холст шире 480 px — слева от оси, до половины ширины (не больше 240 px); уже 480 px — над своим столбцом
  (внутри области графика, по левому краю, столбец 12 px; слева 12 px под половину подписи «0»). Название обрезается многоточием, только если не помещается
  и так; полное есть в подсказке, `aria-label` и таблице.
- Подсказка — при наведении на полосу столбца (вся полоса — зона наведения): название и значение; класс
  `at-chart__tooltip`, фон `--c-surface`, граница `--c-line`. Подсказка ничего не прячет: каждое значение есть
  в подписи столбца и в таблице.
- `aria-label` холста: «<заголовок>: <название> — <значение>; …» по всем столбцам графика. Таблица значений —
  в `details` (свёрнута), у таблицы — скрытый `caption` с заголовком; на < 768 px строки таблицы — карточки
  (`data-cards`, первый столбец — `data-primary`).
- Нет данных за период — вместо `.at-chart` одна строка `<p class="at-chart__empty">За период данных нет.</p>`.
- Библиотека не загрузилась или не смогла нарисовать — в холсте `div.at-chart__failed`: строка `role="alert"`
  «График не загрузился.» и кнопка `s` «Повторить»; таблица значений остаётся. Чанк библиотеки запрашивается один раз
  на документ (все графики ждут один запрос; неудачный импорт браузер помнит до перезагрузки), поэтому «Повторить»
  после сбоя загрузки — полная перезагрузка страницы через защиту «один раз»; после ошибки рисования —
  новая попытка на месте.
- Движение — 150 мс `ease-out` при появлении данных; при `prefers-reduced-motion: reduce` — без анимации.

### Дашборд (маршрут `/`)

Область по роли (контракт `getDashboard`): INSPECTOR, ADMIN — `inspector`; LAB — `lab`; иначе — `org`. Под
заголовком — фильтры «Период с» / «Период по» (`from`/`to` в URL; пока их нет, поля показывают окно из ответа
`period`; на < 768 px период — `at-page__note` рядом с «Фильтры»). Окно длиннее 366 дней проверяется до запроса: вместо
показателей — «Слишком длинный диапазон дат» (`validation.range.tooLong`) с «Сбросить фильтры»; 403 — текст без кнопки.
Затем ряд `at-metric` (сетка `repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))` — пять плиток в ряд на 1280 px, часы — «52,40 ч», null —
«—») и карточки графиков (`repeat(auto-fit, minmax(min(100%, 28rem), 1fr))`; «Нарушения по регионам» — во весь ряд, `grid-column: 1 / -1`, без
карточки-«сироты»):

| Область     | Показатели `at-metric`                                                                                                                                  | Графики                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspector` | Партий за период · Активные отзывы · Среднее время отзыва · Нарушений за период (сумма `violationsByRegion`)                                            | Доля брака по продуктам · Доля брака по хозяйствам (порядок ответа, значение `share`, таблица: название, проверено, с превышением, доля) · Нарушения по регионам (только `count` > 0, по убыванию, затем по коду; больше 10 регионов — 9 первых и столбец «Другие» с суммой остальных; в таблице — все ненулевые) |
| `org`       | Партий у организации (сумма `byStatus`) · Анализы в норме · Анализы с превышением · Задачи отзыва (`at-metric__delta` «из них просрочено: N» при N > 0) | Партии по статусам (все 11 в порядке контракта)                                                                                                                                                                                                                                                                   |
| `lab`       | В очереди · Просрочено · Завершено за период · С превышением за период · Среднее время анализа                                                          | —                                                                                                                                                                                                                                                                                                                 |

«Нарушения по регионам» — всегда столбцы с таблицей, не географическая карта (у региона в контракте нет
геометрии; Яндекс.Карты — только для полей).
---

## Каркас

### Оболочка `at-shell`

```html
<div class="at-shell">
  <a class="at-shell__skip" href="#main">К содержимому</a>
  <nav class="at-sidebar" aria-label="Основное меню">…</nav>
  <header class="at-topbar">…</header>
  <main class="at-shell__main" id="main" tabindex="-1"><div class="at-page">…</div></main>
  <nav class="at-bottom-nav" aria-label="Основное меню">…</nav>
</div>
```

| Ширина      | Навигация                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| ≥ 1024 px   | `at-sidebar` 240 px с подписями                                                                                             |
| 768–1023 px | `at-sidebar` свёрнут до 72 px: только иконки, подписи остаются для экранных дикторов, `title` на ссылке                     |
| < 768 px    | `at-sidebar` скрыт; `at-bottom-nav` фиксирован снизу (4 основных пункта роли + «Ещё»), отступ `env(safe-area-inset-bottom)` |

Обе навигации в разметке всегда; CSS показывает одну. Набор пунктов — по роли.

### Боковое меню `at-sidebar`

```html
<nav class="at-sidebar" aria-label="Основное меню">
  <a class="at-sidebar__brand" href="/" title="AgroTrace"
    >…знак…<span class="at-sidebar__label">AgroTrace</span></a
  >
  <ul class="at-sidebar__list">
    <li>
      <a class="at-sidebar__link" href="/batches" aria-current="page" title="Партии">
        <svg class="at-sidebar__icon" aria-hidden="true"><use href="#i-batch" /></svg>
        <span class="at-sidebar__label">Партии</span>
      </a>
    </li>
    <li>
      <a class="at-sidebar__link" href="/recall-tasks" title="Задачи отзыва">
        <svg class="at-sidebar__icon" aria-hidden="true"><use href="#i-check" /></svg>
        <span class="at-sidebar__label">Задачи отзыва</span>
        <span class="at-visually-hidden">, открытых:</span><span class="at-sidebar__count">1</span>
      </a>
    </li>
  </ul>
  <div class="at-sidebar__footer">…необязательно…</div>
</nav>
```

`aria-current="page"` — текущий раздел (и для вложенных маршрутов раздела).

Иконки разделов — одни и те же во всех трёх фреймворках (в боковом меню, нижней навигации и «Ещё»); иконки пунктов
одного меню не повторяются:

| Раздел       | Иконка    | Раздел        | Иконка     |
| ------------ | --------- | ------------- | ---------- |
| Панель       | `graph`   | Задачи отзыва | `check`    |
| Поля         | `field`   | Отзывы        | `recall`   |
| Партии       | `batch`   | Жалобы        | `alert`    |
| Накладные    | `waybill` | Отчёты        | `download` |
| Склад        | `store`   | Сотрудники    | `users`    |
| Переработка  | `factory` | Организации   | `building` |
| Печать QR    | `qr`      | Пользователи  | `shield`   |
| Очередь проб | `flask`   | Справочники   | `settings` |
| Уведомления  | `bell`    | Журнал аудита | `eye`      |
| Профиль      | `user`    |               |            |

### Нижняя навигация `at-bottom-nav`

```html
<nav class="at-bottom-nav" aria-label="Основное меню">
  <a class="at-bottom-nav__link" href="/batches" aria-current="page">
    <svg class="at-bottom-nav__icon" aria-hidden="true"><use href="#i-batch" /></svg>Партии
  </a>
  …ещё 3 ссылки…
  <button class="at-bottom-nav__link" type="button" aria-expanded="false" aria-controls="more-menu">
    <svg class="at-bottom-nav__icon" aria-hidden="true"><use href="#i-more" /></svg>Ещё
  </button>
</nav>
```

Подпись в нижней панели — одна строка (5 пунктов по ≈ 72 px на 360 px): двусловные названия берут короткую подпись
(`navShort.*`: «Очередь проб» → «Пробы», «Задачи отзыва» → «Задачи»); в боковом меню и «Ещё» — полное название.

Недоступный пункт — `button` с `disabled` или `a` без `href` с `aria-disabled="true"`: цвет `--c-line-strong`, без
подсветки при наведении, курсор `not-allowed`; иконка и подпись те же.

«Ещё» открывает остальные пункты роли и профиль в `at-dialog` (на < 768 px — нижний лист); `aria-expanded` на
кнопке отражает открытие, `aria-controls` указывает на диалог:

```html
<dialog class="at-dialog" id="more-menu" aria-labelledby="more-title">
  <div class="at-dialog__header">
    <h2 class="at-dialog__title" id="more-title" tabindex="-1">Ещё</h2>
    <button class="at-button" data-variant="ghost" data-icon-only type="button" aria-label="Закрыть">
      <svg class="at-button__icon" aria-hidden="true"><use href="#i-close" /></svg>
    </button>
  </div>
  <div class="at-dialog__body">
    <nav aria-label="Остальные разделы">
      <ul class="at-sidebar__list">
        <li>
          <a class="at-sidebar__link" href="/recall-tasks"
            ><svg class="at-sidebar__icon" aria-hidden="true"><use href="#i-check" /></svg
            ><span class="at-sidebar__label">Задачи отзыва</span></a
          >
        </li>
        <li>
          <a class="at-sidebar__link" href="/profile"
            ><svg class="at-sidebar__icon" aria-hidden="true"><use href="#i-user" /></svg
            ><span class="at-sidebar__label">Профиль</span></a
          >
        </li>
      </ul>
    </nav>
  </div>
</dialog>
```

Щелчок по подложке закрывает этот диалог; выбор пункта — переход и `close()`; фокус возвращается на «Ещё».

### Шапка `at-topbar`, колокольчик `at-bell`

```html
<header class="at-topbar">
  <div class="at-topbar__org">
    <span class="at-avatar" data-size="m" data-shape="square"><img src="…логотип…" alt="" /></span>
    <span class="at-topbar__org-name">КФХ Петров</span>
  </div>
  <div class="at-topbar__actions">
    <a class="at-bell" href="/notifications" aria-label="Уведомления, непрочитанных: 3">
      <svg class="at-bell__icon" aria-hidden="true"><use href="#i-bell" /></svg>
      <span class="at-bell__count" aria-hidden="true">3</span>
    </a>
    <a class="at-topbar__profile" href="/profile" aria-label="Профиль, Иван Петров">
      <span class="at-avatar" data-size="m" aria-hidden="true">ИП</span>
    </a>
  </div>
</header>
```

Счётчик: нет элемента при 0, «99+» свыше 99; число дублируется в `aria-label` ссылки. Новое уведомление по SSE
обновляет счётчик и показывает `at-toast`.

### Страница `at-page`

```html
<div class="at-page">
  <div class="at-page__header">
    <h1 class="at-page__title" tabindex="-1">Партии</h1>
    <!-- существительное, без подзаголовка -->
    <div class="at-page__actions">
      <a class="at-button" data-variant="primary" href="/batches/new">Зарегистрировать партию</a>
    </div>
  </div>
  <div class="at-page__toolbar">
    <div class="at-page__search">
      <svg aria-hidden="true"><use href="#i-search" /></svg>
      <input class="at-input" type="search" placeholder="Код, продукт" aria-label="Поиск партий" />
    </div>
    <details class="at-page__filters" open>
      <summary class="at-page__filters-toggle">
        Фильтры<span class="at-visually-hidden">, выбрано:</span>
        <span class="at-page__filters-count">1</span>
      </summary>
      <div class="at-page__filters-body">…at-field со select / date…</div>
    </details>
  </div>
  …таблица, пагинация…
</div>
```

- Фильтры: на ≥ 768 px `details` всегда открыт (фреймворк держит `open` по `matchMedia('(min-width: 768px)')`),
  `summary` скрыт, поля — в строку. На < 768 px `summary` — кнопка «Фильтры» со счётчиком выбранных, панель
  раскрывается под строкой поиска. Значения фильтров — в query-параметрах URL. Пока ничего не выбрано, счётчик и
  скрытый префикс «, выбрано:» не выводятся (`summary` — только «Фильтры»).
- Короткая справка рядом с «Фильтры» (период дашборда «26.08.2026 — 24.09.2026»): `<p class="at-page__note">` последним
  потомком `.at-page__toolbar`; выводится всегда, CSS показывает её только на < 768 px (там поля свёрнуты).
- Параметры URL списка проверяются на клиенте до запроса: `sort` — только поля x-sort операции, перечисления — только
  значения контракта, даты — `ГГГГ-ММ-ДД`, идентификаторы — UUID, `page` — целое ≥ 1; неподходящие убираются из URL
  (`replace`) и не отправляются. Если сервер всё же ответил на запрос списка 400 — вместо таблицы пустое состояние
  «Список нельзя показать с такими фильтрами.» с одной кнопкой «Сбросить фильтры». Страница за последней (список
  уменьшился, старая ссылка) — переход на последнюю страницу, а не пустое состояние. Страница внутри списка пришла
  пустой (список изменился между подсчётом и строками) — пустое состояние «Список изменился.» с кнопкой «Обновить
  список», никогда не бесконечная загрузка.
- Параметры URL, не относящиеся к списку (например, `tab`), сохраняются как есть; `page=1` из URL убирается (первая
  страница — без `page`); `q` длиннее 100 символов (кодовых точек, `maxLength` контракта) обрезается до 100.
  «Сбросить фильтры» убирает все параметры списка (поиск, фильтры, сортировку, страницу) и переводит фокус на
  `h1.at-page__title` (кнопка исчезает вместе с фильтрами).
- Несколько значений одного фильтра из ссылки (`status=A&status=B`) при одиночном `select` показываются недоступным
  вариантом «Несколько (N)».
- Очередь проб (`/lab/tests`): без `status` в URL показываются активные анализы (QUEUED, SAMPLED,
  ESCALATED — они и отправляются), в `select` «Статус» выбран вариант «Активные» (значение `""`); «Все» — явный выбор
  `status=all` (в запрос `status` не идёт). Пустая активная очередь — «Проб в очереди нет.» с кнопкой «Все анализы»
  (`status=all`); «Сбросить фильтры» возвращает к активным. Пустой ответ при одном «Все» — то же «Проб в очереди нет.»
  без кнопки; `status=all` вместе с другими статусами в ссылке заменяется на `status=all` (`replace`).
- Задачи отзыва (`/recall-tasks`) — по тому же правилу: без `status` — ожидающие изъятия (OPEN, OVERDUE; вариант
  «Ожидают изъятия»), «Все» — `status=all`; пустой список — «Задач изъятия нет.» с кнопкой «Все задачи». Срок задачи —
  дата и под ней `at-table__sub` «осталось 5 ч 12 мин» / «просрочено на 3 ч 1 мин» (с классом `at-field__warning`),
  обновляется раз в 30 с. Кнопка «Изъято» — в `.at-table__actions` (на < 768 px во всю ширину карточки), открывает диалог
  подтверждения с повтором кода партии и кнопкой «Подтвердить изъятие».
- Справочники (`/admin/dictionaries/:name`): `at-tabs` по справочникам, выбор вкладки меняет путь, но фокус остаётся на вкладке
  (исключение из «Фокус при смене маршрута» — как у меню «Ещё»); список — в панели выбранной вкладки. Импорт — диалог с
  `at-file` (подсказка — форматы, 5 МБ и строка заголовка файла); отказ сервера (413, 415 `workbook-too-large`, 415 «не книга»,
  400 заголовок / кодировка / больше 10 000 строк) — текстом «что не так и что сделать» на файле. Итог — карточка «Отчёт об
  импорте» над списком: ряд `at-metric` (создано, изменено, без изменений, отклонено строк — `data-tone="danger"` при > 0) и
  таблица «Отклонённые строки» (строка, столбец — подпись поля и имя колонки файла `at-mono` под ней, ошибка) — по 200 на
  странице, больше 200 — `at-pagination` без URL под таблицей («Страницы отклонённых строк»); карточка
  закрывается кнопкой-иконкой в шапке. После успешного импорта диалог закрывается и фокус — на «Импорт».
- Журнал аудита: автор и запись в строке — ссылки, сужающие журнал (`actorId`, `entityType` + `entityId` в URL); «Изменения» —
  широкий диалог (`data-size="l"`, закрывается и щелчком по подложке): факты записи и таблица «Поле / Было / Стало»: поле —
  подпись (`auditFieldLabel`, ключи `audit.fields.*` в `@agrotrace/i18n`) и имя поля API `at-table__sub at-mono` под ней;
  значения — `auditValue`: момент — в часовом поясе зрителя «ДД.ММ.ГГГГ ЧЧ:ММ», дата — «ДД.ММ.ГГГГ», `true`/`false` —
  «да»/«нет», `status` — подпись статуса этой записи, десятичные — в локали без хвостовых нулей («0,01»; масса `…Kg` — с
  тремя знаками), ссылка на справочник (`productId`, `indicatorId`, `substanceId`, `regionId`, `regionCode`) — названием
  записи, если справочник прочитан (иначе id), null — «—», остальное как в API. Заголовок диалога —
  «Запись: действие словами» (`auditActionLabel`: `audit.actions.<operationId>`, `audit.jobs.<задача>` для `system.*`;
  неизвестное действие — как есть).
- Отчёты: одна карточка-форма (отчёт, предмет — отзыв или организация, период «с / по» не длиннее 366 дней, формат —
  радиокнопки); пока файл читается — `at-progress` «Загрузка отчёта» с «N МБ из M МБ».
- Поля страницы — `--gutter`, ширина контента до 1440 px.
- Заголовок `h1.at-page__title` всегда с `tabindex="-1"` (цель фокуса при смене маршрута). Экраны вне оболочки (вход, 2FA,
  пароль, регистрация, приглашение, 403/404 без сессии) — тот же `at-page` с шапкой; содержимое — в `at-card` под ней.

### Фокус при смене маршрута

Одинаково во всех трёх фреймворках: при каждой смене **пути** (`pathname`) на стороне клиента, кроме первой загрузки
приложения (в том числе после перенаправлений при старте), фокус переходит на `h1.at-page__title` новой страницы — как
только она отрисована (ленивый чанк мог грузиться). Изменение только query-параметров (фильтры, `?tab=`, `?page=`)
фокус не двигает. Переходы из модальных потоков сохраняют свои правила: выбор пункта в «Ещё» возвращает фокус на
«Ещё», диалог — на открывшую его кнопку. Отдельная скрытая живая область для объявления страницы не используется —
объявлением служит фокус на заголовке. Прокрутка — в начало страницы.

Внутри страницы: действие, открывшее новую форму или диалог, переводит фокус на её первое поле;
закрытие диалога возвращает фокус на кнопку, открывшую его; если элемент с фокусом исчез (выбор снят вместе с
«Отметить прочитанным», форма закрылась после успеха, карточка перечитана без него) — фокус на `h1.at-page__title`,
никогда не на `body`. Кнопка, недоступная на время ожидания 429, свой фокус не теряет: когда ожидание закончилось,
она получает его обратно, если фокус никуда не перенесли.

### Сбой загрузки при старте

Если не загрузился сам входной скрипт (ничего нашего не выполнилось), страницу закрывает статичный блок из
`index.html` — та же разметка, что у экрана сбоя чанка, но кнопка — ссылка без JS на текущую страницу:

```html
<div id="root"></div>
<main class="at-page at-boot" id="at-boot">
  <article class="at-card">
    <div class="at-empty">
      <p class="at-empty__text">Не удалось загрузить страницу.</p>
      <a class="at-button" data-variant="primary" href="">Повторить</a>
    </div>
  </article>
</main>
```

`.at-boot` (base.css) скрыт и появляется через 10 с одной CSS-анимацией (и при `prefers-reduced-motion`: это смена
состояния, не движение); приложение удаляет `#at-boot` первым делом при старте. Тексты — `empty.pageLoadFailed` и
`action.retry` из `@agrotrace/i18n`, подставляются при сборке (не пишутся в шаблоне руками).

## Публичная QR-страница `at-public`

`/p/:publicCode` и `/p/:publicCode/complaint` (ТЗ п. 9.6): без меню и сессии, отдельный лёгкий вход — весь JS страницы
(вход, её чанк, всё, что они импортируют, воркер ALTCHA) не больше 60 КБ gzip; сборка падает, если больше. На этой
странице нет кабинетного кода и полного словаря:

- **Тексты** — `@agrotrace/i18n/public` + словарь только активного языка
  `@agrotrace/i18n/public/<locale>.json` (ключи — `public-keys.ts`, файл собирает
  `pnpm --filter @agrotrace/i18n build:public`, тест следит, что он не устарел). Во всех фреймворках одинаково:

  ```ts
  import ru from '@agrotrace/i18n/public/ru.json';
  import { publicT, formatLocalDate, photoCredit } from '@agrotrace/i18n/public';
  const t = publicT(ru, 'ru'); // те же тексты, что у createT, без плюралов
  ```

  Новый текст страницы — ключ в `public-keys.ts` и пересборка подмножества; импорт `@agrotrace/i18n` на публичной
  странице запрещён.

- **API** — `@agrotrace/api-client/public` (`createPublicApi`: `getBatch`, `getCaptcha`, `createComplaint`;
  `retryAfterOf`), без протокола обновления сессии и openapi-fetch.
- **Иконки** — спрайт только из нужных символов (`check`, `alert`, `clock`), собранный так же, как `sprite.svg`
  (`<symbol id="i-…">`, первым потомком `<body>`); иллюстрации — только `recall-warning` и `empty-search`.

Разметка `/p/:publicCode` (под шапкой `at-page`; `h1.at-page__title` — название продукта, пока данных нет — «Партия»):

```html
<main class="at-page at-public" id="main" tabindex="-1">
  <div class="at-page__header"><h1 class="at-page__title" tabindex="-1">Пшеница мягкая</h1></div>
  <div class="at-public__stack">
    <article class="at-card" data-furrow>
      <div class="at-card__body">
        <!-- только RECALLED (FR-PUB-02): -->
        <div class="at-public__warning">
          <svg class="at-empty__art" aria-hidden="true" viewBox="0 0 240 160">…recall-warning…</svg>
          <h2 class="at-public__warning-title">Партия отозвана</h2>
          <p class="at-public__warning-text">Не употребляйте продукт из этой партии.</p>
        </div>
        <div class="at-public__hero">
          <figure class="at-public__photo">
            <img
              src="/api/v1/public/files/…?variant=480"
              alt=""
              width="480"
              height="360"
              fetchpriority="high"
            />
            <figcaption>Фото: <a href="…">Raman Deep</a>, <a href="…/by-sa/4.0">CC BY-SA 4.0</a></figcaption>
          </figure>
          <div class="at-public__summary">
            <p class="at-public__status" data-safety="SAFE">
              <svg class="at-public__status-icon" aria-hidden="true"><use href="#i-check" /></svg>Безопасна
            </p>
            <!-- BLOCKED / UNKNOWN: <p class="at-public__note">…</p> -->
            <dl class="at-card__facts">
              <div>
                <dt>Код партии</dt>
                <dd><span class="at-mono">AT-2026-000123</span></dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </article>
    <!-- «Происхождение»: p.at-public__org (at-avatar l square, логотип alt=""; «Хозяйство» у сырьевой партии,
         «Производитель» у производной) + at-card__facts -->
    <!-- «Путь продукта»: at-timeline по держателям, «18.07.2026 — 20.08.2026» / «с 20.08.2026» -->
    <!-- «Анализы»: at-card__facts (проведено, соответствуют, последний: дата + at-chip ok / danger) или p.at-public__note -->
    <div class="at-public__actions">
      <a class="at-button" data-variant="primary" href="/p/AT-2026-000123/complaint">Сообщить о проблеме</a>
    </div>
  </div>
</main>
```

- `data-safety` — `SafetyStatus` контракта: SAFE — группа ok (иконка `check`), RECALLED — danger-solid (`alert`),
  BLOCKED — danger (`alert`) и строка «Продажа партии остановлена до решения инспектора.», UNKNOWN — attention (`clock`)
  и «Партия ещё проходит проверку.». Текст статуса — `status.safety.*`; цвет не единственный носитель смысла.
- Фото продукта — вариант 480 (`withVariant`), декоративное (название — в `h1`); подпись автора и лицензии —
  `photoCredit(название)` (данные `db/seed/ATTRIBUTION.md`; у фото не из сида подписи нет). Даты — `formatLocalDate`.
- Состояния (в `at-public__stack` вместо карточек; у первой карточки всегда `data-furrow`): загрузка — `at-card` с
  `aria-busy="true"` и `at-skeleton`;
  неизвестный или неверный код (404 / 400; код не по шаблону `AT-ГГГГ-NNNNNN` — без запроса) — `at-card` > `at-empty`
  с `empty-search` и «Партия с таким кодом не найдена.» без кнопки; нет сети, сервис недоступен, 429 — `at-empty` с
  текстом и «Повторить» (после 429 — «Повторить через N с» до конца `Retry-After`, затем фокус по общим правилам фокуса).

Форма `/p/:publicCode/complaint` (`h1` «Сообщить о проблеме»):

```html
<article class="at-card" data-furrow>
  <div class="at-card__body">
    <p class="at-public__about">Пшеница мягкая <span class="at-mono">AT-2026-000123</span></p>
    <form id="complaint" class="at-public__form" novalidate>
      <div class="at-field">
        …<textarea class="at-textarea" id="complaint-text" maxlength="2000"></textarea>
      </div>
      <div class="at-field">…<input class="at-input" id="complaint-contact" maxlength="255" /></div>
      <!-- сообщение формы: <p class="at-field__error" role="alert">…</p>; ожидание 429 — at-field__warning -->
    </form>
  </div>
  <footer class="at-card__footer">
    <a class="at-button" data-variant="secondary" href="/p/AT-2026-000123">К партии</a>
    <button class="at-button" type="submit" form="complaint" data-variant="primary">Отправить жалобу</button>
  </footer>
</article>
```

- ALTCHA без внешних сервисов и без видимого виджета: с открытия формы страница берёт `GET /public/captcha` и решает
  задачу в воркере (отдельный файл того же источника: CSP `script-src 'self'` его покрывает, inline-скриптов нет);
  решение уходит в `altcha` один раз, следующая отправка — с новой задачей; решение, которому до `expires` меньше 30 с,
  заменяется новым. Пока задача решается и жалоба отправляется — кнопка `aria-busy`.
- Проверки до отправки — по контракту (текст обязателен, не короче 10 символов; контакт не из одних пробелов); текст и
  контакт уходят как введены, пустой контакт не отправляется. Ошибки — у полей (фокус на первое), остальное — одно
  сообщение формы `role="alert"` внутри карточки (тостов на публичной странице нет): CAPTCHA_FAILED — «Проверка защиты
  от спама не прошла — отправьте ещё раз», задача не получена или воркер не загрузился — «Не удалось подготовить
  проверку защиты от спама — отправьте ещё раз», нет сети — «Нет связи с сервером — проверьте подключение.»; 429 —
  кнопка «Повторить через N с» и `at-field__warning`; 404 — «Партия с таким кодом не найдена.» вместо формы.
- После 201 карточка показывает подтверждение: `<div class="at-card__body at-public__done">` с
  `<p class="at-public__done-text" tabindex="-1">Жалоба отправлена.</p>` и основной ссылкой «К партии»; фокус — на
  текст подтверждения (кнопки отправки больше нет).
- Переходы между двумя адресами — на клиенте (`history.pushState`, «Назад» — `popstate`), фокус на `h1` по правилу
  «Фокус при смене маршрута»; данные партии читаются один раз на документ.
