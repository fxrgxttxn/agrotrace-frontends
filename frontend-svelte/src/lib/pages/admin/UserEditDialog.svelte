<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call, errorText, errorTone } from '../../app/api.svelte';
  import { userAction } from '../../app/focusRescue';
  import { DialogAlert } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import FieldSet from '../../ui/FieldSet.svelte';
  import Radio from '../../ui/Radio.svelte';
  import { FORM_GRID } from '../layout';

  type User = Schemas['User'];
  type UserStatus = Schemas['UserStatus'];

  let {
    user,
    onclose,
    ondone,
    onstale,
  }: { user: User; onclose: () => void; ondone: (u: User) => void; onstale: (text: string) => void } = $props();

  const EDITABLE: readonly UserStatus[] = ['ACTIVE', 'BLOCKED'];
  const screen = screenScope();
  let isOrgAdmin = $state(untrack(() => user.isOrgAdmin));
  let status = $state<UserStatus>(untrack(() => user.status));
  let busy = $state(false);
  const failure = new DialogAlert();
  const close = () => {
    failure.handOff();
    onclose();
  };

  async function submit() {
    const body = {
      ...(isOrgAdmin !== user.isOrgAdmin ? { isOrgAdmin } : {}),
      ...(status !== user.status && status !== 'INVITED' ? { status } : {}),
    };
    if (Object.keys(body).length === 0) {
      onclose();
      return;
    }
    busy = true;
    failure.clear();
    try {
      ondone(await call<User>(session.api.PATCH('/users/{id}', { params: { path: { id: user.id } }, body: body as never })));
    } catch (e) {
      if (!screen.alive()) return;
      if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION')
        onstale(
          t('users.stateChanged', {
            name: user.fullName,
            status: enumLabel(t, 'UserStatus', String(e.params?.from ?? '')),
          }),
        );
      else if (e instanceof ApiProblem && e.status === 404) onstale(t('users.gone', { name: user.fullName }));
      else failure.show(errorText(e), errorTone(e));
    } finally {
      busy = false;
    }
  }
</script>

<Dialog open onclose={close} title={t('users.editTitle', { name: user.fullName })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>{t('action.cancel')}</Button>
    <Button variant="primary" {busy} onclick={() => void userAction(submit)}>{t('action.save')}</Button>
  {/snippet}
  <div style={FORM_GRID}>
    <DialogMessage text={failure.message} />
    <Checkbox bind:checked={isOrgAdmin}>{t('field.isOrgAdmin')}</Checkbox>
    {#if user.status === 'INVITED'}
      <p style="margin: 0">{t('users.invitedNote')}</p>
    {:else}
      <FieldSet legend={t('users.status')}>
        {#each EDITABLE as s (s)}
          <Radio name="user-status" value={s} checked={status === s} onchange={() => (status = s)}>
            {enumLabel(t, 'UserStatus', s)}
          </Radio>
        {/each}
      </FieldSet>
    {/if}
    {#if user.status !== 'BLOCKED' && status === 'BLOCKED'}
      <p class="at-field__warning" style="margin: 0">{t('users.blockNote')}</p>
    {/if}
  </div>
</Dialog>
