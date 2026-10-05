<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ApiProblem, type LoginSuccess } from '@agrotrace/api-client';
  import { TwoFactorVerifyRequestSchema, type TwoFactorVerifyRequest } from '@agrotrace/validation';
  import { call } from '../app/api.svelte';
  import { form, SchemaForm } from '../app/forms.svelte';
  import { goto } from '../app/goto';
  import { t } from '../app/i18n';
  import { safeNext, session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';
  import Submit from '../ui/Submit.svelte';
  import { toasts } from '../ui/toast-store.svelte';
  import AuthLayout from './AuthLayout.svelte';
  import { dropChallenge, keepChallenge, storedChallenge } from './challenge';
  import { FORM_GRID, LINKS } from './layout';

  const challengeId = page.state.challengeId ?? storedChallenge();
  const valid = typeof challengeId === 'string';

  onMount(() => {
    if (typeof challengeId === 'string') keepChallenge(challengeId);
    else void goto(`/login${page.url.search}`, { replaceState: true });
  });

  const isProblem = (e: unknown, code: string): e is ApiProblem => e instanceof ApiProblem && e.code === code;

  async function restart() {
    dropChallenge();
    toasts.push({ tone: 'danger', text: t('auth.challengeExpired') });
    await goto(`/login${page.url.search}`, { replaceState: true });
  }

  const f = new SchemaForm<TwoFactorVerifyRequest>({
    schema: TwoFactorVerifyRequestSchema,
    values: { challengeId: valid ? challengeId : '', code: '' },
    fields: ['code'],
    send: async (body) => {
      try {
        const data = await call<LoginSuccess>(session.api.POST('/auth/2fa/verify', { body }));
        const here = f.alive();
        dropChallenge();
        session.signIn(data);
        if (here) await goto(safeNext(page.url.searchParams.get('next')), { replaceState: true });
      } catch (e) {
        if (!f.alive()) return;
        if (isProblem(e, 'INVALID_TWO_FACTOR_CODE')) {
          const left = Number(e.params?.attemptsLeft);
          if (left > 0) f.setError('code', t('auth.attemptsLeft', { count: left }));
          else await restart();
        } else if (isProblem(e, 'TOKEN_EXPIRED') || (e instanceof ApiProblem && e.errors?.challengeId))
          await restart();
        else throw e;
      }
    },
  });
</script>

{#if valid}
  <AuthLayout title={t('page.twoFactor')}>
    <form use:form={f} novalidate style={FORM_GRID}>
      <Field id="code" label={t('auth.totpCode')} error={f.error('code')}>
        <Input
          mono
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength={6}
          name="code"
          bind:value={f.values.code}
        />
      </Field>
      <Submit form={f}>{t('auth.confirm')}</Submit>
      <div style={LINKS}>
        <Button variant="ghost" size="s" href="/login{page.url.search}">{t('auth.toLogin')}</Button>
      </div>
    </form>
  </AuthLayout>
{/if}
