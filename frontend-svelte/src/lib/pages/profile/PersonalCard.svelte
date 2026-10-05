<script lang="ts">
  import { untrack } from 'svelte';
  import type { Me } from '@agrotrace/api-client';
  import { MeUpdateSchema } from '@agrotrace/validation';
  import { call } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { form, SchemaForm } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';
  import Submit from '../../ui/Submit.svelte';
  import { toasts } from '../../ui/toast-store.svelte';
  import { FORM_GRID } from '../layout';

  let { me }: { me: Me } = $props();

  interface Values extends Record<string, unknown> {
    fullName: string;
    phone: string;
  }
  interface Wire {
    fullName: string;
    phone: string | null;
  }

  const initial = (m: Me): Values => ({ fullName: m.fullName, phone: m.phone ?? '' });
  const f = new SchemaForm<Values, Wire>({
    schema: MeUpdateSchema,
    values: untrack(() => initial(me)),
    fields: ['fullName', 'phone'],
    toWire: (v) => ({ fullName: v.fullName, phone: v.phone === '' ? null : v.phone }),
    send: async (values) => {
      const current = session.me ?? me;
      const body: Partial<Wire> = {};
      if (values.fullName !== current.fullName) body.fullName = values.fullName;
      if (values.phone !== current.phone) body.phone = values.phone;
      if (Object.keys(body).length === 0) return;
      const generation = cache.generation;
      const next = await call<Me>(session.api.PATCH('/me', { body }));
      if (!session.setMe(next, generation)) return;
      toasts.push({ tone: 'ok', text: t('profile.saved') });
      if (f.alive()) f.reset(initial(next));
    },
  });

  const facts = $derived([
    { key: 'email', term: t('field.email'), value: me.email },
    { key: 'org', term: t('auth.organization'), value: me.organization.name },
    { key: 'roles', term: t('field.roles'), value: me.roles.map((r) => t(`role.${r}`)).join(', ') },
  ]);
</script>

<Card>
  <CardHeader title={t('profile.personal')} />
  <form use:form={f} novalidate>
    <CardBody>
      <div style={FORM_GRID}>
        <CardFacts {facts} />
        <Field id="fullName" label={t('field.fullName')} error={f.error('fullName')}>
          <Input autocomplete="name" name="fullName" bind:value={f.values.fullName} />
        </Field>
        <Field id="phone" label={t('field.phone')} error={f.error('phone')}>
          <Input type="tel" inputmode="tel" autocomplete="tel" name="phone" bind:value={f.values.phone} />
        </Field>
      </div>
    </CardBody>
    <CardFooter>
      <Submit form={f}>{t('action.save')}</Submit>
    </CardFooter>
  </form>
</Card>
