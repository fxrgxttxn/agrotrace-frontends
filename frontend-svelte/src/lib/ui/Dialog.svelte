<script lang="ts" module>
  let counter = 0;
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../app/i18n';
  import Button from './Button.svelte';

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** `at-dialog` (README «Диалог»): `showModal()` (native focus trap and Esc), initial focus on the first focusable
   * element of the body or else on the title (`tabindex="-1"`), focus returns to the opener on close. The body is
   * rendered only while open. */
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
    /** Close request: Esc, the cross, «Отмена», or (only when `lightDismiss`) a backdrop click. */
    onclose: () => void;
    title: string;
    id?: string;
    /** Id of the title (`aria-labelledby`); generated when omitted. */
    titleId?: string;
    size?: 'l';
    /** Backdrop click closes — only for dialogs without an irreversible action (menus, previews). */
    lightDismiss?: boolean;
    /** `title`: focus the title on open even when the body has focusable elements (the «Ещё» menu). */
    initialFocus?: 'auto' | 'title';
    /** `.at-dialog__actions` content (buttons). */
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
    }
  });

  /** The title takes the focus: `tabindex="-1"` goes on right away (the markup keeps it while `titleFocus`). */
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
