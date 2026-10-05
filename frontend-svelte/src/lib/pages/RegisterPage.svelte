<script lang="ts">
  import type { Region, RegisterOrganizationResponse } from '@agrotrace/api-client';
  import { RegisterOrganizationRequestSchema, type RegisterOrganizationRequest } from '@agrotrace/validation';
  import { call } from '../app/api.svelte';
  import { FOREVER, query } from '../app/cache.svelte';
  import { form, SchemaForm } from '../app/forms.svelte';
  import { t } from '../app/i18n';
  import { userAction } from '../app/focusRescue';
  import { session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import CardBody from '../ui/CardBody.svelte';
  import CardFooter from '../ui/CardFooter.svelte';
  import CardHeader from '../ui/CardHeader.svelte';
  import Field from '../ui/Field.svelte';
  import Input from '../ui/Input.svelte';
  import Page from '../ui/Page.svelte';
  import Select from '../ui/Select.svelte';
  import Submit from '../ui/Submit.svelte';
  import AuthLayout from './AuthLayout.svelte';
  import { FORM_GRID, LINKS } from './layout';
  import Outcome from './Outcome.svelte';

  const ORG_TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY'] as const;

  let outcome = $state<RegisterOrganizationResponse['status'] | null>(null);

  const regions = query(
    () => ['public', 'regions'],
    () => call<Region[]>(session.api.GET('/public/regions')),
    { freshMs: FOREVER, failed: 'auth.regionsFailed' },
  );

  type Values = Omit<RegisterOrganizationRequest, 'name'> & { name: string };

  const f = new SchemaForm<Values, RegisterOrganizationRequest>({
    schema: RegisterOrganizationRequestSchema,
    values: { inn: '', type: 'FARM', name: '', regionCode: '', admin: { email: '', fullName: '', password: '' } },
    fields: ['inn', 'type', 'name', 'regionCode', 'admin.email', 'admin.fullName', 'admin.password'],
    toWire: ({ name, ...rest }) => (name === '' ? rest : { ...rest, name }),
    send: async (body) => {
      const res = await call<RegisterOrganizationResponse>(session.api.POST('/auth/register-organization', { body }));
      outcome = res.status;
    },
  });
</script>

{#if outcome}
  <AuthLayout title={t('page.register')}>
    <Outcome text={t(outcome === 'MANUAL_CHECK' ? 'auth.registerManual' : 'auth.registerPending')}>
      {#snippet action()}<Button href="/login">{t('auth.toLogin')}</Button>{/snippet}
    </Outcome>
  </AuthLayout>
{:else}
  <Page title={t('page.register')} main style="max-width: 40rem">
    <form use:form={f} novalidate style={FORM_GRID}>
      <Card>
        <CardHeader title={t('auth.organization')} />
        <CardBody>
          <div style={FORM_GRID}>
            <Field id="inn" label={t('field.inn')} error={f.error('inn')}>
              <Input mono inputmode="numeric" autocomplete="off" maxlength={12} name="inn" bind:value={f.values.inn} />
            </Field>
            <Field id="type" label={t('auth.orgType')} error={f.error('type')}>
              <Select name="type" bind:value={f.values.type}>
                {#each ORG_TYPES as type (type)}
                  <option value={type}>{t(`orgType.${type}`)}</option>
                {/each}
              </Select>
            </Field>
            <Field id="name" label={t('field.name')} error={f.error('name')}>
              <Input autocomplete="organization" name="name" bind:value={f.values.name} />
            </Field>
            <Field id="regionCode" label={t('field.regionCode')} error={f.error('regionCode')}>
              <Select name="regionCode" bind:value={f.values.regionCode}>
                <option value="">{t('auth.chooseRegion')}</option>
                {#each regions.data ?? [] as r (r.code)}
                  <option value={r.code}>{r.name}</option>
                {/each}
              </Select>
            </Field>
            {#if regions.failed}
              <div style={LINKS}>
                <p role="alert">{t('auth.regionsFailed')}</p>
                <Button size="s" busy={regions.fetching} onclick={() => void userAction(regions.refetch)}
                  >{t('action.retry')}</Button
                >
              </div>
            {/if}
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('auth.head')} />
        <CardBody>
          <div style={FORM_GRID}>
            <Field id="admin-email" label={t('field.email')} error={f.error('admin.email')}>
              <Input type="email" autocomplete="email" name="admin.email" bind:value={f.values.admin.email} />
            </Field>
            <Field id="admin-fullName" label={t('field.fullName')} error={f.error('admin.fullName')}>
              <Input autocomplete="name" name="admin.fullName" bind:value={f.values.admin.fullName} />
            </Field>
            <Field id="admin-password" label={t('field.password')} error={f.error('admin.password')}>
              <Input
                type="password"
                autocomplete="new-password"
                name="admin.password"
                bind:value={f.values.admin.password}
              />
            </Field>
          </div>
        </CardBody>
        <CardFooter>
          <Submit form={f}>{t('action.register')}</Submit>
          <Button variant="ghost" href="/login">{t('auth.toLogin')}</Button>
        </CardFooter>
      </Card>
    </form>
  </Page>
{/if}
