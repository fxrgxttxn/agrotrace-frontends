<script lang="ts">
  import { ForgotPasswordRequestSchema, type ForgotPasswordRequest } from '@agrotrace/validation';
  import { call } from '../app/api.svelte';
  import { form, SchemaForm } from '../app/forms.svelte';
  import { t } from '../app/i18n';
  import { session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';
  import Submit from '../ui/Submit.svelte';
  import AuthLayout from './AuthLayout.svelte';
  import { FORM_GRID, LINKS } from './layout';
  import Outcome from './Outcome.svelte';

  let sentTo = $state<string | null>(null);

  const f = new SchemaForm<ForgotPasswordRequest>({
    schema: ForgotPasswordRequestSchema,
    values: { email: '' },
    fields: ['email'],
    send: async (body) => {
      await call(session.api.POST('/auth/password/forgot', { body }));
      sentTo = body.email;
    },
  });
</script>

<AuthLayout title={t('page.passwordForgot')}>
  {#if sentTo !== null}
    <Outcome text={t('auth.forgotSent', { email: sentTo })}>
      {#snippet action()}<Button href="/login">{t('auth.toLogin')}</Button>{/snippet}
    </Outcome>
  {:else}
    <form use:form={f} novalidate style={FORM_GRID}>
      <Field id="email" label={t('field.email')} error={f.error('email')}>
        <Input type="email" autocomplete="email" name="email" bind:value={f.values.email} />
      </Field>
      <Submit form={f}>{t('auth.sendLink')}</Submit>
      <div style={LINKS}>
        <Button variant="ghost" size="s" href="/login">{t('auth.toLogin')}</Button>
      </div>
    </form>
  {/if}
</AuthLayout>
