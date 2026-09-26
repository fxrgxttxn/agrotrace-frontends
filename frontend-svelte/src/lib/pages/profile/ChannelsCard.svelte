<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ApiProblem, type NotificationChannels, type TelegramCode } from '@agrotrace/api-client';
  import { formatLocalTime } from '@agrotrace/i18n';
  import { call, errorText, errorTone, restoreFocus } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { FormAlert } from '../../app/forms.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Switch from '../../ui/Switch.svelte';
  import { toasts } from '../../ui/toast-store.svelte';
  import { FORM_GRID, ROW } from '../layout';

  /** Notification channels (FR-NOTIF-02/03): Email and Telegram switches (Telegram only once linked), the Telegram link
   * code with the bot, the command and the expiry (local time); while a code is out the channels are asked for every
   * 5 s to see the link confirmed; the code is dropped at `expiresAt`. */
  const alert = new FormAlert();
  onDestroy(() => alert.clear());

  let code = $state<TelegramCode | null>(null);
  let saving = $state(false);
  let codeBusy = $state(false);

  const channels = query(
    () => ['me', 'channels'],
    () => call<NotificationChannels>(session.api.GET('/me/channels')),
    { refetchInterval: () => (code ? 5000 : false) },
  );
  const linked = $derived(channels.data?.telegramLinked ?? false);

  /** The longest wait a timer takes (2^31 − 1 ms); a later expiry is re-armed when that runs out. */
  const MAX_TIMER = 2147483647;

  // The code is void at `expiresAt`: stop watching and offer a new one.
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
    try {
      channels.set(await call<NotificationChannels>(session.api.PUT('/me/channels', { body: next })));
    } catch (e) {
      const key = e instanceof ApiProblem ? (e.errors?.telegram?.[0] ?? e.errors?.email?.[0]) : undefined;
      alert.show(key ? t(key) : errorText(e), errorTone(e));
    } finally {
      saving = false;
    }
  }

  async function newCode(e: MouseEvent) {
    const opener = e.currentTarget as HTMLElement;
    alert.clear();
    codeBusy = true;
    try {
      code = await call<TelegramCode>(session.api.POST('/me/telegram-code'));
    } catch (err) {
      alert.show(errorText(err), errorTone(err));
    } finally {
      codeBusy = false;
    }
    void restoreFocus(opener);
  }
</script>

<Card>
  <CardHeader title={t('profile.channels')} />
  <CardBody>
    {#if !channels.data && channels.failed}
      <div style={FORM_GRID}>
        <p>{t('profile.channelsFailed')}</p>
        <div>
          <Button busy={channels.fetching} onclick={() => void channels.refetch()}>{t('action.retry')}</Button>
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
        <Switch checked={data.email} disabled={saving} onchange={(v) => void save({ email: v, telegram: data.telegram })}
          >{t('field.email')}</Switch
        >
        <Switch
          checked={data.telegram}
          disabled={saving || (!data.telegramLinked && !data.telegram)}
          onchange={(v) => void save({ email: data.email, telegram: v })}>{t('field.telegram')}</Switch
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
              <Button variant="ghost" busy={codeBusy} onclick={(e: MouseEvent) => void newCode(e)}>{t('profile.newCode')}</Button>
            </div>
          </div>
        {:else if !data.telegramLinked}
          <div>
            <Button busy={codeBusy} onclick={(e: MouseEvent) => void newCode(e)}>{t('profile.linkTelegram')}</Button>
          </div>
        {/if}
      </div>
    {/if}
  </CardBody>
</Card>
