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
- Загрузка / пусто — вместо списка вариантов тот же контейнер без `role=listbox`:
  `<div class="at-combobox__list" id="product-list" role="status"><p class="at-combobox__status">…</p></div>`
  (загрузка: `<span class="at-spinner" aria-hidden="true"></span>Поиск` и `aria-busy="true"` на поле; пусто: «Ничего не найдено.»).
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
      <option value="massKg:desc">Масса, по убыванию</option>
      <option value="code:asc">Код партии</option>
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
  `td[data-primary]` и `td[data-status-cell]` — первая строка карточки, `.at-table__actions` — кнопки во всю ширину.
  Пустая ячейка действий скрывается. `data-label` = текст заголовка столбца. Шапка (`thead`) в режиме карточек
  скрыта (`display: none`); сортировка и «Выбрать все» — в `.at-table-mobilebar` над карточками (один `select`
  «поле: направление», значение то же, что у сортировки в URL; флажок «Выбрать все» — то же состояние, что флажок
  в шапке, включая `indeterminate`). Действия строки остаются на каждой карточке. На ≥ 768 px `.at-table-mobilebar`
  скрыт.
- `.at-table-wrap` прокручивается по горизонтали на любой ширине (таблица без `data-cards` не расширяет страницу);
  в режиме карточек прокрутки нет.

### Пагинация `at-pagination`

```html
<nav class="at-pagination" aria-label="Страницы">
  <p class="at-pagination__summary">1–20 из 248</p>
  <ul class="at-pagination__pages">
    <li>
      <button class="at-pagination__item" type="button" aria-label="Предыдущая страница" disabled>
        …#i-chevron-left…
      </button>
    </li>
    <li><a class="at-pagination__item" href="?page=1" aria-current="page">1</a></li>
    <li><a class="at-pagination__item" href="?page=2">2</a></li>
    <li><span class="at-pagination__gap" aria-hidden="true">…</span></li>
    <li>
      <a class="at-pagination__item" href="?page=2" aria-label="Следующая страница">…#i-chevron-right…</a>
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
<div class="at-tabs__panel" role="tabpanel" id="panel-tests" aria-labelledby="tab-tests" tabindex="0" hidden>
  …
</div>
```

Роуминг-табиндекс: у выбранной вкладки явно `tabindex="0"`, у остальных `tabindex="-1"`. Неактивные панели
выводятся с атрибутом `hidden` (или не выводятся вовсе); видима только панель выбранной вкладки. ← / → — соседняя вкладка (по кругу),
Home / End — первая / последняя; выбор при перемещении фокуса. Вкладка карточки партии отражается в `?tab=`.

### Диалог `at-dialog`

```html
<dialog class="at-dialog" aria-labelledby="recall-title">
  <!-- data-size="l" — широкий -->
  <div class="at-dialog__header">
    <h2 class="at-dialog__title" id="recall-title">Запустить отзыв</h2>
    <button class="at-button" data-variant="ghost" data-icon-only type="button" aria-label="Закрыть">
      …#i-close…
    </button>
  </div>
  <div class="at-dialog__body">…повтор ключевого параметра (кода партии)…</div>
  <div class="at-dialog__actions">
    <button class="at-button" data-variant="ghost" type="button">Отмена</button>
    <button class="at-button" data-variant="danger" type="button">Запустить отзыв</button>
  </div>
</dialog>
```

Открытие — `showModal()` (фокус-ловушка и Esc — нативные), закрытие — `close()`; фокус возвращается на кнопку,
открывшую диалог.

- Начальный фокус: первый фокусируемый элемент тела диалога (для подтверждения отзыва — поле повтора кода партии);
  если в теле его нет — заголовок `.at-dialog__title` с `tabindex="-1"` (не кнопка «Закрыть» и не опасная кнопка).
- Щелчок по подложке (`::backdrop`, т. е. `event.target === dialog`) закрывает только диалоги без необратимого
  действия (меню «Ещё», просмотр). Диалоги подтверждения (отзыв, отказ в приёмке, изъятие) закрываются только
  кнопкой «Отмена», крестиком или Esc.
- Опасная кнопка подтверждения недоступна (`disabled`), пока повторённый код партии не совпадает. Подложка — `--c-backdrop`. На < 768 px диалог прижат к нижнему краю, кнопки растянуты.

### Уведомления `at-toast`

```html
<div class="at-toasts">
  <!-- один на приложение: две области -->
  <div class="at-toast-region" role="alert">…ошибки (data-tone="danger")…</div>
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
        …#i-close…
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

`data-tone` — группа статуса; `data-current` — последний шаг (заполненный маркер).

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

`<span class="at-skeleton" data-shape="text|block|circle" style="width: 40%"></span>`; контейнер области — `aria-busy="true"`.

### Аватар `at-avatar`

```html
<span class="at-avatar" data-size="m"><img src="…" alt="Иван Петров" /></span>
<span class="at-avatar" data-size="m" role="img" aria-label="Иван Петров">ИП</span>
<span class="at-avatar" data-size="l" data-shape="square"><img src="…" alt="КФХ Петров" /></span>
<!-- логотип -->
```

Размеры `s` 24, `m` 32 (по умолчанию), `l` 56 px. Рядом с именем картинка декоративная: `alt=""`, без `role`.

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

### Прогресс `at-progress`

```html
<div class="at-progress">
  <!-- data-tone="danger" -->
  <span class="at-progress__label" id="recall-progress">Подтверждено</span>
  <span class="at-progress__value">7 из 12</span>
  <progress class="at-progress__bar" max="12" value="7" aria-labelledby="recall-progress"></progress>
</div>
```

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

Цвета узлов — `--status-<статус>-bg|fg` (читаются через `getComputedStyle`). На < 768 px граф открывается
кнопкой в режиме `data-fullscreen`; Esc и кнопка «Закрыть» выходят из него.

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
        <svg class="at-sidebar__icon" aria-hidden="true"><use href="#i-recall" /></svg>
        <span class="at-sidebar__label">Задачи отзыва</span>
        <span class="at-visually-hidden">, открытых:</span><span class="at-sidebar__count">1</span>
      </a>
    </li>
  </ul>
  <div class="at-sidebar__footer">…необязательно…</div>
</nav>
```

`aria-current="page"` — текущий раздел (и для вложенных маршрутов раздела).

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

«Ещё» открывает остальные пункты роли и профиль в `at-dialog` (на < 768 px — нижний лист); `aria-expanded` на
кнопке отражает открытие, `aria-controls` указывает на диалог:

```html
<dialog class="at-dialog" id="more-menu" aria-labelledby="more-title">
  <div class="at-dialog__header">
    <h2 class="at-dialog__title" id="more-title" tabindex="-1">Ещё</h2>
    <button class="at-button" data-variant="ghost" data-icon-only type="button" aria-label="Закрыть">
      …#i-close…
    </button>
  </div>
  <div class="at-dialog__body">
    <nav aria-label="Остальные разделы">
      <ul class="at-sidebar__list">
        <li>
          <a class="at-sidebar__link" href="/recall-tasks"
            ><svg class="at-sidebar__icon" aria-hidden="true"><use href="#i-recall" /></svg
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
    <h1 class="at-page__title">Партии</h1>
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
  раскрывается под строкой поиска. Значения фильтров — в query-параметрах URL.
- Поля страницы — `--gutter`, ширина контента до 1440 px.
