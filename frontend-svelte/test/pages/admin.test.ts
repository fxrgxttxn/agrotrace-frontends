import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse, type Json } from '../msw/fromContract';
import { asMe, dictionaries, pageOf, problem, toastText } from '../msw/data';
import { renderApp } from '../app/renderApp';

const PLATFORM = {
  id: 'aa000000-0000-4000-8000-000000000001',
  name: 'ООО «АгроТрейс»',
  type: 'PLATFORM',
  logoUrl: null,
};
const asAdmin = () => asMe({ roles: ['ADMIN'], organization: PLATFORM, isOrgAdmin: true });
const org = (extra: Json = {}): Json => ({
  ...(contractExample('updateAdminOrganization').body as Json),
  ...extra,
});
const NAME = org().name as string;

async function open(path: string, title: string) {
  const utils = await renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return utils;
}
async function openFilters() {
  const toggle = document.querySelector<HTMLElement>('.at-page__filters-toggle');
  if (toggle && !toggle.closest('details')!.open) await userEvent.click(toggle);
}

describe('/admin/organizations', () => {
  it('lists applications with their actions; «Заявки» asks for PENDING and MANUAL_CHECK', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('listAdminOrganizations', {
        body: pageOf([org()]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    await open('/admin/organizations', 'Организации');
    const row = (await screen.findByText(NAME)).closest('tr')!;
    expect(within(row).getByText('На рассмотрении')).toHaveAttribute('data-tone', 'attention');
    expect(within(row).getByRole('button', { name: `Одобрить заявку ${NAME}` })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: `Отклонить заявку ${NAME}` })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: `Приостановить ${NAME}` })).toBeNull();
    await openFilters();
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'Заявки');
    await waitFor(() => expect(seen.at(-1)!.getAll('status').sort()).toEqual(['MANUAL_CHECK', 'PENDING']));
    expect(new URLSearchParams(location.search).getAll('status').sort()).toEqual(['MANUAL_CHECK', 'PENDING']);
  });

  it('approves an application: the list is read again and a toast says so', async () => {
    let approved = false;
    let reads = 0;
    server.use(
      asAdmin(),
      dictionaries(),
      http.get(`${API_BASE}/admin/organizations`, () => {
        reads++;
        return HttpResponse.json(pageOf([org(approved ? { status: 'ACTIVE' } : {})]));
      }),
      contractResponse('approveOrganization', {
        body: org({ status: 'ACTIVE' }),
        onRequest: () => void (approved = true),
      }),
    );
    await open('/admin/organizations', 'Организации');
    await userEvent.click(await screen.findByRole('button', { name: `Одобрить заявку ${NAME}` }));
    await waitFor(() => expect(toastText('polite')).toContain(`Организация ${NAME} одобрена`));
    expect(await screen.findByRole('button', { name: `Приостановить ${NAME}` })).toBeInTheDocument();
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('rejects after a confirmation: PATCH {status: REJECTED}', async () => {
    let body: unknown = null;
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('listAdminOrganizations', { body: pageOf([org()]) }),
      contractResponse('updateAdminOrganization', {
        body: org({ status: 'REJECTED' }),
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await open('/admin/organizations', 'Организации');
    await userEvent.click(await screen.findByRole('button', { name: `Отклонить заявку ${NAME}` }));
    const dialog = screen.getByRole('dialog', { name: `Отклонить заявку ${NAME}` });
    expect(within(dialog).getByText(/Отклонённую заявку нельзя одобрить/)).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отклонить заявку' }));
    await waitFor(() => expect(body).toEqual({ status: 'REJECTED' }));
    await waitFor(() => expect(toastText('polite')).toContain(`Заявка ${NAME} отклонена`));
  });

  it('409 INVALID_TRANSITION (another administrator acted): the list is read again and the new status said', async () => {
    let reads = 0;
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('listAdminOrganizations', { body: pageOf([org()]), onRequest: () => void reads++ }),
      contractResponse('approveOrganization', { status: 409, example: 'invalidTransition' }),
    );
    await open('/admin/organizations', 'Организации');
    await userEvent.click(await screen.findByRole('button', { name: `Одобрить заявку ${NAME}` }));
    await waitFor(() =>
      expect(toastText()).toContain(`Статус ${NAME} уже изменён: «Активна». Список обновлён.`),
    );
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
  });

  it('edits name and address: only what changed is sent', async () => {
    let body: unknown = null;
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('listAdminOrganizations', { body: pageOf([org({ status: 'ACTIVE' })]) }),
      contractResponse('updateAdminOrganization', {
        body: org({ status: 'ACTIVE', name: 'КФХ Петров И.С.' }),
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await open('/admin/organizations', 'Организации');
    await userEvent.click(await screen.findByRole('button', { name: `Изменить ${NAME}` }));
    const name = screen.getByLabelText('Название');
    expect(name).toHaveFocus();
    await userEvent.clear(name);
    await userEvent.type(name, 'КФХ Петров И.С.');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(body).toEqual({ name: 'КФХ Петров И.С.' }));
    await waitFor(() => expect(toastText('polite')).toContain('Организация КФХ Петров И.С. сохранена'));
  });
});

const user = (extra: Json = {}): Json => ({
  ...(contractExample('listUsers').body as Json).items[0],
  ...extra,
});

describe('/admin/users', () => {
  it('invites into a chosen organization: the role follows its type', async () => {
    let body: Json | null = null;
    const lab = {
      id: '5a7c9e1b-3d5f-4a7c-9e1b-3d5f7a9c1e3b',
      name: 'ИЛ «Кубаньтест»',
      type: 'LAB',
      logoUrl: null,
    };
    server.use(
      asAdmin(),
      contractResponse('listUsers', { body: pageOf([user()]) }),
      contractResponse('listOrganizations', {
        body: pageOf([{ ...lab, region: { code: '23', name: 'Краснодарский край' } }]),
      }),
      contractResponse('inviteUser', {
        status: 201,
        body: user({ email: 'new@lab.ru', status: 'INVITED' }),
        onRequest: async (r) => void (body = (await r.json()) as Json),
      }),
    );
    await open('/admin/users', 'Пользователи');
    await userEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
    const dialog = screen.getByRole('dialog', { name: 'Приглашение сотрудника' });
    expect(within(dialog).getByLabelText('ФИО')).toHaveFocus();
    expect(within(dialog).getByText('Роль: Администратор')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('ФИО'), 'Смирнов Пётр');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'new@lab.ru');
    await userEvent.type(within(dialog).getByRole('combobox', { name: /Организация/ }), 'Кубань');
    const list = await screen.findByRole('listbox', { name: /Организация/ });
    await userEvent.click((await within(list).findAllByRole('option'))[0]!);
    expect(within(dialog).getByText('Роль: Лаборант')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Пригласить' }));
    await waitFor(() =>
      expect(body).toEqual({
        email: 'new@lab.ru',
        fullName: 'Смирнов Пётр',
        roles: ['LAB'],
        isOrgAdmin: false,
        organizationId: lab.id,
      }),
    );
    await waitFor(() => expect(toastText('polite')).toContain('Приглашение отправлено на new@lab.ru'));
  });

  it('a taken email is said on its field', async () => {
    server.use(
      asAdmin(),
      contractResponse('listUsers', { body: pageOf([user()]) }),
      contractResponse('inviteUser', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { email: ['validation.email.taken'] } }),
      }),
    );
    await open('/admin/users', 'Пользователи');
    await userEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
    await userEvent.type(screen.getByLabelText('ФИО'), 'Смирнов Пётр');
    await userEvent.type(screen.getByLabelText('Email'), 'taken@lab.ru');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Пригласить' }));
    expect(await screen.findByLabelText('Email')).toHaveAccessibleDescription('Email уже зарегистрирован');
  });

  it('blocks a user; 409 INVALID_TRANSITION re-reads the list', async () => {
    const u = user();
    let body: unknown = null;
    server.use(
      asAdmin(),
      contractResponse('listUsers', { body: pageOf([u]) }),
      contractResponse('updateUser', {
        body: user({ status: 'BLOCKED' }),
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await open('/admin/users', 'Пользователи');
    await userEvent.click(await screen.findByRole('button', { name: `Изменить ${u.fullName}` }));
    await userEvent.click(screen.getByRole('radio', { name: 'Заблокирован' }));
    expect(screen.getByText(/не сможет войти/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(body).toEqual({ status: 'BLOCKED' }));
    await waitFor(() => expect(toastText('polite')).toContain(`Сотрудник ${u.fullName} сохранён`));

    let reads = 0;
    server.use(
      contractResponse('listUsers', { body: pageOf([u]), onRequest: () => void reads++ }),
      contractResponse('updateUser', { status: 409 }),
    );
    await userEvent.click(await screen.findByRole('button', { name: `Изменить ${u.fullName}` }));
    await userEvent.click(screen.getByRole('radio', { name: 'Заблокирован' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(toastText()).toContain('уже «Приглашён». Список обновлён.'));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(1));
  });
});

describe('/org/staff', () => {
  it('a head invites into the own organization (no organizationId, the role of its type); no edit of themselves', async () => {
    let body: Json | null = null;
    const me = contractExample('getMe').body as Json;
    const self = user({ id: me.id, fullName: me.fullName, email: me.email, isOrgAdmin: true });
    server.use(
      contractResponse('listUsers', { body: pageOf([self, user()]) }),
      contractResponse('inviteUser', {
        status: 201,
        body: user({ status: 'INVITED' }),
        onRequest: async (r) => void (body = (await r.json()) as Json),
      }),
    );
    await open('/org/staff', 'Сотрудники');
    expect(await screen.findByText('Логотип организации')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Изменить ${me.fullName}` })).toBeNull();
    expect(await screen.findByRole('button', { name: `Изменить ${user().fullName}` })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
    expect(screen.queryByRole('combobox', { name: /Организация/ })).toBeNull();
    await userEvent.type(screen.getByLabelText('ФИО'), 'Иванова Ольга');
    await userEvent.type(screen.getByLabelText('Email'), 'olga@kfh-petrov.ru');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Руководитель организации' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Пригласить' }));
    await waitFor(() =>
      expect(body).toEqual({
        email: 'olga@kfh-petrov.ru',
        fullName: 'Иванова Ольга',
        roles: ['FARMER'],
        isOrgAdmin: true,
      }),
    );
  });
});
