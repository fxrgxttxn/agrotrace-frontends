<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ApiProblem, type NotificationChannels, type TelegramCode } from '@agrotrace/api-client';
  import { formatLocalTime } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { cache, query, screenAlive } from '../../app/cache.svelte';
  import { FormAlert } from '../../app/forms.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { userAction } from '../../app/focusRescue';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Switch from '../../ui/Switch.svelte';
  import { toasts } from '../../ui/toast-store.svelte';
  import { FORM_GRID, ROW } from '../layout';

  const alive = screenAlive();
  const alert = new FormAlert();
  onDestroy(() => alert.clear());

  let code = $state<TelegramCode | null>(null);
  let saving = $state(false);
  let codeBusy = $state(false);

  const channels = query(
    () => ['me', 'channels'],
    () => call<NotificationChannels>(session.api.GET('/me/channels')),
    { refetchInterval: () => (code ? 5000 : false), failed: 'profile.channelsFailed' },
  );
  const linked = $derived(channels.data?.telegramLinked ?? false);

  const MAX_TIMER = 2147483647;

  $effect(() => {
    if (!code) return;
    const current = code;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const left = Date.parse(current.expiresAt) - Date.now();
      timer = setTimeout(() => (left > MAX_TIMER ? arm() : (code = null)), Math.max(0, Math.min(left, MAX_TIMER)));
    };
    arm();
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (code && linked) {
      code = null;
      toasts.push({ tone: 'ok', text: t('profile.telegramLinked') });
    }
  });

  async function save(next: { email: boolean; telegram: boolean }) {
    alert.clear();
    saving = true;
    const generation = cache.generation;
    try {
      channels.set(await call<NotificationChannels>(session.api.PUT('/me/channels', { body: next })), generation);
    } catch (e) {
      if (!alive()) return;
      const key = e instanceof ApiProblem ? (e.errors?.telegram?.[0] ?? e.errors?.email?.[0]) : undefined;
      if (key) alert.show(t(key));
      else alert.problem(e);
    } finally {
      saving = false;
    }
  }

  async function newCode() {
    alert.clear();
    codeBusy = true;
    try {
      const answer = await call<TelegramCode>(session.api.POST('/me/telegram-code'));
      if (alive()) code = answer;
    } catch (err) {
      if (alive()) alert.problem(err);
    } finally {
      codeBusy = false;
    }
  }
</script>

<Card>
  <CardHeader title={t('profile.channels')} />
  <CardBody>
    {#if !channels.data && channels.failed}
      <div style={FORM_GRID}>
        <p>{t('profile.channelsFailed')}</p>
        <div>
          <Button busy={channels.fetching} onclick={() => void userAction(channels.refetch)}>{t('action.retry')}</Button>
        </div>
      </div>
    {:else if !channels.data}
      <div aria-busy="true" style={FORM_GRID}>
        <span class="at-skeleton" data-shape="text" style="width: 60%"></span>
        <span class="at-skeleton" data-shape="text" style="width: 40%"></span>
      </div>
    {:else}
      {@const data = channels.data}
      <div style={FORM_GRID}>
        <Switch checked={data.email} disabled={saving} onchange={(v) => void userAction(() => save({ email: v, telegram: data.telegram }))}
          >{t('field.email')}</Switch
        >
        <Switch
          checked={data.telegram}
          disabled={saving || (!data.telegramLinked && !data.telegram)}
          onchange={(v) => void userAction(() => save({ email: data.email, telegram: v }))}>{t('field.telegram')}</Switch
        >
        {#if code}
          <div style={FORM_GRID}>
            <p>{t('profile.telegramCode', { bot: code.botUsername, code: code.code })}</p>
            <p>{t('profile.telegramUntil', { time: formatLocalTime(code.expiresAt, LOCALE) })}</p>
            <div style={ROW}>
              <Button
                variant="primary"
                href="https://t.me/{code.botUsername}?start={code.code}"
                target="_blank"
                rel="noopener noreferrer">{t('profile.openTelegram')}</Button
              >
              <Button variant="ghost" busy={codeBusy} onclick={() => void userAction(newCode)}>{t('profile.newCode')}</Button>
            </div>
          </div>
        {:else if !data.telegramLinked}
          <div>
            <Button busy={codeBusy} onclick={() => void userAction(newCode)}>{t('profile.linkTelegram')}</Button>
          </div>
        {/if}
      </div>
    {/if}
  </CardBody>
</Card>
