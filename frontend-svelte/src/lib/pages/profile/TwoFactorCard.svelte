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

  let { me }: { me: Me } = $props();

  const alive = screenAlive();
  let pending = $state<{ secret: string; otpauthUrl: string } | null>(null);
  let starting = $state(false);
  const startWait = new Countdown();
  onDestroy(() => startWait.stop());
  let startButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => startWait.left,
    () => startButton,
  );

  const groupSecret = (s: string) => s.replace(/(.{4})(?=.)/g, '$1 ');

  async function alreadyOn(generation: number) {
    if (alive()) pending = null;
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
      if (cache.generation !== generation) return;
      const here = f.alive();
      if (here) pending = null;
      session.patchMe({ totpEnabled: true }, generation);
      toasts.push({ tone: 'ok', text: t('profile.twoFactorEnabled') });
      void session.reloadMe();
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
        f.reset({ code: '' });
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
    startButton?.focus();
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
