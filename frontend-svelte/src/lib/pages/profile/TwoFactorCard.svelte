<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ApiProblem, type Me, type TwoFactorSetupResponse } from '@agrotrace/api-client';
  import { TwoFactorSetupRequestSchema, type TwoFactorSetupRequest } from '@agrotrace/validation';
  import { call, Countdown, errorText, errorTone, focusAfterWait, restoreFocus, retryAfterOf } from '../../app/api.svelte';
  import { form, SchemaForm } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';
  import Qr from '../../ui/Qr.svelte';
  import Submit from '../../ui/Submit.svelte';
  import { toasts } from '../../ui/toast-store.svelte';
  import { FORM_GRID } from '../layout';

  /** Two-factor setup (INSPECTOR, ADMIN; FR-IAM-07): «Настроить» → the secret (grouped by 4) and a QR code of the
   * otpauth URI → confirm with a code → on. A 409 (already on, e.g. in another tab) reloads the profile. */
  let { me }: { me: Me } = $props();

  let pending = $state<{ secret: string; otpauthUrl: string } | null>(null);
  let starting = $state(false);
  // A 429 on the start step waits on its own button.
  const startWait = new Countdown();
  onDestroy(() => startWait.stop());
  let startButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => startWait.left,
    () => startButton,
  );

  /** Secret in groups of four for manual entry. */
  const groupSecret = (s: string) => s.replace(/(.{4})(?=.)/g, '$1 ');

  async function alreadyOn() {
    pending = null;
    await session.reloadMe();
  }

  const f = new SchemaForm<TwoFactorSetupRequest>({
    schema: TwoFactorSetupRequestSchema,
    values: { code: '' },
    fields: ['code'],
    send: async (body) => {
      try {
        await call<TwoFactorSetupResponse>(session.api.POST('/auth/2fa/setup', { body }));
      } catch (e) {
        if (e instanceof ApiProblem && e.code === 'INVALID_TWO_FACTOR_CODE')
          f.setError('code', 'errors.INVALID_TWO_FACTOR_CODE');
        else if (e instanceof ApiProblem && e.status === 409) {
          await alreadyOn();
          void restoreFocus(null);
        } else throw e;
        return;
      }
      pending = null;
      f.reset({ code: '' });
      await session.reloadMe();
      toasts.push({ tone: 'ok', text: t('profile.twoFactorEnabled') });
      void restoreFocus(null);
    },
  });

  async function start(e: MouseEvent) {
    const opener = e.currentTarget as HTMLElement;
    f.alert.clear();
    starting = true;
    try {
      const res = await call<TwoFactorSetupResponse>(session.api.POST('/auth/2fa/setup', { body: {} }));
      if ('secret' in res && res.secret && res.otpauthUrl) pending = { secret: res.secret, otpauthUrl: res.otpauthUrl };
      else await alreadyOn();
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 409) await alreadyOn();
      else {
        if (err instanceof ApiProblem && err.status === 429) startWait.start(retryAfterOf(err));
        f.alert.show(errorText(err), errorTone(err));
      }
    } finally {
      starting = false;
    }
    void restoreFocus(opener);
  }

  function cancel() {
    pending = null;
    f.reset({ code: '' });
    void restoreFocus(null);
  }
</script>

{#snippet secret()}<span class="at-mono">{groupSecret(pending?.secret ?? '')}</span>{/snippet}

<Card>
  <CardHeader title={t('profile.twoFactor')}>
    <Chip tone={me.totpEnabled ? 'ok' : 'neutral'}
      >{t(me.totpEnabled ? 'profile.twoFactorOn' : 'profile.twoFactorOff')}</Chip
    >
  </CardHeader>
  {#if !me.totpEnabled && !pending}
    <CardFooter>
      <Button bind:element={startButton} busy={starting} disabled={startWait.left > 0} onclick={(e: MouseEvent) => void start(e)}
        >{startWait.left > 0 ? t('auth.retryIn', { seconds: startWait.left }) : t('profile.setup')}</Button
      >
    </CardFooter>
  {/if}
  {#if !me.totpEnabled && pending}
    <form use:form={f} novalidate>
      <CardBody>
        <div style={FORM_GRID}>
          <Qr value={pending.otpauthUrl} label={t('profile.qr')} />
          <CardFacts facts={[{ key: 'secret', term: t('profile.secret'), value: secret }]} />
          <Field id="totp-code" label={t('auth.totpCode')} error={f.error('code')}>
            <Input
              mono
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength={6}
              name="code"
              bind:value={f.values.code}
            />
          </Field>
        </div>
      </CardBody>
      <CardFooter>
        <Submit form={f}>{t('profile.enable')}</Submit>
        <Button variant="ghost" onclick={cancel}>{t('action.cancel')}</Button>
      </CardFooter>
    </form>
  {/if}
</Card>
