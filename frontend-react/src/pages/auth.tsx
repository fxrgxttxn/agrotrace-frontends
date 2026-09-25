import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { problemMessage } from '@agrotrace/i18n';
import { t } from '../app/i18n';
import { AuthLayout } from '../app/layouts';
import { useSession } from '../app/session';
import { Button, Field, Input, useToast } from '../ui';

type LoginResponse = Schemas['LoginResponse'];

/** Field errors of a 400 VALIDATION problem (`errors: {field: [i18n key…]}`) — first message per field. */
export function fieldErrors(p: ApiProblem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, keys] of Object.entries(p.errors ?? {})) if (keys[0]) out[field] = t(keys[0]);
  return out;
}

/** `/login` — email and password; TOTP users continue on `/login/2fa`. */
export function LoginPage() {
  const { api, signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    if (!email.trim()) missing.email = t('validation.required');
    if (!password) missing.password = t('validation.required');
    setErrors(missing);
    if (Object.keys(missing).length) return;
    setBusy(true);
    try {
      const res = await api.POST('/auth/login', { body: { email: email.trim(), password } });
      if (res.error !== undefined) throw new ApiProblem(res.error as never, res.response.status);
      const data = res.data as LoginResponse;
      if (data.twoFactorRequired) {
        navigate(`/login/2fa${location.search}`, { state: { challengeId: data.challengeId } });
        return;
      }
      signIn(data);
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'VALIDATION' && err.errors) setErrors(fieldErrors(err));
      else
        toast.push({
          tone: 'danger',
          text: err instanceof ApiProblem ? problemMessage(err, t) : t('errors.BACKEND_UNAVAILABLE'),
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('page.login')} furrow art="login">
      <form noValidate onSubmit={submit} style={{ display: 'grid', gap: 'var(--sp-4)' }}>
        <Field id="email" label={t('field.email')} error={errors.email}>
          <Input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field id="password" label={t('field.password')} error={errors.password}>
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" busy={busy}>
          {t('action.login')}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function TwoFactorPage() {
  return <AuthLayout title={t('page.twoFactor')}>{null}</AuthLayout>;
}

export function PasswordForgotPage() {
  return <AuthLayout title={t('page.passwordForgot')}>{null}</AuthLayout>;
}

export function PasswordResetPage() {
  return <AuthLayout title={t('page.passwordReset')}>{null}</AuthLayout>;
}

export function RegisterPage() {
  return <AuthLayout title={t('page.register')}>{null}</AuthLayout>;
}

export function InvitePage() {
  return <AuthLayout title={t('page.invite')}>{null}</AuthLayout>;
}
