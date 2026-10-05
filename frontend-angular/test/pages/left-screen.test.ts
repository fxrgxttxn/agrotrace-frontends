import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { File as NodeFile } from 'node:buffer';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse, type Json } from '../msw/fromContract';
import { asMe, dictionaries, pageOf, problem, PRODUCTS, toastText } from '../msw/data';
import { renderApp, type AppHarness } from '../app/renderApp';

const go = (h: AppHarness, url: string) => h.fixture.ngZone!.run(() => h.router.navigateByUrl(url));
const PLATFORM = {
  id: 'aa000000-0000-4000-8000-000000000001',
  name: 'ООО «АгроТрейс»',
  type: 'PLATFORM',
  logoUrl: null,
};
const asAdmin = () => asMe({ roles: ['ADMIN'], organization: PLATFORM, isOrgAdmin: true });
const org = (extra: Json = {}): Json => ({
  ...(contractExample('updateAdminOrganization').body as Json),
  status: 'ACTIVE',
  ...extra,
});
const NAME = org().name as string;
const user = (extra: Json = {}): Json => ({
  ...(contractExample('listUsers').body as Json).items[0],
  ...extra,
});
const png = () => new NodeFile(['img'], 'p.png', { type: 'image/png' }) as unknown as File;

function hold() {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  return { held, release: () => release() };
}

async function open(path: string, title: string) {
  const h = renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return h;
}
async function leave(h: AppHarness, path: string, title: string) {
  await go(h, path);
  await screen.findByRole('heading', { level: 1, name: title });
}

const UndiciFormData = (
  await new Response('', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData()
).constructor as typeof FormData;
beforeEach(() => vi.stubGlobal('FormData', UndiciFormData));
afterEach(() => vi.unstubAllGlobals());

describe('admin forms answering after their screen is gone', () => {
  it('org edit: the success is said on the next screen and the list is read again on return', async () => {
    const { held, release } = hold();
    let reads = 0;
    server.use(
      asAdmin(),
      dictionaries(),
      http.get(`${API_BASE}/admin/organizations`, () => {
        reads++;
        return HttpResponse.json(pageOf([org()]));
      }),
      contractResponse('updateAdminOrganization', {
        body: org({ name: 'КФХ Петров И.С.' }),
        onRequest: async () => void (await held),
      }),
      contractResponse('listUsers', { body: pageOf([]) }),
    );
    const h = await open('/admin/organizations', 'Организации');
    await userEvent.click(await screen.findByRole('button', { name: `Изменить ${NAME}` }));
    await userEvent.clear(screen.getByLabelText('Название'));
    await userEvent.type(screen.getByLabelText('Название'), 'КФХ Петров И.С.');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await leave(h, '/admin/users', 'Пользователи');
    release();
    await waitFor(() => expect(toastText('polite')).toContain('Организация КФХ Петров И.С. сохранена'));
    const before = reads;
    await leave(h, '/admin/organizations', 'Организации');
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it('org edit 404: nothing is said, but the list is read again on return', async () => {
    const { held, release } = hold();
    let reads = 0;
    server.use(
      asAdmin(),
      dictionaries(),
      http.get(`${API_BASE}/admin/organizations`, () => {
        reads++;
        return HttpResponse.json(pageOf([org()]));
      }),
      contractResponse('updateAdminOrganization', {
        status: 404,
        body: problem(404, 'NOT_FOUND'),
        onRequest: async () => void (await held),
      }),
      contractResponse('listUsers', { body: pageOf([]) }),
    );
    const h = await open('/admin/organizations', 'Организации');
    await userEvent.click(await screen.findByRole('button', { name: `Изменить ${NAME}` }));
    await userEvent.type(screen.getByLabelText('Название'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await leave(h, '/admin/users', 'Пользователи');
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(toastText()).toBe('');
    const before = reads;
    await leave(h, '/admin/organizations', 'Организации');
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it('invite: the success is said after the dialog and its screen are gone', async () => {
    const { held, release } = hold();
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('listUsers', { body: pageOf([user()]) }),
      contractResponse('listAdminOrganizations', { body: pageOf([]) }),
      contractResponse('inviteUser', {
        status: 201,
        body: user({ email: 'new@farm.ru', status: 'INVITED' }),
        onRequest: async () => void (await held),
      }),
    );
    const h = await open('/admin/users', 'Пользователи');
    await userEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
    const dialog = screen.getByRole('dialog', { name: 'Приглашение сотрудника' });
    await userEvent.type(within(dialog).getByLabelText('ФИО'), 'Смирнов Пётр');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'new@farm.ru');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Пригласить' }));
    await leave(h, '/admin/organizations', 'Организации');
    release();
    await waitFor(() => expect(toastText('polite')).toContain('Приглашение отправлено на new@farm.ru'));
    expect(toastText()).toBe('');
  });

  it('user edit: the success is said on the next screen', async () => {
    const { held, release } = hold();
    const u = user({ status: 'ACTIVE' });
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('listUsers', { body: pageOf([u]) }),
      contractResponse('listAdminOrganizations', { body: pageOf([]) }),
      contractResponse('updateUser', {
        body: user({ status: 'BLOCKED' }),
        onRequest: async () => void (await held),
      }),
    );
    const h = await open('/admin/users', 'Пользователи');
    await userEvent.click(await screen.findByRole('button', { name: `Изменить ${u.fullName}` }));
    await userEvent.click(screen.getByRole('radio', { name: 'Заблокирован' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await leave(h, '/admin/organizations', 'Организации');
    release();
    await waitFor(() => expect(toastText('polite')).toContain(`Сотрудник ${u.fullName} сохранён`));
    expect(toastText()).toBe('');
  });

  it('dictionary save: the success is said after the person left, the dictionary is read again', async () => {
    const { held, release } = hold();
    let reads = 0;
    const product = PRODUCTS[0]!;
    server.use(
      asAdmin(),
      http.get(`${API_BASE}/dictionaries/:name`, ({ params }) => {
        if (params['name'] === 'products') reads++;
        return HttpResponse.json(
          pageOf(
            params['name'] === 'products' ? PRODUCTS : [],
            params['name'] === 'products' ? 2 : 0,
            1,
            100,
          ),
        );
      }),
      contractResponse('updateDictionaryEntry', {
        body: { ...product, name: 'Пшеница яровая' } as Json,
        onRequest: async () => void (await held),
      }),
      contractResponse('listUsers', { body: pageOf([]) }),
    );
    const h = await open('/admin/dictionaries/products', 'Справочники');
    await userEvent.click(await screen.findByRole('button', { name: `Изменить ${product.name}` }));
    const dialog = screen.getByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Название'));
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Пшеница яровая');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await leave(h, '/admin/users', 'Пользователи');
    release();
    await waitFor(() => expect(toastText('polite')).toContain('Пшеница яровая — сохранено'));
    const before = reads;
    await leave(h, '/admin/dictionaries/products', 'Справочники');
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it('dictionary remove 404: nothing is said, but the dictionary is read again on return', async () => {
    const { held, release } = hold();
    let reads = 0;
    const product = PRODUCTS[0]!;
    server.use(
      asAdmin(),
      http.get(`${API_BASE}/dictionaries/:name`, ({ params }) => {
        if (params['name'] === 'products') reads++;
        return HttpResponse.json(
          pageOf(
            params['name'] === 'products' ? PRODUCTS : [],
            params['name'] === 'products' ? 2 : 0,
            1,
            100,
          ),
        );
      }),
      contractResponse('deleteDictionaryEntry', {
        status: 404,
        body: problem(404, 'NOT_FOUND'),
        onRequest: async () => void (await held),
      }),
      contractResponse('listUsers', { body: pageOf([]) }),
    );
    const h = await open('/admin/dictionaries/products', 'Справочники');
    await userEvent.click(await screen.findByRole('button', { name: `Удалить ${product.name}` }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить' }));
    await leave(h, '/admin/users', 'Пользователи');
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(toastText()).toBe('');
    const before = reads;
    await leave(h, '/admin/dictionaries/products', 'Справочники');
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it('product photo: the success is said after the person left', async () => {
    const { held, release } = hold();
    const product = PRODUCTS[0]!;
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('uploadProductImage', { onRequest: async () => void (await held) }),
      contractResponse('listUsers', { body: pageOf([]) }),
    );
    const h = await open('/admin/dictionaries/products', 'Справочники');
    await userEvent.click(await screen.findByRole('button', { name: `Фото ${product.name}` }));
    const dialog = screen.getByRole('dialog', { name: `Фото: ${product.name}` });
    await userEvent.upload(within(dialog).getByLabelText('Файл'), png());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Загрузить' }));
    await leave(h, '/admin/users', 'Пользователи');
    release();
    await waitFor(() => expect(toastText('polite')).toContain(`Фото ${product.name} сохранено`));
    expect(toastText()).toBe('');
  });

  it('organization logo: the success is said after the head left the staff screen', async () => {
    const { held, release } = hold();
    server.use(
      contractResponse('listUsers', { body: pageOf([user()]) }),
      contractResponse('uploadOrganizationLogo', { onRequest: async () => void (await held) }),
    );
    const h = await open('/org/staff', 'Сотрудники');
    await userEvent.upload(screen.getByLabelText('Файл'), png());
    await userEvent.click(await screen.findByRole('button', { name: 'Загрузить' }));
    await leave(h, '/profile', 'Профиль');
    release();
    await waitFor(() => expect(toastText('polite')).toContain('Логотип сохранён'));
    expect(toastText()).toBe('');
  });
});
