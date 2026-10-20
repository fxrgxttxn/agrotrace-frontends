<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { ApiProblem, retryAfterOf } from '@agrotrace/api-client/public';
  import { expiresAt, solveChallenge } from './altcha';
  import { api, BatchQuery, failureOf, focusIfIdle, Wait } from './data.svelte';
  import { t } from './i18n';
  import NotFound from './NotFound.svelte';
  import { publicFrame } from './frame.svelte';

  // /p/:publicCode/complaint (FR-PUB-03, БП-6): the buyer's complaint with the self-hosted ALTCHA proof of work (solved
  // in the background from the moment the form opens; a solution is used once) and the complaint-ip limit (429 → the
  // submit waits out Retry-After, FM17). What is typed is sent as it is (R36: nothing trimmed). As the React app's
  // ComplaintPage (src/public/ComplaintPage.tsx there); README markup written out (the page's JS budget).

  let { code }: { code: string } = $props();

  const TEXT_MIN = 10;
  const TEXT_MAX = 2000;
  const CONTACT_MAX = 255;
  /** A solution this close to its expiry is not sent: a fresh challenge is solved instead. */
  const EXPIRY_MARGIN_MS = 30_000;
  type Errors = { text?: string; contact?: string };

  const batchCode = untrack(() => code);
  const query = new BatchQuery(batchCode);
  const batchState = $derived(query.state);
  publicFrame(() => t('page.publicComplaint'));
  const back = `/p/${encodeURIComponent(batchCode)}`;

  /** The text of a problem code of the public operations (the public dictionary has only those). */
  const problemText = (c: string) => {
    const key = `errors.${c}`;
    return t(key) === key ? t('errors.UNKNOWN') : t(key);
  };

  /** Client checks of the contract's PublicComplaintRequest (`minLength` counts code points, `pattern: \S`). */
  function checkComplaint(text: string, contact: string): Errors {
    const errors: Errors = {};
    if (!/\S/.test(text)) errors.text = t('validation.required');
    else if ([...text].length < TEXT_MIN) errors.text = t('public.textShort');
    if (contact !== '' && !/\S/.test(contact)) errors.contact = t('validation.pattern');
    return errors;
  }

  // ── ALTCHA: requested and solved ahead; `take()` hands a solution out once ──
  type Solved = { payload: string; expires: number | null };
  let pending: Promise<Solved> | null = null;
  function prepare(): Promise<Solved> {
    const p = api.getCaptcha().then(async (c) => ({ payload: await solveChallenge(c), expires: expiresAt(c) }));
    p.catch(() => undefined);
    pending = p;
    return p;
  }
  prepare();
  async function take(): Promise<string> {
    const ready = await (pending ?? prepare()).catch(() => null);
    const fresh =
      ready && (ready.expires === null || ready.expires - Date.now() > EXPIRY_MARGIN_MS) ? ready : await prepare();
    pending = null;
    return fresh.payload;
  }

  let text = $state('');
  let contact = $state('');
  let errors = $state<Errors>({});
  let message = $state<{ text: string; tone: 'danger' | 'attention' } | null>(null);
  let busy = $state(false);
  let gone = $state(false);
  let done = $state(false);
  const wait = new Wait();
  let alive = true;
  onDestroy(() => {
    alive = false;
    wait.stop();
  });
  const el = (id: string) => document.getElementById(id);
  // FM17: the submit takes the focus back when the wait ends (only if idle); the limit message no longer applies.
  let waited = false;
  $effect(() => {
    if (wait.left > 0) waited = true;
    else if (waited) {
      waited = false;
      if (message?.tone === 'attention') message = null;
      focusIfIdle(document.querySelector<HTMLElement>('button[form="complaint"]'));
    }
  });
  // The form is replaced by the confirmation: the focus goes to it (the submit button is gone).
  $effect(() => {
    if (done) el('complaint-done')?.focus();
  });

  async function showErrors(next: Errors) {
    errors = next;
    await tick();
    if (next.text) el('complaint-text')?.focus();
    else if (next.contact) el('complaint-contact')?.focus();
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || wait.left > 0) return;
    const found = checkComplaint(text, contact);
    message = null;
    if (found.text || found.contact) return showErrors(found);
    errors = {};
    busy = true;
    let sent = false;
    try {
      let payload: string;
      try {
        payload = await take();
      } catch {
        message = { text: t('public.captchaUnavailable'), tone: 'danger' };
        return;
      }
      sent = true;
      await api.createComplaint(batchCode, { text, ...(contact === '' ? {} : { contact }), altcha: payload });
      if (alive) done = true;
    } catch (err) {
      if (!alive) return;
      const fail = (s: string) => (message = { text: s, tone: 'danger' });
      if (err instanceof ApiProblem && err.code === 'VALIDATION' && err.errors) {
        const next: Errors = {};
        const rest: string[] = [];
        for (const [path, keys] of Object.entries(err.errors)) {
          const key = keys[0] ?? '';
          const s = t(key) === key ? t('errors.VALIDATION') : t(key);
          if (path === 'text' || path === 'contact') next[path] ??= s;
          else rest.push(s);
        }
        if (next.text || next.contact) void showErrors(next);
        if (rest.length || !(next.text || next.contact)) fail(rest.join('. ') || problemText(err.code));
      } else if (err instanceof ApiProblem && err.code === 'CAPTCHA_FAILED') fail(t('public.captchaRetry'));
      else if (err instanceof ApiProblem && err.status === 429) {
        const seconds = retryAfterOf(err) ?? 60;
        wait.start(seconds);
        message = { text: t('auth.rateLimited', { seconds }), tone: 'attention' };
      } else if (err instanceof ApiProblem && err.status === 404) gone = true;
      else if (err instanceof ApiProblem) fail(problemText(err.code));
      else fail(t(failureOf(err).kind === 'offline' ? 'public.offline' : 'public.unavailable'));
    } finally {
      if (alive) {
        busy = false;
        // A solution is good for one submit: the next one gets a fresh challenge.
        if (sent) prepare();
      }
    }
  }
</script>

<main class="at-page at-public" id="main" tabindex="-1">
  <div class="at-page__header"><h1 class="at-page__title" tabindex="-1">{t('page.publicComplaint')}</h1></div>
  <div class="at-public__stack">
  {#if batchState.status === 'notFound' || gone}
    <NotFound />
  {:else if done}
    <article class="at-card" data-furrow="">
      <div class="at-card__body at-public__done">
        <p class="at-public__done-text" tabindex="-1" id="complaint-done">{t('public.sent')}</p>
        <a class="at-button" data-variant="primary" href={back}>{t('public.toBatch')}</a>
      </div>
    </article>
  {:else}
    <article class="at-card" data-furrow="">
      <div class="at-card__body">
        {#if batchState.status === 'ok'}
          <p class="at-public__about">
            {batchState.batch.product.name} <span class="at-mono">{batchState.batch.publicCode}</span>
          </p>
        {/if}
        <form id="complaint" class="at-public__form" novalidate onsubmit={(e) => void submit(e)}>
          <!-- at-field (README «Поле формы»): the error element only with an error, aria-invalid/describedby then. -->
          <div class="at-field" data-invalid={errors.text ? '' : undefined}>
            <label class="at-field__label" for="complaint-text">{t('public.text')}</label>
            <textarea
              class="at-textarea"
              id="complaint-text"
              aria-invalid={errors.text ? 'true' : undefined}
              aria-describedby={errors.text ? 'complaint-text-error' : undefined}
              rows="6"
              maxlength={TEXT_MAX}
              value={text}
              oninput={(e) => (text = e.currentTarget.value)}
            ></textarea>
            {#if errors.text}<p class="at-field__error" id="complaint-text-error" role="alert">{errors.text}</p>{/if}
          </div>
          <div class="at-field" data-invalid={errors.contact ? '' : undefined}>
            <label class="at-field__label" for="complaint-contact">{t('public.contact')}</label>
            <input
              class="at-input"
              id="complaint-contact"
              aria-invalid={errors.contact ? 'true' : undefined}
              aria-describedby={errors.contact ? 'complaint-contact-error' : undefined}
              autocomplete="on"
              maxlength={CONTACT_MAX}
              value={contact}
              oninput={(e) => (contact = e.currentTarget.value)}
            />
            {#if errors.contact}<p class="at-field__error" id="complaint-contact-error" role="alert">{errors.contact}</p
              >{/if}
          </div>
          {#if message}
            {#if message.tone === 'danger'}<p class="at-field__error" role="alert">{message.text}</p>{:else}<p
                class="at-field__warning"
                role="alert">{message.text}</p
              >{/if}
          {/if}
        </form>
      </div>
      <footer class="at-card__footer">
        <a class="at-button" data-variant="secondary" href={back}>{t('public.toBatch')}</a>
        <button
          type="submit"
          class="at-button"
          form="complaint"
          data-variant="primary"
          aria-busy={busy ? 'true' : undefined}
          disabled={wait.left > 0}
          >{wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('public.send')}</button
        >
      </footer>
    </article>
  {/if}
  </div>
</main>
