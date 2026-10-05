import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiProblem,
  withVariant,
  type FileRef,
  type Me,
  type NotificationChannels,
  type TelegramCode,
  type TwoFactorSetupResponse,
} from '@agrotrace/api-client';
import { formatBytes, formatLocalTime } from '@agrotrace/i18n';
import {
  MeUpdateSchema,
  TwoFactorSetupRequestSchema,
  type TwoFactorSetupRequest,
} from '@agrotrace/validation';
import {
  call,
  errorText,
  errorTone,
  retryAfterOf,
  useCountdown,
  useFocusAfterWait,
  useFormAlert,
} from '../app/api';
import { errorOf, FORM_GRID, Submit, useSchemaForm } from '../app/forms';
import { useCacheWriter, useScreenAlive, useScreenScope, useScreenToast } from '../app/cache';
import { LOCALE, t } from '../app/i18n';
import { useMe, useSession } from '../app/session';
import { ThemeSwitch } from '../shell/ThemeSwitch';
import {
  Avatar,
  Button,
  ButtonAnchor,
  Card,
  CardBody,
  CardFacts,
  CardFooter,
  CardHeader,
  Chip,
  Field,
  FileField,
  Input,
  Page,
  Qr,
  Switch,
  type FileItem,
} from '../ui';

const GRID = {
  display: 'grid',
  gap: 'var(--sp-6)',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))',
  alignItems: 'start',
} as const;
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-3)', alignItems: 'center' } as const;

export function ProfilePage() {
  const { signOut } = useSession();
  const me = useMe();
  const tfa = me.roles.includes('INSPECTOR') || me.roles.includes('ADMIN');
  return (
    <Page
      title={t('page.profile')}
      actions={
        <Button icon="logout" onClick={() => void signOut()}>
          {t('action.logout')}
        </Button>
      }
    >
      <div style={GRID}>
        <PersonalCard me={me} />
        <AvatarCard me={me} />
        <ChannelsCard />
        {tfa && <TwoFactorCard me={me} />}
        <Card>
          <CardHeader title={t('profile.appearance')} />
          <CardBody>
            <ThemeSwitch />
          </CardBody>
        </Card>
      </div>
    </Page>
  );
}

interface PersonalValues {
  fullName: string;
  phone: string | null;
}

function useRefreshMe(): () => void {
  const { reloadMe } = useSession();
  const alive = useScreenAlive();
  return useCallback(() => {
    const attempt = (left: number) => {
      reloadMe().catch(() => {
        if (left > 0) setTimeout(() => alive() && attempt(left - 1), 3000);
      });
    };
    attempt(2);
  }, [reloadMe, alive]);
}

function PersonalCard({ me }: { me: Me }) {
  const { api, setMe } = useSession();
  const scope = useScreenScope();
  const toast = useScreenToast();
  const { form, alert, wait, fail } = useSchemaForm<PersonalValues>(
    MeUpdateSchema,
    { fullName: me.fullName, phone: me.phone },
    ['fullName', 'phone'],
  );

  const submit = form.handleSubmit(async (values) => {
    alert.clear();
    const body: Partial<PersonalValues> = {};
    if (values.fullName !== me.fullName) body.fullName = values.fullName;
    if (values.phone !== me.phone) body.phone = values.phone;
    if (Object.keys(body).length === 0) return;
    try {
      const next = await call<Me>(api.PATCH('/me', { body }));
      if (!scope.sameSession()) return;
      setMe(next);
      form.reset({ fullName: next.fullName, phone: next.phone });
      toast.done({ tone: 'ok', text: t('profile.saved') });
    } catch (e) {
      fail(e);
    }
  });

  return (
    <Card>
      <CardHeader title={t('profile.personal')} />
      <form noValidate onSubmit={submit}>
        <CardBody>
          <div style={FORM_GRID}>
            <CardFacts
              facts={[
                { key: 'email', term: t('field.email'), value: me.email },
                { key: 'org', term: t('auth.organization'), value: me.organization.name },
                {
                  key: 'roles',
                  term: t('field.roles'),
                  value: me.roles.map((r) => t(`role.${r}`)).join(', '),
                },
              ]}
            />
            <Field id="fullName" label={t('field.fullName')} error={errorOf(form, 'fullName')}>
              <Input autoComplete="name" {...form.register('fullName')} />
            </Field>
            <Field id="phone" label={t('field.phone')} error={errorOf(form, 'phone')}>
              <Input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                {...form.register('phone', { setValueAs: (v: string | null) => (v === '' ? null : v) })}
              />
            </Field>
          </div>
        </CardBody>
        <CardFooter>
          <Submit busy={form.formState.isSubmitting} wait={wait}>
            {t('action.save')}
          </Submit>
        </CardFooter>
      </form>
    </Card>
  );
}

const AVATAR_MAX_BYTES = 2097152;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const TYPE_NAMES: Record<string, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/svg+xml': 'SVG',
  'application/pdf': 'PDF',
};

const typesText = (types: readonly unknown[]) =>
  types.map((m) => TYPE_NAMES[String(m)] ?? String(m)).join(', ');
const tooLargeText = (max: number) => t('files.tooLarge', { max: formatBytes(max, LOCALE) });

interface Picked {
  file: File;
  url: string;
  error?: string;
}

function AvatarCard({ me }: { me: Me }) {
  const { api, setMe } = useSession();
  const refreshMe = useRefreshMe();
  const scope = useScreenScope();
  const toast = useScreenToast();
  const alert = useFormAlert();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState<'upload' | 'delete' | null>(null);

  useEffect(() => () => void (picked && URL.revokeObjectURL(picked.url)), [picked]);

  const pick = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!AVATAR_TYPES.includes(file.type))
      error = t('files.unsupported', { allowed: typesText(AVATAR_TYPES) });
    else if (file.size > AVATAR_MAX_BYTES) error = tooLargeText(AVATAR_MAX_BYTES);
    setPicked({ file, url: URL.createObjectURL(file), error });
  };

  const upload = async () => {
    if (!picked || picked.error) return;
    alert.clear();
    setBusy('upload');
    try {
      const body = new FormData();
      body.append('file', picked.file);
      const stored = await call<FileRef>(api.PUT('/me/avatar', { body: body as never }));
      if (scope.sameSession()) setMe({ ...me, avatarUrl: stored.url });
      setPicked(null);
      toast.done({ tone: 'ok', text: t('profile.avatarSaved') });
      refreshMe();
    } catch (e) {
      let error: string | undefined;
      if (e instanceof ApiProblem && e.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(e.params?.maxBytes) || AVATAR_MAX_BYTES);
      else if (e instanceof ApiProblem && e.code === 'UNSUPPORTED_MEDIA_TYPE')
        error = t('files.unsupported', {
          allowed: typesText(Array.isArray(e.params?.allowed) ? e.params.allowed : AVATAR_TYPES),
        });
      else if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors?.file?.[0])
        error = t(e.errors.file[0]);
      if (error) setPicked((p) => (p ? { ...p, error } : p));
      else alert.show(errorText(e), errorTone(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    alert.clear();
    setBusy('delete');
    try {
      await call(api.DELETE('/me/avatar'));
      if (scope.sameSession()) setMe({ ...me, avatarUrl: null });
      toast.done({ tone: 'ok', text: t('profile.avatarDeleted') });
      refreshMe();
    } catch (e) {
      alert.show(errorText(e), errorTone(e));
    } finally {
      setBusy(null);
    }
  };

  const items: FileItem[] = picked
    ? [
        {
          key: 'avatar',
          name: picked.file.name,
          sizeText: picked.error ?? formatBytes(picked.file.size, LOCALE),
          error: Boolean(picked.error),
          previewUrl: picked.error ? undefined : picked.url,
          kind: picked.error ? (TYPE_NAMES[picked.file.type] ?? '') : undefined,
        },
      ]
    : [];

  return (
    <Card>
      <CardHeader title={t('profile.avatar')} />
      <CardBody>
        <div style={FORM_GRID}>
          <div style={ROW}>
            <Avatar name={me.fullName} src={me.avatarUrl ? withVariant(me.avatarUrl, 96) : null} size="l" />
            {me.avatarUrl && (
              <Button variant="ghost" icon="trash" busy={busy === 'delete'} onClick={() => void remove()}>
                {t('profile.deleteAvatar')}
              </Button>
            )}
          </div>
          <FileField
            id="avatar-file"
            label={t('field.file')}
            accept={AVATAR_TYPES.join(',')}
            hint={t('profile.avatarHint')}
            files={items}
            onFiles={pick}
            onRemove={() => setPicked(null)}
            error={picked?.error}
            disabled={busy !== null}
          />
        </div>
      </CardBody>
      {picked && !picked.error && (
        <CardFooter>
          <Button variant="primary" icon="upload" busy={busy === 'upload'} onClick={() => void upload()}>
            {t('action.upload')}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

const CHANNELS_KEY = ['me', 'channels'] as const;

function ChannelsCard() {
  const { api } = useSession();
  const cache = useCacheWriter();
  const toast = useScreenToast();
  const alert = useFormAlert();
  const [code, setCode] = useState<TelegramCode | null>(null);
  const [saving, setSaving] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const channels = useQuery({
    queryKey: CHANNELS_KEY,
    meta: { failed: 'profile.channelsFailed' },
    queryFn: () => call<NotificationChannels>(api.GET('/me/channels')),
    refetchInterval: code ? 5000 : false,
  });
  const linked = channels.data?.telegramLinked ?? false;

  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(null), Math.max(0, Date.parse(code.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);

  useEffect(() => {
    if (code && linked) {
      setCode(null);
      toast.done({ tone: 'ok', text: t('profile.telegramLinked') });
    }
  }, [code, linked, toast]);

  const save = async (next: { email: boolean; telegram: boolean }) => {
    alert.clear();
    setSaving(true);
    try {
      const data = await call<NotificationChannels>(api.PUT('/me/channels', { body: next }));
      cache.set(CHANNELS_KEY, data);
    } catch (e) {
      const key = e instanceof ApiProblem ? (e.errors?.telegram?.[0] ?? e.errors?.email?.[0]) : undefined;
      alert.show(key ? t(key) : errorText(e), errorTone(e));
    } finally {
      setSaving(false);
    }
  };

  const newCode = async () => {
    alert.clear();
    setCodeBusy(true);
    try {
      setCode(await call<TelegramCode>(api.POST('/me/telegram-code')));
    } catch (e) {
      alert.show(errorText(e), errorTone(e));
    } finally {
      setCodeBusy(false);
    }
  };

  const data = channels.data;
  return (
    <Card>
      <CardHeader title={t('profile.channels')} />
      <CardBody>
        {!data && channels.isError ? (
          <div style={FORM_GRID}>
            <p>{t('profile.channelsFailed')}</p>
            <div>
              <Button busy={channels.isFetching} onClick={() => void channels.refetch()}>
                {t('action.retry')}
              </Button>
            </div>
          </div>
        ) : !data ? (
          <div aria-busy="true" style={FORM_GRID}>
            <span className="at-skeleton" data-shape="text" style={{ width: '60%' }}></span>
            <span className="at-skeleton" data-shape="text" style={{ width: '40%' }}></span>
          </div>
        ) : (
          <div style={FORM_GRID}>
            <Switch
              checked={data.email}
              disabled={saving}
              onChange={(v) => void save({ email: v, telegram: data.telegram })}
            >
              {t('field.email')}
            </Switch>
            <Switch
              checked={data.telegram}
              disabled={saving || (!data.telegramLinked && !data.telegram)}
              onChange={(v) => void save({ email: data.email, telegram: v })}
            >
              {t('field.telegram')}
            </Switch>
            {code ? (
              <div style={FORM_GRID}>
                <p>{t('profile.telegramCode', { bot: code.botUsername, code: code.code })}</p>
                <p>{t('profile.telegramUntil', { time: formatLocalTime(code.expiresAt, LOCALE) })}</p>
                <div style={ROW}>
                  <ButtonAnchor
                    variant="primary"
                    href={`https://t.me/${code.botUsername}?start=${code.code}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('profile.openTelegram')}
                  </ButtonAnchor>
                  <Button variant="ghost" busy={codeBusy} onClick={() => void newCode()}>
                    {t('profile.newCode')}
                  </Button>
                </div>
              </div>
            ) : (
              !data.telegramLinked && (
                <div>
                  <Button busy={codeBusy} onClick={() => void newCode()}>
                    {t('profile.linkTelegram')}
                  </Button>
                </div>
              )
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

const groupSecret = (s: string) => s.replace(/(.{4})(?=.)/g, '$1 ');

function TwoFactorCard({ me }: { me: Me }) {
  const { api, setMe } = useSession();
  const refreshMe = useRefreshMe();
  const scope = useScreenScope();
  const toast = useScreenToast();
  const [pending, setPending] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const { form, alert, wait, fail } = useSchemaForm<TwoFactorSetupRequest>(
    TwoFactorSetupRequestSchema,
    { code: '' },
    ['code'],
  );

  const [startWait, startStartWait] = useCountdown();
  const setupRef = useFocusAfterWait(startWait);
  const [backToSetup, setBackToSetup] = useState(false);
  useLayoutEffect(() => {
    if (!pending) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || active.matches('h1.at-page__title'))
      form.setFocus('code');
  }, [pending, form]);
  useEffect(() => {
    if (!backToSetup) return;
    setBackToSetup(false);
    setupRef.current?.focus();
  }, [backToSetup, setupRef]);

  const alreadyOn = () => {
    setPending(null);
    refreshMe();
  };

  const start = async () => {
    alert.clear();
    setStarting(true);
    try {
      const res = await call<TwoFactorSetupResponse>(api.POST('/auth/2fa/setup', { body: {} }));
      if ('secret' in res && res.secret && res.otpauthUrl) {
        form.reset({ code: '' });
        setPending({ secret: res.secret, otpauthUrl: res.otpauthUrl });
      } else alreadyOn();
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 409) alreadyOn();
      else if (e instanceof ApiProblem && e.status === 429) {
        startStartWait(retryAfterOf(e));
        alert.show(errorText(e), errorTone(e));
      } else alert.show(errorText(e), errorTone(e));
    } finally {
      setStarting(false);
    }
  };

  const confirm = form.handleSubmit(async (body) => {
    alert.clear();
    try {
      await call<TwoFactorSetupResponse>(api.POST('/auth/2fa/setup', { body }));
      if (scope.sameSession()) setMe({ ...me, totpEnabled: true });
      setPending(null);
      form.reset({ code: '' });
      toast.done({ tone: 'ok', text: t('profile.twoFactorEnabled') });
      refreshMe();
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'INVALID_TWO_FACTOR_CODE') {
        form.setError(
          'code',
          { type: 'server', message: 'errors.INVALID_TWO_FACTOR_CODE' },
          { shouldFocus: true },
        );
      } else if (e instanceof ApiProblem && e.status === 409) alreadyOn();
      else fail(e);
    }
  });

  return (
    <Card>
      <CardHeader title={t('profile.twoFactor')}>
        <Chip tone={me.totpEnabled ? 'ok' : 'neutral'}>
          {t(me.totpEnabled ? 'profile.twoFactorOn' : 'profile.twoFactorOff')}
        </Chip>
      </CardHeader>
      {!me.totpEnabled && !pending && (
        <CardFooter>
          <Button ref={setupRef} busy={starting} disabled={startWait > 0} onClick={() => void start()}>
            {startWait > 0 ? t('auth.retryIn', { seconds: startWait }) : t('profile.setup')}
          </Button>
        </CardFooter>
      )}
      {!me.totpEnabled && pending && (
        <form noValidate onSubmit={confirm}>
          <CardBody>
            <div style={FORM_GRID}>
              <Qr value={pending.otpauthUrl} label={t('profile.qr')} />
              <CardFacts
                facts={[
                  {
                    key: 'secret',
                    term: t('profile.secret'),
                    value: <span className="at-mono">{groupSecret(pending.secret)}</span>,
                  },
                ]}
              />
              <Field id="totp-code" label={t('auth.totpCode')} error={errorOf(form, 'code')}>
                <Input
                  mono
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  {...form.register('code')}
                />
              </Field>
            </div>
          </CardBody>
          <CardFooter>
            <Submit busy={form.formState.isSubmitting} wait={wait}>
              {t('profile.enable')}
            </Submit>
            <Button
              variant="ghost"
              onClick={() => {
                setPending(null);
                form.reset({ code: '' });
                alert.clear();
                setBackToSetup(true);
              }}
            >
              {t('action.cancel')}
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
