import { expect, test } from '@playwright/test';
import { stand } from './stand';

const PENDING = {
  totpEnabled: false,
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUrl: 'otpauth://totp/AgroTrace:a?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=AgroTrace',
};

for (const delay of [0, 300, 1500])
  for (const how of ['click', 'enter'] as const)
    test(`2FA «Настроить» (${how}, answer after ${delay} ms): the code field has the focus`, async ({
      page,
    }) => {
      await stand(page, {
        getMe: (_u: URL, example: unknown) => ({
          ...(example as Record<string, unknown>),
          roles: ['ADMIN'],
          totpEnabled: false,
        }),
      });
      await page.route('**/api/v1/auth/2fa/setup', async (route) => {
        await new Promise((r) => setTimeout(r, delay));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PENDING) });
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('/profile');
      await expect(page.getByRole('heading', { level: 1, name: 'Профиль' })).toBeVisible();
      const setup = page.getByRole('button', { name: 'Настроить', exact: true });
      if (how === 'click') await setup.click();
      else {
        await setup.focus();
        await page.keyboard.press('Enter');
      }
      await expect(page.locator('#totp-code')).toBeFocused({ timeout: delay + 3000 });
      await page.waitForTimeout(300);
      await expect(page.locator('#totp-code')).toBeFocused();
    });
