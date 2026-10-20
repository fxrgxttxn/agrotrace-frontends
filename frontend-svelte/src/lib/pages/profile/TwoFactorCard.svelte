<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { ApiProblem, type Me, type TwoFactorSetupResponse } from '@agrotrace/api-client';
  import { TwoFactorSetupRequestSchema, type TwoFactorSetupRequest } from '@agrotrace/validation';
  import { call, Countdown, focusAfterWait, focusRevealed, retryAfterOf } from '../../app/api.svelte';
  import { cache, screenAlive } from '../../app/cache.svelte';
  import { form, SchemaForm } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { userAction } from '../../app/focusRescue';
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
   * otpauth URI → confirm with a code → on. A 409 (already on, e.g. in another tab) reloads the profile. Focus (FM24,
   * FM25, FM27): the revealed form's code field takes it (only when it is free); «Отмена» gives it back to
   * «Настроить»; a form opened again starts clean; during a 429 wait it stays where it is and «Настроить» takes it back
   * when it can act (FM17). */
  let { me }: { me: Me } = $props();

  const alive = screenAlive();
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

  /** Already on (another tab): the profile of this session says so. */
  async function alreadyOn(generation: number) {
    if (alive()) pending = null;
    // FM30: «already on» is a known result: shown at once, then the profile is re-read
    if (session.patchMe({ totpEnabled: true }, generation)) await session.reloadMe();
  }

  const f = new SchemaForm<TwoFactorSetupRequest>({
    schema: TwoFactorSetupRequestSchema,
    values: { code: '' },
    fields: ['code'],
    send: async (body) => {
      const generation = cache.generation;
      try {
        await call<TwoFactorSetupResponse>(session.api.POST('/auth/2fa/setup', { body }));
      } catch (e) {
        if (e instanceof ApiProblem && e.code === 'INVALID_TWO_FACTOR_CODE') {
          if (f.alive()) f.setError('code', 'errors.INVALID_TWO_FACTOR_CODE');
        } else if (e instanceof ApiProblem && e.status === 409) await alreadyOn(generation);
        else throw e;
        return;
      }
      // a successful change is never reported as an error; its success is said in this session even if the card is
      // gone (FM25/FM29)
      if (cache.generation !== generation) return;
      const here = f.alive();
      if (here) pending = null;
      session.patchMe({ totpEnabled: true }, generation); // FM30: the known result at once
      toasts.push({ tone: 'ok', text: t('profile.twoFactorEnabled') });
      void session.reloadMe(); // FM28: a failed re-read keeps the profile, never an error
    },
  });

  async function start(e: MouseEvent) {
    const opener = e.currentTarget as HTMLElement;
    f.alert.clear();
    starting = true;
    const generation = cache.generation;
    try {
      const res = await call<TwoFactorSetupResponse>(session.api.POST('/auth/2fa/setup', { body: {} }));
      if ('secret' in res && res.secret && res.otpauthUrl) {
        if (!alive()) return;
        f.reset({ code: '' }); // a form opened again starts clean (FM27)
        pending = { secret: res.secret, otpauthUrl: res.otpauthUrl };
        void focusRevealed(() => document.getElementById('totp-code'), opener);
      } else await alreadyOn(generation);
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 409) await alreadyOn(generation);
      else if (alive()) {
        if (err instanceof ApiProblem && err.status === 429) startWait.start(retryAfterOf(err));
        f.alert.problem(err);
      }
    } finally {
      starting = false;
    }
  }

  async function cancel() {
    pending = null;
    f.reset({ code: '' });
    await tick();
    startButton?.focus(); // back to the control that revealed the form (FM25)
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
      <Button
        bind:element={startButton}
        busy={starting}
        disabled={startWait.left > 0}
        onclick={(e: MouseEvent) => void userAction(() => start(e))}
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
        <Button variant="ghost" onclick={() => void cancel()}>{t('action.cancel')}</Button>
      </CardFooter>
    </form>
  {/if}
</Card>
