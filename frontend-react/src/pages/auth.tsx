import { useState, type ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ApiProblem,
  type LoginResponse,
  type LoginSuccess,
  type Region,
  type RegisterOrganizationResponse,
} from '@agrotrace/api-client';
import { formatLocalTime } from '@agrotrace/i18n';
import {
  AcceptInviteRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RegisterOrganizationRequestSchema,
  ResetPasswordRequestSchema,
  TwoFactorVerifyRequestSchema,
  type AcceptInviteRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type RegisterOrganizationRequest,
  type ResetPasswordRequest,
  type TwoFactorVerifyRequest,
} from '@agrotrace/validation';
import { call } from '../app/api';
import { errorOf, FORM_GRID, Submit, useSchemaForm } from '../app/forms';
import { useScreenNavigate, useScreenToast } from '../app/cache';
import { LOCALE, t } from '../app/i18n';
import { AuthLayout } from '../app/layouts';
import { useSession } from '../app/session';
import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Input,
  Page,
  Select,
} from '../ui';

const LINKS = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--sp-2)',
  justifyContent: 'space-between',
} as const;

const isProblem = (e: unknown, code: string): e is ApiProblem => e instanceof ApiProblem && e.code === code;

export function LoginPage() {
  const { api, signIn } = useSession();
  const navigate = useScreenNavigate();
  const location = useLocation();
  const { form, alert, wait, fail } = useSchemaForm<LoginRequest>(
    LoginRequestSchema,
    { email: '', password: '' },
    ['email', 'password'],
  );

  const submit = form.handleSubmit(async (body) => {
    alert.clear();
    try {
      const data = await call<LoginResponse>(api.POST('/auth/login', { body }));
      if (data.twoFactorRequired) {
        navigate(`/login/2fa${location.search}`, { state: { challengeId: data.challengeId } });
        return;
      }
      signIn(data);
    } catch (e) {
      if (isProblem(e, 'ACCOUNT_LOCKED') && typeof e.params?.lockedUntil === 'string')
        alert.show(t('auth.lockedUntil', { time: formatLocalTime(e.params.lockedUntil, LOCALE) }));
      else fail(e);
    }
  });

  return (
    <AuthLayout title={t('page.login')} furrow art="login">
      <form noValidate onSubmit={submit} style={FORM_GRID}>
        <Field id="email" label={t('field.email')} error={errorOf(form, 'email')}>
          <Input type="email" autoComplete="username" {...form.register('email')} />
        </Field>
        <Field id="password" label={t('field.password')} error={errorOf(form, 'password')}>
          <Input type="password" autoComplete="current-password" {...form.register('password')} />
        </Field>
        <Submit busy={form.formState.isSubmitting} wait={wait}>
          {t('action.login')}
        </Submit>
        <div style={LINKS}>
          <ButtonLink variant="ghost" size="s" to="/password/forgot">
            {t('auth.forgot')}
          </ButtonLink>
          <ButtonLink variant="ghost" size="s" to="/register">
            {t('auth.register')}
          </ButtonLink>
        </div>
      </form>
    </AuthLayout>
  );
}

export function TwoFactorPage() {
  const location = useLocation();
  const challengeId = (location.state as { challengeId?: unknown } | null)?.challengeId;
  if (typeof challengeId !== 'string') return <Navigate to={`/login${location.search}`} replace />;
  return <TwoFactorForm challengeId={challengeId} />;
}

function TwoFactorForm({ challengeId }: { challengeId: string }) {
  const { api, signIn } = useSession();
  const navigate = useScreenNavigate();
  const location = useLocation();
  const toast = useScreenToast();
  const { form, alert, wait, fail } = useSchemaForm<TwoFactorVerifyRequest>(
    TwoFactorVerifyRequestSchema,
    { challengeId, code: '' },
    ['code'],
  );

  const restart = () => {
    toast.push({ tone: 'danger', text: t('auth.challengeExpired') });
    navigate(`/login${location.search}`, { replace: true });
  };

  const submit = form.handleSubmit(async (body) => {
    alert.clear();
    try {
      signIn(await call<LoginSuccess>(api.POST('/auth/2fa/verify', { body })));
    } catch (e) {
      if (isProblem(e, 'INVALID_TWO_FACTOR_CODE')) {
        const left = Number(e.params?.attemptsLeft);
        if (left > 0) {
          form.setError('code', { type: 'server', message: t('auth.attemptsLeft', { count: left }) });
          form.setFocus('code');
        } else restart();
      } else if (isProblem(e, 'TOKEN_EXPIRED') || (e instanceof ApiProblem && e.errors?.challengeId))
        restart();
      else fail(e);
    }
  });

  return (
    <AuthLayout title={t('page.twoFactor')}>
      <form noValidate onSubmit={submit} style={FORM_GRID}>
        <Field id="code" label={t('auth.totpCode')} error={errorOf(form, 'code')}>
          <Input
            mono
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            {...form.register('code')}
          />
        </Field>
        <Submit busy={form.formState.isSubmitting} wait={wait}>
          {t('auth.confirm')}
        </Submit>
        <div style={LINKS}>
          <ButtonLink variant="ghost" size="s" to={`/login${location.search}`}>
            {t('auth.toLogin')}
          </ButtonLink>
        </div>
      </form>
    </AuthLayout>
  );
}

function Outcome({ text, action }: { text: string; action: ReactNode }) {
  return (
    <div style={FORM_GRID}>
      <p>{text}</p>
      <div>{action}</div>
    </div>
  );
}

export function PasswordForgotPage() {
  const { api } = useSession();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { form, alert, wait, fail } = useSchemaForm<ForgotPasswordRequest>(
    ForgotPasswordRequestSchema,
    { email: '' },
    ['email'],
  );

  const submit = form.handleSubmit(async (body) => {
    alert.clear();
    try {
      await call(api.POST('/auth/password/forgot', { body }));
      setSentTo(body.email);
    } catch (e) {
      fail(e);
    }
  });

  return (
    <AuthLayout title={t('page.passwordForgot')}>
      {sentTo !== null ? (
        <Outcome
          text={t('auth.forgotSent', { email: sentTo })}
          action={<ButtonLink to="/login">{t('auth.toLogin')}</ButtonLink>}
        />
      ) : (
        <form noValidate onSubmit={submit} style={FORM_GRID}>
          <Field id="email" label={t('field.email')} error={errorOf(form, 'email')}>
            <Input type="email" autoComplete="email" {...form.register('email')} />
          </Field>
          <Submit busy={form.formState.isSubmitting} wait={wait}>
            {t('auth.sendLink')}
          </Submit>
          <div style={LINKS}>
            <ButtonLink variant="ghost" size="s" to="/login">
              {t('auth.toLogin')}
            </ButtonLink>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}

function tokenLooksValid(token: string | undefined): token is string {
  return token !== undefined && ResetPasswordRequestSchema.shape.token.safeParse(token).success;
}

const deadToken = (e: unknown) =>
  isProblem(e, 'TOKEN_EXPIRED') || (e instanceof ApiProblem && !!e.errors?.token);

export function PasswordResetPage() {
  const { token } = useParams();
  const [dead, setDead] = useState(!tokenLooksValid(token));
  return (
    <AuthLayout title={t('page.passwordReset')}>
      {dead || !token ? (
        <Outcome
          text={t('auth.resetExpired')}
          action={<ButtonLink to="/password/forgot">{t('auth.requestNewLink')}</ButtonLink>}
        />
      ) : (
        <ResetForm token={token} onDead={() => setDead(true)} />
      )}
    </AuthLayout>
  );
}

function ResetForm({ token, onDead }: { token: string; onDead: () => void }) {
  const { api } = useSession();
  const navigate = useScreenNavigate();
  const toast = useScreenToast();
  const { form, alert, wait, fail } = useSchemaForm<ResetPasswordRequest>(
    ResetPasswordRequestSchema,
    { token, password: '' },
    ['password'],
  );

  const submit = form.handleSubmit(async (body) => {
    alert.clear();
    try {
      await call(api.POST('/auth/password/reset', { body }));
      toast.done({ tone: 'ok', text: t('auth.resetDone') });
      navigate('/login', { replace: true });
    } catch (e) {
      if (deadToken(e)) onDead();
      else fail(e);
    }
  });

  return (
    <form noValidate onSubmit={submit} style={FORM_GRID}>
      <Field id="password" label={t('auth.newPassword')} error={errorOf(form, 'password')}>
        <Input type="password" autoComplete="new-password" {...form.register('password')} />
      </Field>
      <Submit busy={form.formState.isSubmitting} wait={wait}>
        {t('auth.setPassword')}
      </Submit>
    </form>
  );
}

export function InvitePage() {
  const { token } = useParams();
  const [dead, setDead] = useState(!tokenLooksValid(token));
  const { state, signOut } = useSession();
  if (state.status === 'authenticated')
    return (
      <AuthLayout title={t('page.invite')}>
        <Outcome
          text={t('auth.inviteSignedIn', { name: state.me.fullName })}
          action={
            <Button variant="primary" icon="logout" onClick={() => void signOut(`/invite/${token ?? ''}`)}>
              {t('action.logout')}
            </Button>
          }
        />
      </AuthLayout>
    );
  return (
    <AuthLayout title={t('page.invite')}>
      {dead || !token ? (
        <Outcome
          text={t('auth.inviteExpired')}
          action={<ButtonLink to="/login">{t('auth.toLogin')}</ButtonLink>}
        />
      ) : (
        <InviteForm token={token} onDead={() => setDead(true)} />
      )}
    </AuthLayout>
  );
}

function InviteForm({ token, onDead }: { token: string; onDead: () => void }) {
  const { api } = useSession();
  const navigate = useScreenNavigate();
  const toast = useScreenToast();
  const { form, alert, wait, fail } = useSchemaForm<AcceptInviteRequest>(
    AcceptInviteRequestSchema,
    { token, fullName: '', password: '' },
    ['fullName', 'password'],
  );

  const submit = form.handleSubmit(async (body) => {
    alert.clear();
    try {
      await call(api.POST('/auth/accept-invite', { body }));
      toast.done({ tone: 'ok', text: t('auth.inviteDone') });
      navigate('/login', { replace: true });
    } catch (e) {
      if (deadToken(e)) onDead();
      else fail(e);
    }
  });

  return (
    <form noValidate onSubmit={submit} style={FORM_GRID}>
      <Field id="fullName" label={t('field.fullName')} error={errorOf(form, 'fullName')}>
        <Input autoComplete="name" {...form.register('fullName')} />
      </Field>
      <Field id="password" label={t('field.password')} error={errorOf(form, 'password')}>
        <Input type="password" autoComplete="new-password" {...form.register('password')} />
      </Field>
      <Submit busy={form.formState.isSubmitting} wait={wait}>
        {t('auth.acceptInvite')}
      </Submit>
    </form>
  );
}

const ORG_TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY'] as const;

const REGISTER_FIELDS = [
  'inn',
  'type',
  'name',
  'regionCode',
  'admin.email',
  'admin.fullName',
  'admin.password',
] as const;

export function RegisterPage() {
  const { api } = useSession();
  const [outcome, setOutcome] = useState<RegisterOrganizationResponse['status'] | null>(null);
  const regions = useQuery({
    queryKey: ['public', 'regions'],
    meta: { failed: 'auth.regionsFailed' },
    queryFn: () => call<Region[]>(api.GET('/public/regions')),
    staleTime: Infinity,
  });
  const { form, alert, wait, fail } = useSchemaForm<RegisterOrganizationRequest>(
    RegisterOrganizationRequestSchema,
    {
      inn: '',
      type: 'FARM',
      regionCode: '',
      admin: { email: '', fullName: '', password: '' },
    },
    REGISTER_FIELDS,
  );

  const submit = form.handleSubmit(async (body) => {
    alert.clear();
    try {
      const res = await call<RegisterOrganizationResponse>(api.POST('/auth/register-organization', { body }));
      setOutcome(res.status);
    } catch (e) {
      fail(e);
    }
  });

  if (outcome)
    return (
      <AuthLayout title={t('page.register')}>
        <Outcome
          text={t(outcome === 'MANUAL_CHECK' ? 'auth.registerManual' : 'auth.registerPending')}
          action={<ButtonLink to="/login">{t('auth.toLogin')}</ButtonLink>}
        />
      </AuthLayout>
    );

  const regionError = errorOf(form, 'regionCode');

  return (
    <Page title={t('page.register')} main style={{ maxWidth: '40rem' }}>
      <form noValidate onSubmit={submit} style={FORM_GRID}>
        <Card>
          <CardHeader title={t('auth.organization')} />
          <CardBody>
            <div style={FORM_GRID}>
              <Field id="inn" label={t('field.inn')} error={errorOf(form, 'inn')}>
                <Input mono inputMode="numeric" autoComplete="off" maxLength={12} {...form.register('inn')} />
              </Field>
              <Field id="type" label={t('auth.orgType')} error={errorOf(form, 'type')}>
                <Select {...form.register('type')}>
                  {ORG_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`orgType.${type}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="name" label={t('field.name')} error={errorOf(form, 'name')}>
                <Input
                  autoComplete="organization"
                  {...form.register('name', { setValueAs: (v: string) => (v === '' ? undefined : v) })}
                />
              </Field>
              <Field id="regionCode" label={t('field.regionCode')} error={regionError}>
                <Select {...form.register('regionCode')}>
                  <option value="">{t('auth.chooseRegion')}</option>
                  {regions.data?.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {regions.isError && (
                <div style={LINKS}>
                  <p role="alert">{t('auth.regionsFailed')}</p>
                  <Button size="s" busy={regions.isFetching} onClick={() => void regions.refetch()}>
                    {t('action.retry')}
                  </Button>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('auth.head')} />
          <CardBody>
            <div style={FORM_GRID}>
              <Field id="admin-email" label={t('field.email')} error={errorOf(form, 'admin.email')}>
                <Input type="email" autoComplete="email" {...form.register('admin.email')} />
              </Field>
              <Field id="admin-fullName" label={t('field.fullName')} error={errorOf(form, 'admin.fullName')}>
                <Input autoComplete="name" {...form.register('admin.fullName')} />
              </Field>
              <Field id="admin-password" label={t('field.password')} error={errorOf(form, 'admin.password')}>
                <Input type="password" autoComplete="new-password" {...form.register('admin.password')} />
              </Field>
            </div>
          </CardBody>
          <CardFooter>
            <Submit busy={form.formState.isSubmitting} wait={wait}>
              {t('action.register')}
            </Submit>
            <ButtonLink variant="ghost" to="/login">
              {t('auth.toLogin')}
            </ButtonLink>
          </CardFooter>
        </Card>
      </form>
    </Page>
  );
}
