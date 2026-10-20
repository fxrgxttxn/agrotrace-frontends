import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractResponse } from '../msw/fromContract';
import { renderApp } from '../app/renderApp';
import { SESSION_CHANNEL } from '../../src/app/session';

// Ruling FM32, screen-driven: another tab signs in (its refreshed token is broadcast to every tab, this anonymous one
// included) and then logs out — this anonymous tab keeps its screen and what was typed into it.

const TOKEN = 'k3Jp9_Qw8Zr2Xy7Lm4Nb6Vc1Hd5Tf0Gs-Ae3Rt8Yu';

function otherTab(channel: string, message: unknown): void {
  const ch = new BroadcastChannel(channel);
  ch.postMessage(message);
  ch.close();
}

describe('FM32', () => {
  it('an anonymous invite form survives another tab’s token broadcast followed by its logout', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    const { url } = renderApp(`/invite/${TOKEN}`);
    await screen.findByRole('heading', { level: 1, name: 'Приглашение' });
    await userEvent.type(screen.getByLabelText('ФИО'), 'Иван Недописанный');
    // another tab signs in: api-client broadcasts its access token to all tabs
    otherTab('agrotrace-auth', { token: 'token-of-another-tab' });
    await new Promise((r) => setTimeout(r, 100));
    // …and logs out
    otherTab(SESSION_CHANNEL, { type: 'logout' });
    await new Promise((r) => setTimeout(r, 400));
    expect(url()).toBe(`/invite/${TOKEN}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Приглашение' })).toBeInTheDocument();
    expect(screen.getByLabelText('ФИО')).toHaveValue('Иван Недописанный');
  });
});
