<script lang="ts">
  import { tick } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { LabResultsInputSchema } from '@agrotrace/validation';
  import { call, Countdown, retryAfterOf } from '../../app/api.svelte';
  import CodeConfirmDialog from '../../app/CodeConfirmDialog.svelte';
  import { applyProblem, DialogAlert } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import CellField from '../../ui/CellField.svelte';
  import Chip from '../../ui/Chip.svelte';
  import InputGroup from '../../ui/InputGroup.svelte';
  import Submit from '../../ui/Submit.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';
  import {
    decimalOf,
    exceeds,
    isNormsMismatch,
    normText,
    previewConclusion,
    STACK,
    validDecimal,
    type LabProblems,
    type LabTest,
    type Norm,
  } from './lab';

  let { test, problems, ondone }: { test: LabTest; problems: LabProblems; ondone: (next: LabTest) => void } = $props();

  const screen = screenScope();
  const norms = $derived(test.norms);
  // svelte-ignore state_referenced_locally
  let values = $state<Record<string, string>>(Object.fromEntries(test.norms.map((n) => [n.indicatorId, ''])));
  $effect.pre(() => {
    for (const n of norms) if (!(n.indicatorId in values)) values[n.indicatorId] = '';
  });
  let submitted = $state(false);
  let server = $state<Record<string, string>>({});
  let busy = $state(false);
  const wait = new Countdown();
  let confirming = $state<Record<string, string> | null>(null);
  const failure = new DialogAlert();
  let formEl = $state<HTMLFormElement | null>(null);
  const submitState = {
    get busy() {
      return busy && confirming === null;
    },
    wait,
  };
  $effect(() => () => wait.stop());

  const toBody = (v: Record<string, string>) => ({
    results: norms.map((n) => ({
      indicatorId: n.indicatorId,
      value: decimalOf(v[n.indicatorId] ?? '') ?? v[n.indicatorId] ?? '',
    })),
  });

  function check(v: Record<string, string>): Record<string, string> {
    const errs: Record<string, string> = {};
    for (const n of norms) if ((v[n.indicatorId] ?? '').trim() === '') errs[n.indicatorId] = 'validation.required';
    const res = LabResultsInputSchema.safeParse(toBody(v));
    for (const issue of res.success ? [] : res.error.issues) {
      const [head, index] = issue.path;
      const norm = head === 'results' && typeof index === 'number' ? norms[index] : undefined;
      if (norm) errs[norm.indicatorId] ??= issue.message;
    }
    return errs;
  }
  const client = $derived(submitted ? check(values) : {});
  const error = (id: string): string | null => {
    const key = server[id] ?? client[id];
    return key ? t(key) : null;
  };

  const preview = $derived(previewConclusion(norms, values));
  const covered = $derived(
    confirming !== null &&
      norms.every((n) => validDecimal(confirming![n.indicatorId] ?? '') !== null) &&
      previewConclusion(norms, confirming) === 'FAIL',
  );
  $effect(() => {
    if (!confirming || covered) return;
    failure.handOff();
    confirming = null;
  });

  // svelte-ignore state_referenced_locally
  let seenSet = test.norms.map((n) => n.indicatorId).join();
  $effect(() => {
    const normSet = norms.map((n) => n.indicatorId).join();
    if (seenSet === normSet) return;
    seenSet = normSet;
    const empty = norms.find((n) => !(values[n.indicatorId] ?? '').trim());
    if (!empty) return;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      const submit = document.querySelector('button[form="lab-results"]');
      if (
        !active ||
        active === document.body ||
        !active.isConnected ||
        active === submit ||
        active.matches('h1.at-page__title')
      )
        document.getElementById(`value-${empty.indicatorId}`)?.focus();
    }, 0);
    return () => clearTimeout(timer);
  });

  async function focusFirstInvalid() {
    await tick();
    formEl?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }

  async function send(v: Record<string, string>, inDialog = false): Promise<void> {
    problems.alert.clear();
    failure.clear();
    busy = true;
    const body = toBody(v) as Schemas['LabResultsInput'];
    try {
      const next = await call<LabTest>(
        session.api.POST('/lab-tests/{id}/results', {
          params: { path: { id: test.id }, header: { 'If-Match': test.version } },
          body,
        }),
      );
      confirming = null;
      ondone(next);
      screen.done({
        tone: 'ok',
        text:
          next.conclusion === 'FAIL'
            ? t('lab.submittedRecall', { code: next.batch.publicCode })
            : t('lab.submitted', { conclusion: enumLabel(t, 'LabConclusion', next.conclusion ?? 'PASS') }),
      });
    } catch (e) {
      if (!screen.alive()) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION' && !isNormsMismatch(e)) {
        confirming = null;
        applyProblem(e, {
          fields: norms.map((n) => n.indicatorId),
          alert: problems.alert.show,
          alias: (path) => {
            const m = /^results\[(\d+)\]\.value$/.exec(path);
            const norm = m ? norms[Number(m[1])] : undefined;
            return norm ? norm.indicatorId : path;
          },
          mark: (marks) => {
            server = marks;
            void focusFirstInvalid();
          },
        });
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
      if (!inDialog) {
        problems.fail(e);
        return;
      }
      const p = problems.describe(e);
      failure.show(p.text, p.tone);
    } finally {
      busy = false;
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || wait.left > 0) return;
    submitted = true;
    server = {};
    const snapshot = $state.snapshot(values);
    if (Object.keys(check(snapshot)).length > 0) {
      await focusFirstInvalid();
      return;
    }
    if (previewConclusion(norms, snapshot) === 'FAIL') {
      failure.clear();
      confirming = snapshot;
    } else await userAction(() => send(snapshot));
  }

  function changed(e: Event) {
    const name = (e.target as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !(name in server)) return;
    const rest = { ...server };
    delete rest[name];
    server = rest;
  }

  const columns: Column<Norm>[] = [
    { key: 'name', header: t('lab.indicator'), primary: true },
    { key: 'assessment', header: t('lab.assessment'), status: true },
    { key: 'norm', header: t('lab.norm') },
    { key: 'value', header: t('lab.value') },
  ];
</script>

{#snippet cell(n: Norm, c: Column<Norm>)}
  {#if c.key === 'name'}{n.name}{:else if c.key === 'assessment'}{@const over = exceeds(n, values[n.indicatorId] ?? '')}{#if over === true}<Chip
        tone="danger">{t('lab.exceeded')}</Chip
      >{:else if over === false}<Chip tone="ok">{t('lab.within')}</Chip>{/if}{:else if c.key === 'norm'}{normText(
      n.maxValue,
      n.unit,
    )}{:else}<CellField id="value-{n.indicatorId}" error={error(n.indicatorId)}>
      <InputGroup
        suffix={n.unit}
        name={n.indicatorId}
        inputmode="decimal"
        autocomplete="off"
        aria-label={t('lab.valueOf', { name: n.name })}
        bind:value={values[n.indicatorId]}
      />
    </CellField>{/if}
{/snippet}

{#snippet failText()}<p style="margin: 0">{t('lab.failText')}</p>{/snippet}

<Card>
  <CardHeader title={t('lab.results')} />
  <CardBody>
    <form
      id="lab-results"
      novalidate
      bind:this={formEl}
      onsubmit={(e) => void submit(e)}
      oninput={changed}
      onchange={changed}
      style={STACK}
    >
      <Table cards caption={t('lab.results')} {columns} rows={norms} rowKey={(n) => n.indicatorId} {cell} />
      <div aria-live="polite">
        {#if preview}
          <p class={preview === 'FAIL' ? 'at-field__warning' : undefined} style="margin: 0">
            {t('lab.preview', { conclusion: enumLabel(t, 'LabConclusion', preview) })}
          </p>
        {/if}
      </div>
    </form>
  </CardBody>
  <CardFooter>
    <Submit form={submitState} formId="lab-results">{t('action.submitResults')}</Submit>
  </CardFooter>
  <CodeConfirmDialog
    open={confirming !== null}
    title={t('lab.failTitle', { code: test.batch.publicCode })}
    text={failText}
    code={test.batch.publicCode}
    confirmLabel={t('lab.failSubmit')}
    fieldId="fail-code"
    fieldLabel={t('lab.failConfirm')}
    {busy}
    wait={wait.left}
    message={failure.message}
    onclose={() => {
      failure.handOff();
      confirming = null;
    }}
    onconfirm={() => {
      const v = confirming;
      if (v && covered) void userAction(() => send(v, true));
    }}
  />
</Card>
