import { effect, signal, untracked } from '@angular/core';

export class CodeConfirm {
  readonly typed = signal('');

  constructor(open: () => boolean) {
    effect(
      () => {
        if (!open()) untracked(() => this.typed.set(''));
      },
      { allowSignalWrites: true },
    );
  }

  matches(code: string): boolean {
    return code.trim() !== '' && this.typed().trim().toUpperCase() === code.trim().toUpperCase();
  }
}

export interface CodeConfirmMarkup {
  state: string;
  open: string;
  title: string;
  code: string;
  label: string;
  busy: string;
  wait: string;
  message: string;
  close: string;
  confirm: string;
  text: string;
}

export function codeConfirmDialog(o: CodeConfirmMarkup): string {
  return `<dialog class="at-dialog" [open]="${o.open}" [dialogTitle]="${o.title}" (closed)="${o.close}">
      <div style="display: grid; gap: var(--sp-4)">
        @if (${o.message}) {
          <p class="at-field__error" role="alert" style="margin: 0">{{ ${o.message} }}</p>
        }
        ${o.text}
        <div class="at-field" [fieldId]="'confirm-code'" [label]="t('recallTasks.confirmCode')">
          <input
            class="at-input at-mono"
            autocomplete="off"
            [value]="${o.state}.typed()"
            (input)="${o.state}.typed.set($any($event.target).value)"
          />
        </div>
      </div>
      <div class="at-dialog__actions">
        <button class="at-button" [variant]="'ghost'" (click)="${o.close}">{{ t('action.cancel') }}</button>
        <button
          class="at-button"
          [variant]="'danger'"
          [busy]="${o.busy}"
          [disabled]="!${o.state}.matches(${o.code}) || ${o.wait} > 0"
          [focusAfterWait]="${o.wait}"
          (click)="${o.confirm}"
        >
          {{ ${o.wait} > 0 ? t('auth.retryIn', { seconds: ${o.wait} }) : ${o.label} }}
        </button>
      </div>
    </dialog>`;
}
