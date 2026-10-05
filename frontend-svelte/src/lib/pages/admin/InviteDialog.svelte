<script lang="ts">
  import { untrack } from 'svelte';
  import { type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { UserInviteSchema } from '@agrotrace/validation';
  import { ROLE_OF_TYPE } from '../../app/admin';
  import { call } from '../../app/api.svelte';
  import { DialogAlert, form, SchemaForm, wireSchema } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import OrgPicker from '../../app/OrgPicker.svelte';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';
  import Submit from '../../ui/Submit.svelte';
  import { FORM_GRID } from '../layout';

  type User = Schemas['User'];
  interface InviteValues extends Record<string, unknown> {
    email: string;
    fullName: string;
    organizationId: string;
    isOrgAdmin: boolean;
  }

  let { admin, onclose, ondone }: { admin: boolean; onclose: () => void; ondone: (u: User) => void } = $props();

  const own = untrack(() => session.me!.organization.type);
  let orgType = $state(own);
  const role = $derived(ROLE_OF_TYPE[orgType]);
  const toWire = (v: InviteValues) => ({
    email: v.email.trim(),
    fullName: v.fullName.trim(),
    roles: [role],
    isOrgAdmin: v.isOrgAdmin,
    ...(admin && v.organizationId ? { organizationId: v.organizationId } : {}),
  });
  const failure = new DialogAlert();
  const close = () => {
    failure.handOff();
    onclose();
  };
  const f = new SchemaForm<InviteValues, Schemas['UserInvite']>({
    alert: failure,
    schema: wireSchema<InviteValues>(UserInviteSchema, toWire),
    values: { email: '', fullName: '', organizationId: '', isOrgAdmin: false },
    fields: ['email', 'fullName', 'organizationId', 'isOrgAdmin'],
    send: async (body) => {
      ondone(await call<User>(session.api.POST('/users', { body })));
    },
  });
</script>

<Dialog open onclose={close} title={t('users.inviteTitle')}>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>{t('action.cancel')}</Button>
    <Submit form={f} formId="invite-form">{t('action.invite')}</Submit>
  {/snippet}
  <form id="invite-form" use:form={f} style={FORM_GRID}>
    <DialogMessage text={failure.message} />
    <Field id="invite-name" label={t('field.fullName')} error={f.error('fullName')}>
      <Input autocomplete="off" name="fullName" bind:value={f.values.fullName} />
    </Field>
    <Field id="invite-email" label={t('field.email')} error={f.error('email')}>
      <Input type="email" autocomplete="off" name="email" bind:value={f.values.email} />
    </Field>
    {#if admin}
      <OrgPicker
        id="invite-org"
        label={t('users.inviteOrg')}
        value={f.values.organizationId}
        error={f.error('organizationId')}
        onchange={(id) => {
          f.values.organizationId = id ?? '';
          f.changed('organizationId');
        }}
        onorg={(org) => (orgType = org?.type ?? own)}
      />
    {/if}
    <p style="margin: 0">{t('users.inviteRole', { role: enumLabel(t, 'RoleCode', role) })}</p>
    <Checkbox name="isOrgAdmin" bind:checked={f.values.isOrgAdmin}>{t('field.isOrgAdmin')}</Checkbox>
  </form>
</Dialog>
