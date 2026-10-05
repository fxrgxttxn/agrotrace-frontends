<script lang="ts">
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { ComplaintDecisionSchema } from '@agrotrace/validation';
  import { call, errorTone, retryAfterOf } from '../../app/api.svelte';
  import CodeConfirmDialog from '../../app/CodeConfirmDialog.svelte';
  import { DialogAlert, form, SchemaForm, wireSchema } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import OrgPicker from '../../app/OrgPicker.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Field from '../../ui/Field.svelte';
  import FieldSet from '../../ui/FieldSet.svelte';
  import Radio from '../../ui/Radio.svelte';
  import Submit from '../../ui/Submit.svelte';
  import Textarea from '../../ui/Textarea.svelte';
  import { FORM_GRID } from '../layout';

  type Complaint = Schemas['Complaint'];
  type Decision = Schemas['ComplaintDecisionType'];
  interface DecisionValues extends Record<string, unknown> {
    decision: Decision | '';
    comment: string;
    labOrgId: string;
    blockUpstream: boolean;
  }
  const DECISIONS: readonly Decision[] = ['REJECT', 'LAB_TEST', 'RECALL'];

  let {
    complaint,
    describe,
    ondone,
  }: { complaint: Complaint; describe: (e: unknown) => string; ondone: (next: Complaint) => void } = $props();

  function toWire(v: DecisionValues) {
    if (v.decision === 'LAB_TEST') return { decision: v.decision, comment: v.comment, labOrgId: v.labOrgId };
    if (v.decision === 'RECALL') return { decision: v.decision, comment: v.comment, blockUpstream: v.blockUpstream };
    return { decision: v.decision, comment: v.comment };
  }
  const schema = wireSchema<DecisionValues>(ComplaintDecisionSchema, toWire, (v) => ({
    ...(v.decision === '' ? { decision: 'validation.required' } : {}),
    ...(v.comment.trim() === '' ? { comment: 'validation.required' } : {}),
    ...(v.decision === 'LAB_TEST' && v.labOrgId === '' ? { labOrgId: 'validation.required' } : {}),
  }));

  const screen = screenScope();
  let busy = $state(false);
  let confirming = $state<Schemas['ComplaintDecision'] | null>(null);
  const failure = new DialogAlert();
  const code = $derived(complaint.batch.publicCode);

  const f = new SchemaForm<DecisionValues, Schemas['ComplaintDecision']>({
    schema,
    values: { decision: '', comment: '', labOrgId: '', blockUpstream: false },
    fields: ['decision', 'comment', 'labOrgId', 'blockUpstream'],
    send: async (body) => {
      if (body.decision === 'RECALL') {
        failure.clear();
        confirming = body;
      } else await send(body);
    },
  });
  const submitState = {
    get busy() {
      return (busy || f.busy) && confirming === null;
    },
    wait: f.wait,
  };

  async function send(body: Schemas['ComplaintDecision']) {
    const inDialog = body.decision === 'RECALL';
    busy = true;
    failure.clear();
    f.alert.clear();
    try {
      const next = await call<Complaint>(
        session.api.POST('/complaints/{id}/decision', { params: { path: { id: complaint.id } }, body }),
      );
      confirming = null;
      ondone(next);
      screen.done({ tone: 'ok', text: t(`complaints.decided.${body.decision}`, { code }) });
    } catch (e) {
      if (!screen.alive()) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION') {
        confirming = null;
        f.fail(e);
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) f.wait.start(retryAfterOf(e));
      const text = describe(e);
      if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
        confirming = null;
        screen.push({ tone: 'danger', text });
        return;
      }
      if (inDialog) failure.show(text, errorTone(e));
      else f.alert.show(text, errorTone(e));
    } finally {
      busy = false;
    }
  }

  const decisionError = $derived(f.error('decision'));
</script>

{#snippet confirmText()}<p style="margin: 0">{t('complaints.confirmText')}</p>{/snippet}

<Card>
  <CardBody>
    <form id="complaint-decision" use:form={f} style={FORM_GRID}>
      <FieldSet legend={t('complaints.decision')} error={decisionError} errorId="decision-error">
        {#each DECISIONS as d (d)}
          <Radio
            name="decision"
            value={d}
            checked={f.values.decision === d}
            onchange={() => (f.values.decision = d)}
            aria-invalid={decisionError ? 'true' : undefined}
            aria-describedby={decisionError ? 'decision-error' : undefined}
          >
            {enumLabel(t, 'ComplaintDecisionType', d)}
          </Radio>
        {/each}
      </FieldSet>
      <Field id="decision-comment" label={t('complaints.comment')} error={f.error('comment')}>
        <Textarea rows={3} name="comment" bind:value={f.values.comment} />
      </Field>
      {#if f.values.decision === 'LAB_TEST'}
        <OrgPicker
          id="decision-lab"
          label={t('complaints.labOrg')}
          types={['LAB']}
          value={f.values.labOrgId}
          error={f.error('labOrgId')}
          onchange={(org) => {
            f.values.labOrgId = org ?? '';
            f.changed('labOrgId');
          }}
        />
      {/if}
      {#if f.values.decision === 'RECALL'}
        <Checkbox name="blockUpstream" bind:checked={f.values.blockUpstream}>{t('complaints.blockUpstream')}</Checkbox>
      {/if}
      <div>
        <Submit form={submitState} formId="complaint-decision">
          {f.values.decision ? t(`complaints.submit.${f.values.decision}`) : t('action.decide')}
        </Submit>
      </div>
    </form>
  </CardBody>
  <CodeConfirmDialog
    open={confirming !== null}
    title={t('complaints.confirmTitle', { code })}
    text={confirmText}
    {code}
    confirmLabel={t('complaints.submit.RECALL')}
    {busy}
    wait={f.wait.left}
    message={failure.message}
    onclose={() => {
      failure.handOff();
      confirming = null;
    }}
    onconfirm={() => {
      const body = confirming;
      if (body) void userAction(() => send(body));
    }}
  />
</Card>
