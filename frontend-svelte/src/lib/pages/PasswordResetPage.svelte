<script lang="ts">
  import { page } from '$app/state';
  import { ResetPasswordRequestSchema, type ResetPasswordRequest } from '@agrotrace/validation';
  import { call } from '../app/api.svelte';
  import { form, SchemaForm } from '../app/forms.svelte';
  import { goto } from '../app/goto';
  import { t } from '../app/i18n';
  import { session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';
  import Submit from '../ui/Submit.svelte';
  import { toasts } from '../ui/toast-store.svelte';
  import AuthLayout from './AuthLayout.svelte';
  import { FORM_GRID } from './layout';
  import Outcome from './Outcome.svelte';
  import { deadToken, tokenLooksValid } from './tokens';

  const token = page.params.token;
  let dead = $state(!tokenLooksValid(token));

  const f = new SchemaForm<ResetPasswordRequest>({
    schema: ResetPasswordRequestSchema,
    values: { token: token ?? '', password: '' },
    fields: ['password'],
    send: async (body) => {
      try {
        await call(session.api.POST('/auth/password/reset', { body }));
      } catch (e) {
        if (!deadToken(e)) throw e;
        dead = true;
        return;
      }
      toasts.push({ tone: 'ok', text: t('auth.resetDone') });
      if (f.alive()) await goto('/login', { replaceState: true });
    },
  });
</script>

<AuthLayout title={t('page.passwordReset')}>
  {#if dead}
    <Outcome text={t('auth.resetExpired')}>
      {#snippet action()}<Button href="/password/forgot">{t('auth.requestNewLink')}</Button>{/snippet}
    </Outcome>
  {:else}
    <form use:form={f} novalidate style={FORM_GRID}>
      <Field id="password" label={t('auth.newPassword')} error={f.error('password')}>
        <Input type="password" autocomplete="new-password" name="password" bind:value={f.values.password} />
      </Field>
      <Submit form={f}>{t('auth.setPassword')}</Submit>
    </form>
  {/if}
</AuthLayout>
