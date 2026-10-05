import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkDiscrepancy } from '@agrotrace/domain';
import { DEMO_PASSWORD, loadData, SEED_ROOT } from './data.js';
import { runScenario } from './scenario.js';
import { REFERENCE_NOW } from './time.js';
import { World, type Row } from './world.js';

export const DEMO_ACCOUNTS_URL = new URL('../../docs/demo-accounts.md', SEED_ROOT);

export function referenceWorld(): World {
  const regions = ['33', '50', '37', '52', '76', '62'].map((code, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    code,
  }));
  const roles = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'].map((code, i) => ({
    id: i + 1,
    code,
  }));
  const w = new World(
    loadData(),
    regions,
    roles,
    'agrotrace',
    'http://react-express.localhost',
    REFERENCE_NOW,
  );
  runScenario(w);
  return w;
}

export function generateDemoAccounts(): string {
  return renderDemoAccounts(referenceWorld());
}

export const STATUS_RU: Record<string, string> = {
  Created: 'Создана',
  OnTest: 'На анализе',
  Approved: 'Допущена',
  InTransit: 'В пути',
  Accepted: 'Принята',
  Processed: 'Переработана',
  OnSale: 'В продаже',
  Sold: 'Реализована',
  Blocked: 'Заблокирована',
  Recalled: 'Отозвана',
  WrittenOff: 'Списана',
};

const REGION_RU: Record<string, string> = {
  '33': 'Владимирская обл.',
  '37': 'Ивановская обл.',
  '50': 'Московская обл.',
  '52': 'Нижегородская обл.',
  '62': 'Рязанская обл.',
  '76': 'Ярославская обл.',
};

const REASON_RU: Record<string, string> = {
  NEW_FARM: 'новое хозяйство',
  LOW_RATING: 'рейтинг ниже 70',
  RECENT_PESTICIDE: 'пестициды за 30 дней',
  SAMPLED: 'выборка 20 %',
  RISK: 'риск-модель',
  PLANNED: 'плановая выборка',
  INSPECTOR: 'назначение инспектора',
  COMPLAINT: 'жалоба покупателя',
};

export const short = (name: unknown): string =>
  String(name)
    .replace(/^(ООО|АО|АНО|КФХ)\s+/, '')
    .replace(/[«»]/g, '');

export function renderDemoAccounts(w: World): string {
  const org = (id: unknown): Row => w.orgById(id);
  const code = (batchKey: string): string => w.batch(batchKey).public_code as string;
  const product = (b: Row): string => w.productById(b.product_id).name as string;
  const status = (b: Row): string => STATUS_RU[b.status as string]!;
  const hoursAgo = (t: unknown): string => {
    const h = Math.round((Date.parse(w.seedNow) - Date.parse(String(t))) / 3_600_000);
    return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн. назад`;
  };
  const regionCode = new Map(w.data.organizations.map((o) => [o.key, o.regionCode]));
  const orgKey = (id: unknown): string => [...w.keys.org.entries()].find(([, o]) => o.id === id)![0];
  const L: string[] = [];
  const p = (...lines: string[]): void => {
    L.push(...lines);
  };

  p(
    '# Демо-данные и учётные записи',
    '',
    'Демо-мир воспроизводится мок-бэкендом в браузере при каждой загрузке приложения. Все моменты времени',
    'отсчитываются от текущей минуты: история заканчивается «сейчас». Идентификаторы, коды партий и номера',
    'накладных детерминированы.',
    '',
    `Файл сгенерирован для момента сценария ${w.seedNow} (REFERENCE_NOW), поэтому коды ниже — ${w.year} года;`,
    `**коды для года запуска: AT-<год>-…, WB-<год>-…** (номера те же).`,
    '',
    `**Пароль всех демо-пользователей: \`${DEMO_PASSWORD}\`**. Двухфакторная аутентификация ни у кого`,
    'не включена. Все пользователи и организации в статусе ACTIVE. Названия организаций, адреса и телефоны',
    'вымышлены.',
    '',
    '## Учётные записи',
    '',
    '| Email | Роль | Организация | Руководитель организации | ФИО |',
    '|---|---|---|---|---|',
  );
  for (const u of w.data.users) {
    p(
      `| \`${u.email}\` | ${u.roles.join(', ')} | ${w.org(u.org).name as string} | ${u.isOrgAdmin ? 'да' : 'нет'} | ${u.fullName} |`,
    );
  }
  const withAvatar = w.data.users.filter((u) => u.avatar).map((u) => `\`${u.key}\``);
  p(
    '',
    `Аватарки (иллюстрации, не фото людей) есть у ${withAvatar.join(', ')}. У каждой организации — логотип-монограмма.`,
  );

  p(
    '',
    '## Организации',
    '',
    '| Организация | Тип | ИНН | Регион | Рейтинг доверия |',
    '|---|---|---|---|---|',
  );
  for (const o of w.t.organizations) {
    const rating = o.type === 'FARM' ? String(o.trust_rating) : '—';
    p(
      `| ${o.name as string} | ${o.type as string} | ${o.inn as string} | ${REGION_RU[regionCode.get(orgKey(o.id))!]} | ${rating} |`,
    );
  }
  p(
    '',
    'ИНН с корректными контрольными суммами; Заря, Петров, Луговая, Молкомбинат и Провизия совпадают с',
    'организациями демо-набора ветеринарных сопроводительных документов «Меркурия». Рейтинг хозяйств — свёртка BR-09 по их анализам и',
    `отзывам; ниже 70 он у хозяйств ${w.t.organizations
      .filter((o) => o.type === 'FARM' && (o.trust_rating as number) < 70)
      .map((o) => short(o.name))
      .join(', ')}, поэтому каждая их новая партия идёт на анализ (LOW_RATING).`,
  );

  const wb = (key: string): Row => w.waybill(key);
  p(
    '',
    '## Ключевые объекты для сценария защиты',
    '',
    '### Чистая цепочка «поле → лаборатория → переработка → магазин» с QR',
    '',
    `- Сырьё **${code('M1')}** — ${product(w.batch('M1'))}, ${short(org(w.batch('M1').origin_org_id).name)}, анализ PASS с протоколом PDF, «${status(w.batch('M1'))}».`,
    `- Накладная ${wb('wb-M1').number as string} (${short(org(wb('wb-M1').sender_org_id).name)} → ${short(org(wb('wb-M1').receiver_org_id).name)}).`,
    `- Продукт **${code('milk1')}** — ${product(w.batch('milk1'))}, «${status(w.batch('milk1'))}» у ${short(org(w.batch('milk1').holder_org_id).name)}, QR сгенерирован; публичная страница \`/p/${code('milk1')}\`.`,
    `- Накладная в магазин ${wb('wb-milk1').number as string}.`,
    '',
    `Граф глубины 4: ${['M2', 'milk2', 'cream1', 'butter1', 'ghee1'].map((k) => `${code(k)} (${product(w.batch(k)).toLowerCase()})`).join(' → ')}.`,
  );

  const recallSection = (key: string, title: string): void => {
    const r = w.recall(key);
    const source = w.batchById(r.source_batch_id);
    p('', `### ${title}`, '');
    p(
      `Исходная партия **${source.public_code as string}** (${product(source).toLowerCase()}, ${short(org(source.origin_org_id).name)}); ` +
        `причина: «${r.reason as string}»; открыт ${hoursAgo(r.opened_at)}, статус ${r.status as string}` +
        (r.block_upstream ? ', источники выше по графу заблокированы для расследования (UP).' : '.'),
      '',
      '| Партия | Продукт | Направление | Статус до отзыва | Статус сейчас | Задача изъятия |',
      '|---|---|---|---|---|---|',
    );
    const members = w.t.recall_batches
      .filter((x) => x.recall_id === r.id)
      .map((x) => ({ x, b: w.batchById(x.batch_id) }))
      .sort((a, c) => (a.b.public_code as string).localeCompare(c.b.public_code as string));
    for (const { x, b } of members) {
      const task = w.t.recall_tasks.find((t) => t.recall_id === r.id && t.batch_id === b.id);
      const taskText = task ? `${task.status as string} — ${short(org(task.holder_org_id).name)}` : '—';
      p(
        `| ${b.public_code as string} | ${product(b)} | ${x.direction as string} ${x.depth as number} | ${STATUS_RU[x.status_before as string]} | ${status(b)} | ${taskText} |`,
      );
    }
  };
  const failTest = w.test('M3:control');
  p(
    '',
    `Внеплановый анализ инспектора по партии ${code('M3')} (АгроТест): тетрациклины выше норматива → FAIL, ` +
      `протокол PDF (результат внесён ${hoursAgo(failTest.completed_at)}).`,
  );
  recallSection(
    'recall-milk',
    'Открытый отзыв № 1 — по результату анализа FAIL (задачи CONFIRMED и OVERDUE)',
  );
  recallSection('recall-cream', 'Открытый отзыв № 2 — запущен инспектором (задачи OPEN)');
  p(
    '',
    `Партия ${code('barley2')} (${product(w.batch('barley2')).toLowerCase()}) не прошла анализ риск-модели до всякой ` +
      'переработки: превышен дезоксиниваленол → «Заблокирована» (история OnTest → Blocked, LAB_FAIL); FAIL сразу ' +
      'запускает отзыв, который переводит заблокированную исходную партию в «Отозвана» (контракт, тег Recalls, шаг 5).',
  );
  recallSection(
    'recall-barley',
    'Открытый отзыв № 3 — FAIL партии до переработки (статус до отзыва «Заблокирована»)',
  );
  recallSection('recall-carrot', 'Закрытый отзыв — по жалобе покупателя');

  p('', '### Жалобы', '', '| Партия | Статус | Решение |', '|---|---|---|');
  for (const c of w.t.complaints) {
    const b = w.batchById(c.batch_id);
    p(
      `| ${b.public_code as string} (${product(b).toLowerCase()}) | ${c.status as string} | ${(c.decision as string | null) ?? '—'} |`,
    );
  }

  p(
    '',
    '### Лаборатория: анализы в работе',
    '',
    '| Партия | Статус анализа | Основание | Лаборатория |',
    '|---|---|---|---|',
  );
  for (const t of w.t.lab_tests.filter((x) => x.status !== 'DONE')) {
    const b = w.batchById(t.batch_id);
    const why =
      t.reason === 'RISK' || t.reason === 'PLANNED'
        ? REASON_RU[b.test_reason as string]
        : REASON_RU[t.reason as string];
    p(
      `| ${b.public_code as string} (${product(b).toLowerCase()}) | ${t.status as string} | ${why} | ${short(org(t.lab_org_id).name)} |`,
    );
  }
  p(
    '',
    `Для живой переработки: ${code('M6')} (${product(w.batch('M6')).toLowerCase()}) «${status(w.batch('M6'))}» у Молкомбината, ` +
      `${code('wheat2')} (${product(w.batch('wheat2')).toLowerCase()}) «${status(w.batch('wheat2'))}» у Мелькомбината. ` +
      `QR переработчика для собственной допущенной партии: ${code('tvorog4')}.`,
  );

  p(
    '',
    '## Накладные',
    '',
    '| Номер | Статус | Отправитель → получатель | Партии | Примечание |',
    '|---|---|---|---|---|',
  );
  for (const x of w.t.waybills) {
    const items = w.t.waybill_items.filter((i) => i.waybill_id === x.id);
    const codes = items.map((i) => w.batchById(i.batch_id).public_code as string).join(', ');
    const notes: string[] = [];
    for (const i of items) {
      if (i.mass_actual_kg === null) continue;
      const d = checkDiscrepancy({
        declaredKg: i.mass_declared_kg as string,
        actualKg: i.mass_actual_kg as string,
      });
      if ('percent' in d && d.percent !== '0.00')
        notes.push(
          `расхождение ${d.percent.replace('.', ',')} %${i.discrepancy_act ? ', акт' : ' без акта'}`,
        );
    }
    if (x.reject_reason) notes.push(`отказ: ${x.reject_reason as string}`);
    if (x.status === 'DRAFT') {
      const br01 = w.br01(w.seedNow, x._key as string).find((r) => !r.ok);
      notes.push(
        br01 && !br01.ok
          ? `отправка отклоняется BR-01: не истёк срок ожидания препарата «${br01.substance}»`
          : 'можно отправить',
      );
    }
    if (x.status === 'SENT') {
      const recalled = items.some((i) => w.batchById(i.batch_id).status === 'Recalled');
      notes.push(
        recalled
          ? 'партия отозвана в пути: приёмка отклоняется BR-06, отказ переназначит задачу отправителю'
          : 'можно принять',
      );
    }
    p(
      `| ${x.number as string} | ${x.status as string} | ${short(org(x.sender_org_id).name)} → ${short(org(x.receiver_org_id).name)} | ${codes} | ${notes.join('; ') || '—'} |`,
    );
  }

  p('', '## Полный список партий', '', '| Код | Продукт | Держатель | Статус |', '|---|---|---|---|');
  for (const b of w.t.batches) {
    let holder = short(org(b.holder_org_id).name);
    if (
      b.status === 'InTransit' ||
      (b.status === 'Recalled' &&
        w.t.recall_tasks.some((t) => t.batch_id === b.id && t.holder_org_id !== b.holder_org_id))
    ) {
      const sent = w.t.waybills.find(
        (x) =>
          x.status === 'SENT' && w.t.waybill_items.some((i) => i.waybill_id === x.id && i.batch_id === b.id),
      );
      if (sent) holder += ` (в пути в ${short(org(sent.receiver_org_id).name)})`;
    }
    p(
      `| ${b.public_code as string} | ${product(b)} | ${holder} | ${status(b)}${b.qr_png_file_id ? ', QR' : ''} |`,
    );
  }
  p(
    '',
    `Следующая партия, созданная через API, получит код AT-${w.year}-${String(w.t.batches.length + 1).padStart(6, '0')}, ` +
      `накладная — WB-${w.year}-${String(w.t.waybills.length + 1).padStart(6, '0')}.`,
    '',
    '## Замечания',
    '',
    '- Фото продуктов — Wikimedia Commons, авторы и лицензии в `db/seed/ATTRIBUTION.md`.',
    '',
  );
  return L.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeFileSync(DEMO_ACCOUNTS_URL, generateDemoAccounts());
  console.log(`seed:docs: docs/demo-accounts.md rendered for REFERENCE_NOW=${REFERENCE_NOW}`);
}
