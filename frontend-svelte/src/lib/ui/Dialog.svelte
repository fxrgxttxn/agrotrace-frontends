<script lang="ts" module>
  let counter = 0;
</script>

<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import { t } from '../app/i18n';
  import Button from './Button.svelte';

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let {
    open,
    onclose,
    title,
    id,
    titleId,
    size,
    lightDismiss = false,
    initialFocus = 'auto',
    actions,
    children,
  }: {
    open: boolean;
    onclose: () => void;
    title: string;
    id?: string;
    titleId?: string;
    size?: 'l';
    lightDismiss?: boolean;
    initialFocus?: 'auto' | 'title';
    actions?: Snippet;
    children?: Snippet;
  } = $props();

  const autoId = `dialog-${++counter}-title`;
  const labelledBy = $derived(titleId ?? autoId);
  let dialog: HTMLDialogElement | null = $state(null);
  let body: HTMLDivElement | null = $state(null);
  let heading: HTMLHeadingElement | null = $state(null);
  let opener: HTMLElement | null = null;
  // svelte-ignore state_referenced_locally
  let titleFocus = $state(initialFocus === 'title');

  $effect(() => {
    const d = dialog;
    if (!d) return;
    if (open && !d.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      const first = body?.querySelector<HTMLElement>(FOCUSABLE);
      if (initialFocus === 'title') {
        titleFocus = true;
        focusTitle();
      } else if (first) {
        titleFocus = false;
        first.focus();
      } else {
        titleFocus = true;
        focusTitle();
      }
    } else if (!open && d.open) {
      d.close();
      closed();
    }
  });

  function focusTitle() {
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
  }

  function cancel(e: Event) {
    e.preventDefault();
    onclose();
  }

  function closed() {
    const back = opener;
    opener = null;
    if (back && back.isConnected) back.focus();
  }

  onDestroy(() => {
    const back = opener;
    if (!back) return;
    opener = null;
    const d = dialog;
    const active = document.activeElement;
    const held = active === null || active === document.body || (d?.contains(active) ?? false);
    if (d?.open) d.close();
    if (!held) return;
    queueMicrotask(() => {
      const now = document.activeElement;
      if (back.isConnected && (now === null || now === document.body || !now.isConnected)) back.focus();
    });
  });
</script>

<dialog
  bind:this={dialog}
  class="at-dialog"
  {id}
  aria-labelledby={labelledBy}
  data-size={size}
  oncancel={cancel}
  onclose={closed}
  onclick={(e) => {
    if (lightDismiss && e.target === e.currentTarget) onclose();
  }}
>
  <div class="at-dialog__header">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <h2 bind:this={heading} class="at-dialog__title" id={labelledBy} tabindex={titleFocus ? -1 : undefined}>{title}</h2>
    <Button variant="ghost" iconOnly icon="close" aria-label={t('shell.close')} onclick={onclose} />
  </div>
  <div class="at-dialog__body" bind:this={body}>
    {#if open}{@render children?.()}{/if}
  </div>
  {#if actions}
    <div class="at-dialog__actions">{@render actions()}</div>
  {/if}
</dialog>
