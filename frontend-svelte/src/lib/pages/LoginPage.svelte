<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ApiProblem, type LoginResponse } from '@agrotrace/api-client';
  import { formatLocalTime } from '@agrotrace/i18n';
  import { LoginRequestSchema, type LoginRequest } from '@agrotrace/validation';
  import { call } from '../app/api.svelte';
  import { SchemaForm } from '../app/forms.svelte';
  import { LOCALE, t } from '../app/i18n';
  import { safeNext, session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';
  import AuthLayout from './AuthLayout.svelte';

  /** `/login` — email and password; TOTP users continue on `/login/2fa`. Sends exactly what was typed (R36). */
  const form = new SchemaForm<LoginRequest>(LoginRequestSchema, { email: '', password: '' }, ['email', 'password']);
  onDestroy(() => form.alert.clear());

  const submit = form.submit(async (body) => {
    try {
      const data = await call<LoginResponse>(session.api.POST('/auth/login', { body }));
      if (data.twoFactorRequired) {
        await goto(`/login/2fa${page.url.search}`, { state: { challengeId: data.challengeId } });
        return;
      }
      session.signIn(data);
      await goto(safeNext(page.url.searchParams.get('next')), { replaceState: true });
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'ACCOUNT_LOCKED' && typeof e.params?.lockedUntil === 'string')
        form.alert.show(t('auth.lockedUntil', { time: formatLocalTime(e.params.lockedUntil, LOCALE) }));
      else throw e;
    }
  });
</script>

<AuthLayout title={t('page.login')} furrow art="login">
  <form novalidate onsubmit={submit} style="display: grid; gap: var(--sp-4)">
    <Field id="email" label={t('field.email')} error={form.error('email')}>
      <Input type="email" autocomplete="username" name="email" bind:value={form.values.email} />
    </Field>
    <Field id="password" label={t('field.password')} error={form.error('password')}>
      <Input type="password" autocomplete="current-password" name="password" bind:value={form.values.password} />
    </Field>
    <Button type="submit" variant="primary" busy={form.busy} disabled={form.wait.left > 0}
      >{form.wait.left > 0 ? t('auth.retryIn', { seconds: form.wait.left }) : t('action.login')}</Button
    >
    <div style="display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: space-between">
      <Button variant="ghost" size="s" href="/password/forgot">{t('auth.forgot')}</Button>
      <Button variant="ghost" size="s" href="/register">{t('auth.register')}</Button>
    </div>
  </form>
</AuthLayout>
