// Screens outside the cabinet shell (login, 2FA, password, registration, invite, 403/404 without a session, the
// «unavailable» screen): the routed component's host is a narrow `<main class="at-page">` (README «Страница»: the same
// page header, the content in an `at-card` below it). Only the login screen carries the furrow band.

/** Host attributes of an outside-the-shell page (`main.at-page`). */
export const AUTH_PAGE_HOST = { id: 'main', tabindex: '-1', style: 'max-width: 30rem' } as const;

/** Inline style of the illustration above the card content (centred). */
export const CENTERED_ART = 'display: block; margin-inline: auto';

/** A form's vertical rhythm (the React app's `FORM_GRID`). */
export const FORM_GRID = 'display: grid; gap: var(--sp-4)';

/** A row of small secondary links under a form (forgot password / register). */
export const LINKS = 'display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: space-between';

/** Markup of a form's submit button (the React app's `Submit`): busy while sending; during a 429 wait disabled with
 * «Повторить через N с», and it takes the focus back when the wait is over. `form` is the component's
 * {@link import('../app/forms').SchemaForm} field, `label` a template expression of the button text. */
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
