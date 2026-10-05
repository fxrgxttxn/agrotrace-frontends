import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiProblem, retryAfterOf } from '@agrotrace/api-client/public';
import { Button } from '../ui/ButtonBase';
import { Field } from '../ui/Field';
import { Input, Textarea } from '../ui/Input';
import { useCountdown, useFocusAfterWait } from '../ui/wait';
import { expiresAt, solveChallenge } from './altcha';
import { api, failureOf, useBatch } from './data';
import { t } from './i18n';
import { batchPath, onLink } from './nav';
import { NotFound, PublicPage } from './views';

const TEXT_MIN = 10;
const TEXT_MAX = 2000;
const CONTACT_MAX = 255;
const EXPIRY_MARGIN_MS = 30_000;

type Errors = { text?: string; contact?: string };

const problemText = (code: string) => {
  const key = `errors.${code}`;
  return t(key) === key ? t('errors.UNKNOWN') : t(key);
};

export function checkComplaint(text: string, contact: string): Errors {
  const errors: Errors = {};
  if (!/\S/.test(text)) errors.text = t('validation.required');
  else if ([...text].length < TEXT_MIN) errors.text = t('public.textShort');
  if (contact !== '' && !/\S/.test(contact)) errors.contact = t('validation.pattern');
  return errors;
}

interface Solved {
  payload: string;
  expires: number | null;
}

function useAltcha() {
  const pending = useRef<Promise<Solved> | null>(null);
  const prepare = useCallback(() => {
    const p = api
      .getCaptcha()
      .then(async (c) => ({ payload: await solveChallenge(c), expires: expiresAt(c) }));
    p.catch(() => undefined);
    pending.current = p;
    return p;
  }, []);
  useEffect(() => {
    if (!pending.current) prepare();
  }, [prepare]);
  const take = useCallback(async () => {
    const ready = await (pending.current ?? prepare()).catch(() => null);
    const fresh =
      ready && (ready.expires === null || ready.expires - Date.now() > EXPIRY_MARGIN_MS)
        ? ready
        : await prepare();
    pending.current = null;
    return fresh.payload;
  }, [prepare]);
  return { take, prepare };
}

type Message = { text: string; tone: 'danger' | 'attention' };

export function ComplaintPage({ code }: { code: string }) {
  const { state } = useBatch(code);
  const altcha = useAltcha();
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [done, setDone] = useState(false);
  const [wait, startWait] = useCountdown();
  const submitRef = useFocusAfterWait(wait);
  useEffect(() => {
    if (wait === 0) setMessage((m) => (m?.tone === 'attention' ? null : m));
  }, [wait]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const contactRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const showErrors = (next: Errors) => {
    setErrors(next);
    if (next.text) textRef.current?.focus();
    else if (next.contact) contactRef.current?.focus();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || wait > 0) return;
    const found = checkComplaint(text, contact);
    setMessage(null);
    if (found.text || found.contact) return showErrors(found);
    setErrors({});
    setBusy(true);
    let sent = false;
    try {
      let payload: string;
      try {
        payload = await altcha.take();
      } catch {
        setMessage({ text: t('public.captchaUnavailable'), tone: 'danger' });
        return;
      }
      sent = true;
      await api.createComplaint(code, { text, ...(contact === '' ? {} : { contact }), altcha: payload });
      if (alive.current) setDone(true);
    } catch (err) {
      if (!alive.current) return;
      const fail = (text: string) => setMessage({ text, tone: 'danger' });
      if (err instanceof ApiProblem && err.code === 'VALIDATION' && err.errors) {
        const next: Errors = {};
        const rest: string[] = [];
        for (const [path, keys] of Object.entries(err.errors)) {
          const key = keys[0] ?? '';
          const text = t(key) === key ? t('errors.VALIDATION') : t(key);
          if (path === 'text' || path === 'contact') next[path] ??= text;
          else rest.push(text);
        }
        if (next.text || next.contact) showErrors(next);
        if (rest.length || !(next.text || next.contact)) fail(rest.join('. ') || problemText(err.code));
      } else if (err instanceof ApiProblem && err.code === 'CAPTCHA_FAILED') fail(t('public.captchaRetry'));
      else if (err instanceof ApiProblem && err.status === 429) {
        const seconds = retryAfterOf(err) ?? 60;
        startWait(seconds);
        setMessage({ text: t('auth.rateLimited', { seconds }), tone: 'attention' });
      } else if (err instanceof ApiProblem && err.status === 404) setGone(true);
      else if (err instanceof ApiProblem) fail(problemText(err.code));
      else fail(t(failureOf(err).kind === 'offline' ? 'public.offline' : 'public.unavailable'));
    } finally {
      if (alive.current) {
        setBusy(false);
        if (sent) altcha.prepare();
      }
    }
  }

  if (state.status === 'notFound' || gone)
    return (
      <PublicPage title={t('page.publicComplaint')}>
        <NotFound />
      </PublicPage>
    );

  const back = (variant: 'primary' | 'secondary') => (
    <a className="at-button" data-variant={variant} href={batchPath(code)} onClick={onLink}>
      {t('public.toBatch')}
    </a>
  );

  if (done)
    return (
      <PublicPage title={t('page.publicComplaint')}>
        <article className="at-card" data-furrow="">
          <div className="at-card__body at-public__done">
            <p className="at-public__done-text" tabIndex={-1} ref={doneRef}>
              {t('public.sent')}
            </p>
            {back('primary')}
          </div>
        </article>
      </PublicPage>
    );

  return (
    <PublicPage title={t('page.publicComplaint')}>
      <article className="at-card" data-furrow="">
        <div className="at-card__body">
          {state.status === 'ok' && (
            <p className="at-public__about">
              {state.batch.product.name} <span className="at-mono">{state.batch.publicCode}</span>
            </p>
          )}
          <form id="complaint" className="at-public__form" noValidate onSubmit={submit}>
            <Field id="complaint-text" label={t('public.text')} error={errors.text}>
              <Textarea
                ref={textRef}
                rows={6}
                maxLength={TEXT_MAX}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
            <Field id="complaint-contact" label={t('public.contact')} error={errors.contact}>
              <Input
                ref={contactRef}
                autoComplete="on"
                maxLength={CONTACT_MAX}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </Field>
            {message && (
              <p className={message.tone === 'danger' ? 'at-field__error' : 'at-field__warning'} role="alert">
                {message.text}
              </p>
            )}
          </form>
        </div>
        <footer className="at-card__footer">
          {back('secondary')}
          <Button
            ref={submitRef}
            type="submit"
            form="complaint"
            variant="primary"
            busy={busy}
            disabled={wait > 0}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('public.send')}
          </Button>
        </footer>
      </article>
    </PublicPage>
  );
}
