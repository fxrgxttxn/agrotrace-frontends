export const AUTH_PAGE_HOST = { id: 'main', tabindex: '-1', style: 'max-width: 30rem' } as const;

export const CENTERED_ART = 'display: block; margin-inline: auto';

export const FORM_GRID = 'display: grid; gap: var(--sp-4)';

export const LINKS = 'display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: space-between';

export function submitButton(form: string, label: string): string {
  return `<button
    class="at-button"
    [type]="'submit'"
    [variant]="'primary'"
    [busy]="${form}.busy()"
    [disabled]="${form}.wait() > 0"
    [focusAfterWait]="${form}.wait()"
  >
    {{ ${form}.wait() > 0 ? t('auth.retryIn', { seconds: ${form}.wait() }) : ${label} }}
  </button>`;
}
