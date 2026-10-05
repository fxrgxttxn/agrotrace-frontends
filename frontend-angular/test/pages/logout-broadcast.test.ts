import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractResponse } from '../msw/fromContract';
import { renderApp } from '../app/renderApp';
import { SESSION_CHANNEL } from '../../src/app/session';

const TOKEN = 'k3Jp9_Qw8Zr2Xy7Lm4Nb6Vc1Hd5Tf0Gs-Ae3Rt8Yu';

function otherTab(channel: string, message: unknown): void {
  const ch = new BroadcastChannel(channel);
  ch.postMessage(message);
  ch.close();
}

describe('another tab’s logout', () => {
  it('an anonymous invite form survives another tab’s token broadcast followed by its logout', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    const { url } = renderApp(`/invite/${TOKEN}`);
    await screen.findByRole('heading', { level: 1, name: 'Приглашение' });
    await userEvent.type(screen.getByLabelText('ФИО'), 'Иван Недописанный');
    otherTab('agrotrace-auth', { token: 'token-of-another-tab' });
    await new Promise((r) => setTimeout(r, 100));
    otherTab(SESSION_CHANNEL, { type: 'logout' });
    await new Promise((r) => setTimeout(r, 400));
    expect(url()).toBe(`/invite/${TOKEN}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Приглашение' })).toBeInTheDocument();
    expect(screen.getByLabelText('ФИО')).toHaveValue('Иван Недописанный');
  });
});
