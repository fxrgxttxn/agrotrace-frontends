import { expect, test } from '@playwright/test';
import { freshEmail, randomInn, shot, signIn, signOut, unexpected, watch } from './helpers';

const SHOTS = 'admin';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('ADMIN approves a fresh application, edits and suspends it, invites an employee', async ({ page }) => {
  const w = await watch(page);
  const name = `ООО «Заявка ${Date.now().toString(36)}»`;
  await page.goto('/register');
  await page.getByLabel('ИНН').fill(randomInn());
  await page.getByLabel('Тип организации').selectOption('RETAILER');
  await page.getByLabel('Название').fill(name);
  await page.getByLabel('Регион').selectOption({ index: 1 });
  await page.getByLabel('Email').fill(freshEmail('head'));
  await page.getByLabel('ФИО').fill('Тестов Тест Тестович');
  await page.getByLabel('Пароль').fill('register-pass-2026');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page.getByText(/^Заявка отправлена\./)).toBeVisible({ timeout: 20000 });

  await signIn(page, 'admin@agrotrace.test', w);
  await page.goto('/admin/organizations?status=PENDING&status=MANUAL_CHECK');
  await expect(page.getByRole('heading', { level: 1, name: 'Организации' })).toBeVisible();
  await expect(page.getByLabel('Статус')).toHaveValue('__applications');
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await shot(page, SHOTS, 'organizations-applications');
  for (const width of [768, 900, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const wrap = page.locator('.at-table-wrap').first();
    expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth), `table scroll at ${width}`).toBe(0);
    const box = (await wrap.boundingBox())!;
    for (const action of [`Одобрить заявку ${name}`, `Отклонить заявку ${name}`, `Изменить ${name}`]) {
      const b = (await page.getByRole('button', { name: action }).boundingBox())!;
      expect(b.x + b.width, `${action} at ${width}`).toBeLessThanOrEqual(box.x + box.width);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('button', { name: `Одобрить заявку ${name}` }).click();
  await expect(page.getByText(`Организация ${name} одобрена`)).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.goto(`/admin/organizations?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole('row').filter({ hasText: name }).getByText('Активна')).toBeVisible();
  await page.getByRole('button', { name: `Изменить ${name}` }).click();
  const edit = page.getByRole('dialog', { name: `Организация ${name}` });
  await expect(edit.getByLabel('Название')).toBeFocused();
  await edit.getByLabel('Адрес').fill('600000, г. Владимир, ул. Полевая, д. 1');
  await edit.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText(`Организация ${name} сохранена`)).toBeVisible();

  await page.getByRole('button', { name: `Приостановить ${name}` }).click();
  const confirm = page.getByRole('dialog', { name: `Приостановить ${name}` });
  await shot(page, SHOTS, 'organization-suspend');
  await confirm.getByRole('button', { name: 'Приостановить' }).click();
  await expect(page.getByText(`Работа ${name} приостановлена`)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: name }).getByText('Приостановлена')).toBeVisible();
  await page.getByRole('button', { name: `Возобновить ${name}` }).click();
  await expect(page.getByText(`Работа ${name} возобновлена`)).toBeVisible();

  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Пользователи' })).toBeVisible();
  await page.getByRole('button', { name: 'Пригласить' }).click();
  const invite = page.getByRole('dialog', { name: 'Приглашение сотрудника' });
  await invite.getByLabel('ФИО').fill('Новикова Вера Павловна');
  const email = freshEmail('invite');
  await invite.getByLabel('Email').fill(email);
  await invite.getByRole('combobox', { name: /Организация/ }).fill('ООО «Фер');
  await page
    .getByRole('listbox', { name: /Организация/ })
    .getByRole('option')
    .first()
    .click();
  await expect(invite.getByText('Роль: Продавец')).toBeVisible();
  await shot(page, SHOTS, 'users-invite');
  await invite.getByRole('button', { name: 'Пригласить' }).click();
  await expect(page.getByText(`Приглашение отправлено на ${email}`)).toBeVisible();
  await page.goto(`/admin/users?q=${encodeURIComponent(email)}`);
  await expect(page.getByRole('row').filter({ hasText: email }).getByText('Приглашён')).toBeVisible();
  await page.goto('/admin/users');
  await expect(page.getByRole('table', { name: 'Пользователи' })).toBeVisible();
  await shot(page, SHOTS, 'users');
  expect(unexpected(w)).toEqual([]);
});

test('ADMIN dictionaries: add, import with its report, refused files, a region in use', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'admin@agrotrace.test', w);
  await page.goto('/admin/dictionaries/products');
  await expect(page.getByRole('tab', { name: 'Продукты' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('table', { name: 'Продукты' })).toBeVisible();
  await shot(page, SHOTS, 'dictionary-products');

  const product = `Ячмень e2e ${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'Добавить' }).click();
  const add = page.getByRole('dialog', { name: 'Новый продукт' });
  await add.getByLabel('Название').fill(product);
  await add.getByLabel('Категория').selectOption('GRAIN');
  await add.getByLabel('Норма потерь, %').fill('3,5');
  await add.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByText(`${product} — добавлено`)).toBeVisible();

  const csv = `name;category;lossNormPercent\n${product} озимый;GRAIN;3.50\nОвёс e2e;GRAIN;abc\n`;
  await page.getByRole('button', { name: 'Импорт' }).click();
  const imp = page.getByRole('dialog', { name: 'Импорт: Продукты' });
  await imp
    .getByLabel('Файл')
    .setInputFiles({ name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await imp.getByRole('button', { name: 'Импортировать' }).click();
  const report = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Отчёт об импорте: Продукты' }) });
  await expect(report).toBeVisible();
  await expect(page.getByRole('button', { name: 'Импорт' })).toBeFocused();
  const rejected = report.getByRole('table', { name: 'Отклонённые строки' });
  await expect(rejected.getByRole('row').nth(1)).toContainText('3');
  await expect(rejected.getByRole('row').nth(1)).toContainText('Норма потерь, %');
  await shot(page, SHOTS, 'dictionary-import-report');

  await page.getByRole('button', { name: 'Импорт' }).click();
  await imp.getByLabel('Файл').setInputFiles({
    name: 'products.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('название;категория\nЯчмень;GRAIN\n'),
  });
  await imp.getByRole('button', { name: 'Импортировать' }).click();
  await expect(
    imp.getByText('Первая строка файла должна быть заголовком: name;category;lossNormPercent').first(),
  ).toBeVisible();
  await imp.getByLabel('Файл').setInputFiles({
    name: 'book.xlsx',
    mimeType: XLSX,
    buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)]),
  });
  await imp.getByRole('button', { name: 'Импортировать' }).click();
  await expect(imp.getByText(/^Файл не читается как книга Excel/).first()).toBeVisible();
  await shot(page, SHOTS, 'dictionary-import-refused');
  await imp.getByRole('button', { name: 'Отмена' }).click();

  await page.getByRole('tab', { name: 'Регионы' }).click();
  await expect(page).toHaveURL(/\/admin\/dictionaries\/regions$/);
  await expect(page.getByRole('tab', { name: 'Регионы' })).toBeFocused();
  await page.getByRole('button', { name: /^Удалить Владимир/ }).click();
  const del = page.getByRole('dialog', { name: /^Удалить Владимир/ });
  await del.getByRole('button', { name: 'Удалить' }).click();
  await expect(del.getByText(/нельзя удалить: на запись ссылаются организации/)).toBeVisible();
  const pageAlerts = page.locator('.at-toast-region[role="alert"] .at-toast');
  await expect(pageAlerts).toHaveCount(0);
  await del.getByRole('button', { name: 'Отмена' }).click();
  await expect(
    pageAlerts.filter({ hasText: /нельзя удалить: на запись ссылаются организации/ }),
  ).toBeVisible();

  await page.goto('/admin/dictionaries/norms');
  await expect(page.getByRole('table', { name: 'Нормативы' })).toBeVisible();
  await page
    .getByRole('button', { name: /^Удалить / })
    .first()
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
  await expect(page.getByText(/ — удалено$/)).toBeVisible();
  await page.goto('/admin/audit?entityType=norm');
  await page
    .getByRole('button', { name: /^Изменения записи журнала/ })
    .first()
    .click();
  const changes = page.getByRole('dialog').getByRole('table', { name: 'Изменённые поля' });
  for (const [label, api] of [
    ['Продукт', 'productId'],
    ['Показатель', 'indicatorId'],
    ['Максимальное значение', 'maxValue'],
  ] as const)
    await expect(changes.getByRole('row').filter({ hasText: api })).toContainText(label);
  await expect(changes).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  await shot(page, SHOTS, 'audit-diff-norm');
  expect(
    unexpected(w, [
      /^http 400 POST \/api\/v1\/dictionaries\/products\/import$/,
      /^http 415 POST \/api\/v1\/dictionaries\/products\/import$/,
      /^http 409 DELETE \/api\/v1\/dictionaries\/regions\//,
    ]),
  ).toEqual([]);
});

test('audit diff and report downloads (ADMIN); INSPECTOR reads the log but not the users', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'admin@agrotrace.test', w);
  await page.goto('/admin/audit');
  await expect(page.getByRole('table', { name: 'Журнал аудита' })).toBeVisible();
  await page
    .getByRole('button', { name: /^Изменения записи журнала/ })
    .first()
    .click();
  const diff = page.getByRole('dialog');
  await expect(diff.getByRole('table', { name: 'Изменённые поля' })).toBeVisible();
  await shot(page, SHOTS, 'audit-diff');
  await diff.getByRole('button', { name: 'Закрыть' }).first().click();
  await shot(page, SHOTS, 'audit');

  await page.goto('/reports');
  await page.getByLabel('Отчёт').selectOption({ label: 'Отзывы' });
  await shot(page, SHOTS, 'reports');
  const xlsx = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать отчёт' }).click();
  expect((await xlsx).suggestedFilename()).toMatch(
    /^agrotrace-recalls_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/,
  );
  await expect(page.getByText(/^Отчёт agrotrace-recalls_.*\.xlsx скачан$/)).toBeVisible();
  expect(unexpected(w)).toEqual([]);
  await signOut(page);

  await signIn(page, 'inspector@agrotrace.test', w);
  await page.goto('/admin/audit');
  await expect(page.getByRole('table', { name: 'Журнал аудита' })).toBeVisible();
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Нет доступа' })).toBeVisible();
});

test('a head of organization: staff, invitation into the own organization, the organization report', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'zarya.head@agrotrace.test', w);
  await page.goto('/org/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'Сотрудники' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Логотип организации' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Изменить Соколов Андрей Викторович' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Пригласить' }).click();
  const invite = page.getByRole('dialog', { name: 'Приглашение сотрудника' });
  await expect(invite.getByText('Роль: Фермер')).toBeVisible();
  const email = freshEmail('agronom');
  await invite.getByLabel('ФИО').fill('Агрономова Анна');
  await invite.getByLabel('Email').fill(email);
  await invite.getByRole('button', { name: 'Пригласить' }).click();
  await expect(page.getByText(`Приглашение отправлено на ${email}`)).toBeVisible();
  await shot(page, SHOTS, 'staff');

  await page.goto('/reports');
  const types = page.getByLabel('Отчёт').locator('option');
  await expect(types).toHaveText(['Партии', 'Сводка по организации']);
  await page.getByLabel('Отчёт').selectOption({ label: 'Сводка по организации' });
  await page.getByRole('radio', { name: 'PDF' }).check();
  const pdf = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать отчёт' }).click();
  expect((await pdf).suggestedFilename()).toMatch(/^agrotrace-org_2312450016_.*\.pdf$/);
  await shot(page, SHOTS, 'reports-head');
  expect(unexpected(w)).toEqual([]);
});

test('organizations: a single row action stands where the stacked ones do', async ({ page }) => {
  await signIn(page, 'admin@agrotrace.test');
  await page.goto('/admin/organizations');
  await expect(page.getByRole('table', { name: 'Организации' })).toBeVisible();
  for (const width of [768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const edits = page.getByRole('button', { name: /^Изменить / });
    const boxes = await edits.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return `${Math.round(r.left)}–${Math.round(r.right)}`;
      }),
    );
    expect(new Set(boxes).size, `${width}: ${boxes.join(' ')}`).toBe(1);
  }
});
