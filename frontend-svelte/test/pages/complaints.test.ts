import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse, type Json } from '../msw/fromContract';
import { asMe, pageOf, problem, toastText } from '../msw/data';
import { renderApp } from '../app/renderApp';

const INSPECTION = {
  id: 'f1a2b3c4-5000-4000-8000-000000000900',
  name: 'Инспекция агропродовольственного надзора',
  type: 'AUTHORITY',
  logoUrl: null,
};
const asInspector = () => asMe({ roles: ['INSPECTOR'], organization: INSPECTION });
const LAB_ORG = {
  id: '5a7c9e1b-3d5f-4a7c-9e1b-3d5f7a9c1e3b',
  name: 'ИЛ «Кубаньтест»',
  type: 'LAB',
  logoUrl: null,
  region: { code: '23', name: 'Краснодарский край' },
};

const decided = (extra: Json = {}): Json => ({ ...(contractExample('getComplaint').body as Json), ...extra });
const fresh = (extra: Json = {}): Json =>
  decided({
    status: 'NEW',
    decision: null,
    decidedAt: null,
    decisionComment: null,
    inspector: null,
    labTestId: null,
    recallId: null,
    ...extra,
  });
const ID = decided().id as string;
const CODE = (decided().batch as Json).publicCode as string;
const listItem = (extra: Json = {}): Json => {
  const c = fresh(extra);
  return Object.fromEntries(
    ['id', 'batch', 'text', 'status', 'decision', 'createdAt', 'decidedAt'].map((k) => [k, c[k]]),
  );
};

async function open(path: string, title: string | RegExp) {
  const utils = await renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return utils;
}
async function openFilters() {
  const toggle = document.querySelector<HTMLElement>('.at-page__filters-toggle');
  if (toggle && !toggle.closest('details')!.open) await userEvent.click(toggle);
}

describe('/complaints', () => {
  it('the list: the batch, the text, status and decision; filters in the URL', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asInspector(),
      contractResponse('listComplaints', {
        body: pageOf([listItem()]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    await open('/complaints', 'Жалобы');
    const link = await screen.findByRole('link', { name: CODE });
    expect(link).toHaveAttribute('href', `/complaints/${ID}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText(/горечь во рту и тошнота/)).toBeInTheDocument();
    expect(within(row).getByText('Новая')).toHaveAttribute('data-tone', 'attention');
    await openFilters();
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'В работе');
    await waitFor(() => expect(seen.at(-1)!.getAll('status')).toEqual(['IN_REVIEW']));
    await userEvent.selectOptions(screen.getByLabelText('Решение'), 'Запустить отзыв');
    await waitFor(() => expect(seen.at(-1)!.getAll('decision')).toEqual(['RECALL']));
    expect(new URLSearchParams(location.search).get('decision')).toBe('RECALL');
  });

  it('an empty list', async () => {
    server.use(asInspector(), contractResponse('listComplaints', { body: pageOf([]) }));
    await open('/complaints', 'Жалобы');
    expect(await screen.findByText('Жалоб пока нет.')).toBeInTheDocument();
  });
});

describe('/complaints/:id', () => {
  it('NEW: the text and contact; «Взять в работу» → IN_REVIEW with the inspector', async () => {
    let reviewed = false;
    server.use(
      asInspector(),
      http.get(`${API_BASE}/complaints/:id`, () =>
        HttpResponse.json(
          reviewed ? fresh({ status: 'IN_REVIEW', inspector: decided().inspector }) : fresh(),
        ),
      ),
      contractResponse('startComplaintReview', {
        body: fresh({ status: 'IN_REVIEW', inspector: decided().inspector }),
        onRequest: () => void (reviewed = true),
      }),
    );
    await open(`/complaints/${ID}`, `Жалоба на партию ${CODE}`);
    expect(screen.getByText(/горечь во рту и тошнота/)).toBeInTheDocument();
    expect(screen.getByText('+79161234567')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Взять в работу' }));
    await waitFor(() => expect(toastText('polite')).toContain('Жалоба взята в работу'));
    expect(screen.getByText('В работе', { selector: '.at-chip' })).toBeInTheDocument();
    expect(screen.getByText('Соколова Анна Викторовна')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Взять в работу' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Отклонить' })).toBeInTheDocument();
  });

  it('REJECT: the comment is required; the body is {decision, comment}', async () => {
    let body: unknown = null;
    server.use(
      asInspector(),
      contractResponse('getComplaint', { body: fresh({ status: 'IN_REVIEW' }) }),
      contractResponse('decideComplaint', {
        body: decided({ decision: 'REJECT', labTestId: null, decisionComment: 'Не связано с качеством' }),
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await open(`/complaints/${ID}`, `Жалоба на партию ${CODE}`);
    await userEvent.click(screen.getByRole('radio', { name: 'Отклонить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Отклонить жалобу' }));
    expect(await screen.findByLabelText('Комментарий')).toHaveAccessibleDescription('Обязательное поле');
    expect(body).toBeNull();
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Не связано с качеством');
    await userEvent.click(screen.getByRole('button', { name: 'Отклонить жалобу' }));
    await waitFor(() => expect(toastText('polite')).toContain('Жалоба отклонена'));
    expect(body).toEqual({ decision: 'REJECT', comment: 'Не связано с качеством' });
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Не связано с качеством')).toBeInTheDocument();
  });

  it('LAB_TEST: a laboratory from the directory is required; the body carries labOrgId', async () => {
    let body: Json | null = null;
    let types: string[] = [];
    server.use(
      asInspector(),
      contractResponse('getComplaint', { body: fresh() }),
      contractResponse('listOrganizations', {
        body: pageOf([LAB_ORG]),
        onRequest: (r) => void (types = new URL(r.url).searchParams.getAll('type')),
      }),
      contractResponse('decideComplaint', { onRequest: async (r) => void (body = (await r.json()) as Json) }),
    );
    await open(`/complaints/${ID}`, `Жалоба на партию ${CODE}`);
    await userEvent.click(screen.getByRole('radio', { name: 'Назначить анализ' }));
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Анализ на пестициды');
    await userEvent.click(screen.getByRole('button', { name: 'Назначить анализ' }));
    expect(await screen.findByRole('combobox', { name: 'Лаборатория' })).toHaveAccessibleDescription(
      'Обязательное поле',
    );
    expect(body).toBeNull();
    await userEvent.type(screen.getByRole('combobox', { name: 'Лаборатория' }), 'ИЛ');
    const list = await screen.findByRole('listbox', { name: 'Лаборатория' });
    await userEvent.click((await within(list).findAllByRole('option'))[0]!);
    expect(types).toEqual(['LAB']);
    await userEvent.click(screen.getByRole('button', { name: 'Назначить анализ' }));
    await waitFor(() => expect(toastText('polite')).toContain(`Анализ партии ${CODE} назначен`));
    expect(body).toEqual({ decision: 'LAB_TEST', comment: 'Анализ на пестициды', labOrgId: LAB_ORG.id });
  });

  it('RECALL: confirmed in a dialog with the batch code; the recall card is linked afterwards', async () => {
    const recallId = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d';
    let body: Json | null = null;
    server.use(
      asInspector(),
      contractResponse('getComplaint', { body: fresh({ status: 'IN_REVIEW' }) }),
      contractResponse('decideComplaint', {
        body: decided({ decision: 'RECALL', labTestId: null, recallId, decisionComment: 'Подтверждено' }),
        onRequest: async (r) => void (body = (await r.json()) as Json),
      }),
    );
    await open(`/complaints/${ID}`, `Жалоба на партию ${CODE}`);
    await userEvent.click(screen.getByRole('radio', { name: 'Запустить отзыв' }));
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Подтверждено');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить отзыв' }));
    const dialog = await screen.findByRole('dialog', { name: `Запустить отзыв партии ${CODE}` });
    const confirm = within(dialog).getByRole('button', { name: 'Запустить отзыв' });
    expect(confirm).toBeDisabled();
    expect(body).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), CODE);
    await userEvent.click(confirm);
    await waitFor(() => expect(toastText('polite')).toContain(`Решение принято: отзыв по партии ${CODE}`));
    expect(body).toEqual({ decision: 'RECALL', comment: 'Подтверждено', blockUpstream: false });
    expect(await screen.findByRole('link', { name: 'Открыть отзыв' })).toHaveAttribute(
      'href',
      `/recalls/${recallId}`,
    );
  });

  it('409 INVALID_TRANSITION (another inspector decided meanwhile): the card is read again and says so', async () => {
    let decidedMeanwhile = false;
    server.use(
      asInspector(),
      http.get(`${API_BASE}/complaints/:id`, () =>
        HttpResponse.json(decidedMeanwhile ? decided() : fresh({ status: 'IN_REVIEW' })),
      ),
      http.post(`${API_BASE}/complaints/:id/decision`, () => {
        decidedMeanwhile = true;
        return HttpResponse.json(
          problem(409, 'INVALID_TRANSITION', { params: { from: 'DECIDED', to: 'DECIDED' } }),
          { status: 409 },
        );
      }),
    );
    await open(`/complaints/${ID}`, `Жалоба на партию ${CODE}`);
    await userEvent.click(screen.getByRole('radio', { name: 'Отклонить' }));
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Нет оснований');
    await userEvent.click(screen.getByRole('button', { name: 'Отклонить жалобу' }));
    await waitFor(() => expect(toastText()).toContain('Жалоба уже в статусе «Решена»: карточка обновлена.'));
    await waitFor(() => expect(screen.queryByRole('radio')).toBeNull());
    expect(screen.getByText('Назначен внеплановый анализ на остаточные пестициды')).toBeInTheDocument();
  });

  it('DECIDED: the decision, the comment, the inspector; a test decision links the tests of the batch', async () => {
    server.use(asInspector(), contractResponse('getComplaint', { body: decided() }));
    await open(`/complaints/${ID}`, `Жалоба на партию ${CODE}`);
    expect(screen.getByText('Решена', { selector: '.at-chip' })).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByText('Назначить анализ')).toBeInTheDocument();
    expect(screen.getByText('Назначен внеплановый анализ на остаточные пестициды')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Анализы партии' })).toHaveAttribute(
      'href',
      `/batches/${(decided().batch as Json).id}?tab=tests`,
    );
    expect(screen.queryByRole('button', { name: 'Взять в работу' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
