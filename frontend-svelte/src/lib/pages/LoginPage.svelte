<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ApiProblem, type LoginResponse } from '@agrotrace/api-client';
  import { formatLocalTime } from '@agrotrace/i18n';
  import { LoginRequestSchema, type LoginRequest } from '@agrotrace/validation';
  import { call } from '../app/api.svelte';
  import { form, SchemaForm } from '../app/forms.svelte';
  import { goto } from '../app/goto';
  import { LOCALE, t } from '../app/i18n';
  import { safeNext, session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';
  import Submit from '../ui/Submit.svelte';
  import AuthLayout from './AuthLayout.svelte';
  import { dropChallenge } from './challenge';
  import { FORM_GRID, LINKS } from './layout';

  onMount(dropChallenge);

  const f = new SchemaForm<LoginRequest>({
    schema: LoginRequestSchema,
    values: { email: '', password: '' },
    fields: ['email', 'password'],
    send: async (body) => {
      try {
        const data = await call<LoginResponse>(session.api.POST('/auth/login', { body }));
        const here = f.alive();
        if (data.twoFactorRequired) {
          if (here) await goto(`/login/2fa${page.url.search}`, { state: { challengeId: data.challengeId } });
          return;
        }
        session.signIn(data);
        if (here) await goto(safeNext(page.url.searchParams.get('next')), { replaceState: true });
      } catch (e) {
        if (!f.alive()) return;
        if (e instanceof ApiProblem && e.code === 'ACCOUNT_LOCKED' && typeof e.params?.lockedUntil === 'string')
          f.alert.show(t('auth.lockedUntil', { time: formatLocalTime(e.params.lockedUntil, LOCALE) }));
        else throw e;
      }
    },
  });
</script>

<AuthLayout title={t('page.login')} furrow art="login">
  <form use:form={f} novalidate style={FORM_GRID}>
    <Field id="email" label={t('field.email')} error={f.error('email')}>
      <Input type="email" autocomplete="username" name="email" bind:value={f.values.email} />
    </Field>
    <Field id="password" label={t('field.password')} error={f.error('password')}>
      <Input type="password" autocomplete="current-password" name="password" bind:value={f.values.password} />
    </Field>
    <Submit form={f}>{t('action.login')}</Submit>
    <div style={LINKS}>
      <Button variant="ghost" size="s" href="/password/forgot">{t('auth.forgot')}</Button>
      <Button variant="ghost" size="s" href="/register">{t('auth.register')}</Button>
    </div>
  </form>
</AuthLayout>
