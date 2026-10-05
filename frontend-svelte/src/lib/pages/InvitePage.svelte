<script lang="ts">
  import { page } from '$app/state';
  import { AcceptInviteRequestSchema, type AcceptInviteRequest } from '@agrotrace/validation';
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

  const f = new SchemaForm<AcceptInviteRequest>({
    schema: AcceptInviteRequestSchema,
    values: { token: token ?? '', fullName: '', password: '' },
    fields: ['fullName', 'password'],
    send: async (body) => {
      try {
        await call(session.api.POST('/auth/accept-invite', { body }));
      } catch (e) {
        if (!deadToken(e)) throw e;
        dead = true;
        return;
      }
      toasts.push({ tone: 'ok', text: t('auth.inviteDone') });
      if (f.alive()) await goto('/login', { replaceState: true });
    },
  });

  const here = `/invite/${token ?? ''}`;
</script>

<AuthLayout title={t('page.invite')}>
  {#if session.status === 'authenticated' && session.me}
    <Outcome text={t('auth.inviteSignedIn', { name: session.me.fullName })}>
      {#snippet action()}
        <Button variant="primary" icon="logout" onclick={() => void session.signOut(here)}>{t('action.logout')}</Button>
      {/snippet}
    </Outcome>
  {:else if dead}
    <Outcome text={t('auth.inviteExpired')}>
      {#snippet action()}<Button href="/login">{t('auth.toLogin')}</Button>{/snippet}
    </Outcome>
  {:else}
    <form use:form={f} novalidate style={FORM_GRID}>
      <Field id="fullName" label={t('field.fullName')} error={f.error('fullName')}>
        <Input autocomplete="name" name="fullName" bind:value={f.values.fullName} />
      </Field>
      <Field id="password" label={t('field.password')} error={f.error('password')}>
        <Input type="password" autocomplete="new-password" name="password" bind:value={f.values.password} />
      </Field>
      <Submit form={f}>{t('auth.acceptInvite')}</Submit>
    </form>
  {/if}
</AuthLayout>
