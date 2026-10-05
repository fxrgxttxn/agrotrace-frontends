import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse, type Json } from '../msw/fromContract';
import { problem } from '../msw/data';
import { PublicApp } from '../../src/public/PublicApp';
import { clearBatchCache } from '../../src/public/data';
import { earlyBatchUrl, startEarly } from '../../src/early';
import { challengeFor, installWorker } from './worker';

const SAFE = contractExample('getPublicBatch').body as Json;
const RECALLED = contractExample('getPublicBatch', 200, 'recalled').body as Json;
const CODE = SAFE.publicCode as string;

function open(path: string) {
  window.history.replaceState(null, '', path);
  return render(<PublicApp />);
}

const batchAnswer = (body: Json) => contractResponse('getPublicBatch', { body });
const h1 = () => screen.getByRole('heading', { level: 1 });

beforeEach(() => {
  installWorker();
  server.use(contractResponse('getCaptchaChallenge', { body: challengeFor(321, 2000) as unknown as Json }));
});
afterEach(() => {
  clearBatchCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('/p/:publicCode', () => {
  it('a batch on sale: product, large safety status, origin with the logo, path as steps, lab summary', async () => {
    open(`/p/${CODE}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Пшеница озимая' })).toBeInTheDocument();
    expect(document.title).toBe('Пшеница озимая — AgroTrace');
    const status = document.querySelector('.at-public__status')!;
    expect(status).toHaveAttribute('data-safety', 'SAFE');
    expect(status).toHaveTextContent('Безопасна');
    expect(document.querySelector('.at-card[data-furrow]')).toContainElement(status as HTMLElement);
    expect(screen.queryByRole('heading', { name: 'Партия отозвана' })).toBeNull();
    expect(screen.getByText(CODE)).toHaveClass('at-mono');
    const photo = document.querySelector<HTMLImageElement>('.at-public__photo img')!;
    expect(photo.getAttribute('src')).toBe(
      '/api/v1/public/files/2d4f6a8c-0e1a-4b3c-8d5e-7f9a1b3c5d7e?variant=480',
    );
    expect(photo).toHaveAttribute('alt', '');
    expect(document.querySelector('figcaption')).toBeNull();

    const origin = screen.getByRole('heading', { level: 2, name: 'Происхождение' }).closest('article')!;
    expect(within(origin).getByText('КФХ Петров')).toBeInTheDocument();
    expect(within(origin).getByText('Хозяйство')).toBeInTheDocument();
    expect(origin.querySelector('.at-avatar img')).toHaveAttribute(
      'src',
      '/api/v1/public/files/8e4a1c2b-7d3f-4a6e-b5c9-2f1e0d9c8b7a?variant=96',
    );
    expect(within(origin).getByText('Краснодарский край')).toBeInTheDocument();
    expect(within(origin).getByText('Дата уборки')).toBeInTheDocument();
    expect(within(origin).getByText('18.07.2026')).toBeInTheDocument();

    const path = screen.getByRole('heading', { level: 2, name: 'Путь продукта' }).closest('article')!;
    const steps = path.querySelectorAll('.at-timeline__item');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent('18.07.2026 — 20.08.2026КФХ ПетровХозяйство');
    expect(steps[1]).toHaveAttribute('data-current', '');
    expect(steps[1]).toHaveTextContent('с 20.08.2026ООО «Кубань-Маркет»ОКПродавец');
    expect(steps[1]!.querySelector('.at-avatar')).toHaveAttribute('aria-hidden', 'true');

    const lab = screen.getByRole('heading', { level: 2, name: 'Анализы' }).closest('article')!;
    expect(lab).toHaveTextContent(
      'Проведено1Соответствуют нормативам1Последний анализ25.07.2026Соответствует нормативам',
    );
    expect(lab.querySelector('.at-chip')).toHaveAttribute('data-tone', 'ok');

    expect(screen.getByRole('link', { name: 'Сообщить о проблеме' })).toHaveAttribute(
      'href',
      `/p/${CODE}/complaint`,
    );
    expect([...document.querySelectorAll('h1, h2')].map((h) => h.tagName)).toEqual(['H1', 'H2', 'H2', 'H2']);
  });

  it('a seed photo carries its author and license, found by its file id (R76 note)', async () => {
    const imageUrl = '/api/v1/public/files/2ca5ff5f-47ee-5d20-bb8a-e6a99787c85f';
    server.use(
      batchAnswer({ ...SAFE, product: { ...(SAFE.product as Json), name: 'Пшеница озимая', imageUrl } }),
    );
    open(`/p/${CODE}`);
    await waitFor(() => expect(document.querySelector('figcaption')).not.toBeNull());
    const caption = document.querySelector('figcaption')!;
    expect(caption).toHaveTextContent('Фото: Raman Deep, CC BY-SA 4.0');
    expect(within(caption).getByRole('link', { name: 'Raman Deep' })).toHaveAttribute(
      'href',
      'https://commons.wikimedia.org/wiki/File:Grains_of_wheat_01.jpg',
    );
    expect(within(caption).getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0',
    );
  });

  it('a recalled batch: the large warning with its illustration and «do not consume» first (FR-PUB-02)', async () => {
    server.use(batchAnswer(RECALLED));
    open('/p/AT-2026-000457');
    const warning = await screen.findByRole('heading', { level: 2, name: 'Партия отозвана' });
    const block = warning.closest('.at-public__warning')!;
    expect(block.querySelector('svg.at-empty__art[aria-hidden="true"]')).not.toBeNull();
    expect(block).toHaveTextContent('Не употребляйте продукт из этой партии.');
    expect(document.querySelector('.at-public__status')).toHaveAttribute('data-safety', 'RECALLED');
    expect(document.querySelector('.at-public__status')).toHaveTextContent('Отозвана');
    expect(document.querySelector('.at-public__photo')).toBeNull();
    expect(screen.getByText('Дата производства')).toBeInTheDocument();
    expect(screen.getByText('Производитель')).toBeInTheDocument();
    expect(screen.queryByText('Дата уборки')).toBeNull();
    const lab = screen.getByRole('heading', { level: 2, name: 'Анализы' }).closest('article')!;
    expect(lab.querySelector('.at-chip')).toHaveAttribute('data-tone', 'danger');
    expect(lab).toHaveTextContent('Превышение нормативов');
    expect(block.compareDocumentPosition(document.querySelector('.at-public__status')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it.each([
    ['BLOCKED', 'Blocked', 'Заблокирована', 'Продажа партии остановлена до решения инспектора.'],
    ['UNKNOWN', 'OnTest', 'Нет данных', 'Партия ещё проходит проверку.'],
  ])('safety %s: the status and its one-line note', async (safety, status, label, note) => {
    server.use(batchAnswer({ ...SAFE, safety, status }));
    open(`/p/${CODE}`);
    await screen.findByText(note);
    expect(document.querySelector('.at-public__status')).toHaveAttribute('data-safety', safety);
    expect(document.querySelector('.at-public__status')).toHaveTextContent(label);
  });

  it('no lab tests yet: one line instead of the summary', async () => {
    server.use(
      batchAnswer({ ...SAFE, labSummary: { total: 0, passed: 0, lastConclusion: null, lastDate: null } }),
    );
    open(`/p/${CODE}`);
    expect(await screen.findByText('Анализы не проводились.')).toBeInTheDocument();
  });

  it('an unknown code (404) and a malformed one (no request) are «not found»', async () => {
    server.use(contractResponse('getPublicBatch', { status: 404 }));
    const view = open(`/p/${CODE}`);
    expect(await screen.findByText('Партия с таким кодом не найдена.')).toBeInTheDocument();
    expect(h1()).toHaveTextContent('Партия');
    view.unmount();
    const asked = vi.fn();
    server.use(contractResponse('getPublicBatch', { onRequest: asked }));
    open('/p/not-a-code');
    expect(await screen.findByText('Партия с таким кодом не найдена.')).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });

  it('the service down: what happened and «Повторить», which asks again', async () => {
    server.use(
      http.get(
        `${API_BASE}/public/batches/:code`,
        () => HttpResponse.json(problem(503, 'BACKEND_UNAVAILABLE'), { status: 503 }),
        { once: true },
      ),
    );
    open(`/p/${CODE}`);
    expect(await screen.findByText('Сервис временно недоступен.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Пшеница озимая' })).toBeInTheDocument();
  });

  it('no network: says so; a 429 waits out Retry-After on «Повторить», then gives it the focus', async () => {
    server.use(http.get(`${API_BASE}/public/batches/:code`, () => HttpResponse.error(), { once: true }));
    const view = open(`/p/${CODE}`);
    expect(await screen.findByText('Нет связи с сервером — проверьте подключение.')).toBeInTheDocument();
    view.unmount();
    clearBatchCache();
    server.use(
      http.get(
        `${API_BASE}/public/batches/:code`,
        () =>
          HttpResponse.json(problem(429, 'RATE_LIMITED'), { status: 429, headers: { 'Retry-After': '2' } }),
        { once: true },
      ),
    );
    open(`/p/${CODE}`);
    const wait = await screen.findByRole('button', { name: 'Повторить через 2 с' });
    expect(wait).toBeDisabled();
    expect(screen.getByText('Слишком много запросов — попробуйте позже')).toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: 'Повторить' }, { timeout: 4000 });
    expect(retry).toBeEnabled();
    expect(retry).toHaveFocus();
  });
});

describe('the batch request started by the entry', () => {
  it('is the one the page uses: one request for the page', async () => {
    const asked = vi.fn();
    server.use(contractResponse('getPublicBatch', { onRequest: asked }));
    window.history.replaceState(null, '', `/p/${CODE}`);
    startEarly(earlyBatchUrl(window.location.pathname, window.location.origin)!);
    render(<PublicApp />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Пшеница озимая' })).toBeInTheDocument();
    expect(asked).toHaveBeenCalledTimes(1);
  });
});

describe('between the two routes', () => {
  it('«Сообщить о проблеме» opens the form on the client; Back returns; the title takes the focus (F4)', async () => {
    const asked = vi.fn();
    server.use(contractResponse('getPublicBatch', { onRequest: asked }));
    open(`/p/${CODE}`);
    await userEvent.click(await screen.findByRole('link', { name: 'Сообщить о проблеме' }));
    expect(window.location.pathname).toBe(`/p/${CODE}/complaint`);
    expect(h1()).toHaveTextContent('Сообщить о проблеме');
    expect(h1()).toHaveFocus();
    expect(document.title).toBe('Сообщить о проблеме — AgroTrace');
    expect(await screen.findByText(CODE)).toBeInTheDocument();
    act(() => window.history.back());
    expect(await screen.findByRole('heading', { level: 1, name: 'Пшеница озимая' })).toHaveFocus();
    expect(asked).toHaveBeenCalledTimes(1);
  });
});

describe('/p/:publicCode/complaint', () => {
  const sent: Json[] = [];
  beforeEach(() => {
    sent.length = 0;
    server.use(
      contractResponse('createPublicComplaint', { onRequest: async (r) => void sent.push(await r.json()) }),
    );
  });

  const fill = async (text: string, contact = '') => {
    await userEvent.type(await screen.findByLabelText('Что случилось'), text);
    if (contact)
      await userEvent.type(screen.getByLabelText('Телефон или email для ответа (необязательно)'), contact);
  };
  const send = () => userEvent.click(screen.getByRole('button', { name: 'Отправить жалобу' }));

  it('checks the text first (README field errors, focus on the field)', async () => {
    open(`/p/${CODE}/complaint`);
    await send();
    const text = screen.getByLabelText('Что случилось');
    expect(text).toHaveFocus();
    expect(text).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById('complaint-text-error')).toHaveTextContent('Обязательное поле');
    await userEvent.type(text, 'Горько');
    await send();
    expect(document.getElementById('complaint-text-error')).toHaveTextContent(
      'Опишите подробнее — не короче 10 символов',
    );
    await userEvent.type(text, ' и пахнет');
    await userEvent.type(screen.getByLabelText('Телефон или email для ответа (необязательно)'), '   ');
    await send();
    expect(document.getElementById('complaint-contact-error')).toHaveTextContent('Недопустимый формат');
    expect(sent).toHaveLength(0);
  });

  it('sends what was typed with the solved ALTCHA payload; the confirmation takes the focus', async () => {
    open(`/p/${CODE}/complaint`);
    await fill('  Горечь во рту после каши ', '+7 000 000-00-00');
    await send();
    const done = await screen.findByText('Жалоба отправлена.');
    expect(done).toHaveFocus();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: '  Горечь во рту после каши ', contact: '+7 000 000-00-00' });
    const altcha = JSON.parse(atob(sent[0]!.altcha as string));
    expect(altcha).toMatchObject({ algorithm: 'SHA-256', number: 321, salt: 'abc123?expires=4102444800' });
    expect(screen.getByRole('link', { name: 'К партии' })).toHaveAttribute('href', `/p/${CODE}`);
  });

  it('the contact is a phone or an e-mail: no single autofill purpose is claimed', () => {
    open(`/p/${CODE}/complaint`);
    expect(screen.getByLabelText('Телефон или email для ответа (необязательно)')).toHaveAttribute(
      'autocomplete',
      'on',
    );
  });

  it('an empty contact is not sent', async () => {
    open(`/p/${CODE}/complaint`);
    await fill('Горечь во рту после каши');
    await send();
    await screen.findByText('Жалоба отправлена.');
    expect(sent[0]).not.toHaveProperty('contact');
  });

  it('CAPTCHA_FAILED: says so, keeps the text, asks for a fresh challenge for the next submit', async () => {
    const challenges = vi.fn();
    server.use(
      contractResponse('getCaptchaChallenge', {
        body: challengeFor(17, 500) as unknown as Json,
        onRequest: challenges,
      }),
      contractResponse('createPublicComplaint', { status: 400, example: 'captcha', once: true }),
    );
    open(`/p/${CODE}/complaint`);
    await fill('Горечь во рту после каши');
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Проверка защиты от спама не прошла — отправьте ещё раз',
    );
    expect(screen.getByLabelText('Что случилось')).toHaveValue('Горечь во рту после каши');
    await waitFor(() => expect(challenges).toHaveBeenCalledTimes(2));
    await send();
    expect(await screen.findByText('Жалоба отправлена.')).toBeInTheDocument();
  });

  it('a server field error lands on its field', async () => {
    server.use(contractResponse('createPublicComplaint', { status: 400, example: 'validation', once: true }));
    open(`/p/${CODE}/complaint`);
    await fill('Горечь во рту после каши');
    await send();
    expect(await screen.findByText('Слишком короткое значение')).toHaveAttribute(
      'id',
      'complaint-text-error',
    );
    expect(screen.getByLabelText('Что случилось')).toHaveFocus();
  });

  it('the complaint-ip limit: the submit waits out Retry-After; the focus comes back only if idle', async () => {
    server.use(
      contractResponse('createPublicComplaint', { status: 429, headers: { 'Retry-After': '2' }, once: true }),
    );
    open(`/p/${CODE}/complaint`);
    await fill('Горечь во рту после каши');
    await send();
    const wait = await screen.findByRole('button', { name: 'Повторить через 2 с' });
    expect(wait).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Слишком много попыток — повторите через 2 с');
    expect(screen.getByRole('alert')).toHaveClass('at-field__warning');
    screen.getByLabelText('Что случилось').focus();
    const submit = await screen.findByRole('button', { name: 'Отправить жалобу' }, { timeout: 4000 });
    expect(submit).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Что случилось')).toHaveFocus();
    await send();
    expect(await screen.findByText('Жалоба отправлена.')).toBeInTheDocument();
  });

  it('the anti-spam check cannot be prepared (challenge or worker fails): says so, nothing is sent', async () => {
    server.use(
      http.get(`${API_BASE}/public/captcha`, () =>
        HttpResponse.json(problem(503, 'BACKEND_UNAVAILABLE'), { status: 503 }),
      ),
    );
    open(`/p/${CODE}/complaint`);
    await fill('Горечь во рту после каши');
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось подготовить проверку защиты от спама — отправьте ещё раз',
    );
    expect(sent).toHaveLength(0);
    server.use(contractResponse('getCaptchaChallenge', { body: challengeFor(1) as unknown as Json }));
    installWorker('fail');
    await send();
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(sent).toHaveLength(0);
  });

  it('no network on submit: says so and keeps what was typed; a vanished batch (404) is «not found»', async () => {
    server.use(
      http.post(`${API_BASE}/public/batches/:code/complaints`, () => HttpResponse.error(), { once: true }),
    );
    const view = open(`/p/${CODE}/complaint`);
    await fill('Горечь во рту после каши');
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Нет связи с сервером — проверьте подключение.',
    );
    expect(screen.getByLabelText('Что случилось')).toHaveValue('Горечь во рту после каши');
    view.unmount();
    server.use(contractResponse('createPublicComplaint', { status: 404, once: true }));
    open(`/p/${CODE}/complaint`);
    await fill('Горечь во рту после каши');
    await send();
    expect(await screen.findByText('Партия с таким кодом не найдена.')).toBeInTheDocument();
  });

  it('the submit is busy while the challenge is solved and sent', async () => {
    let release: () => void = () => {};
    server.use(
      contractResponse('createPublicComplaint', {
        onRequest: () => new Promise<void>((r) => (release = r)),
        once: true,
      }),
    );
    open(`/p/${CODE}/complaint`);
    await fill('Горечь во рту после каши');
    await send();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Отправить жалобу' })).toHaveAttribute('aria-busy', 'true'),
    );
    release();
    expect(await screen.findByText('Жалоба отправлена.')).toBeInTheDocument();
  });
});
