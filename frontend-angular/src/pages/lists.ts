// Markup of the list / area states shared by the screens (the React app's ui/States.tsx): template-string helpers
// expanded by the AOT compiler (one return each), as `submitButton` of layout.ts.

/** Loading placeholder of an area (`aria-busy`, README «Загрузка»). */
const SKELETON = `<span class="at-skeleton" [shape]="'block'"></span>`;

export function areaLoading(blocks: 1 | 2): string {
  return `<div aria-busy="true" style="display: grid; gap: var(--sp-3)"><span class="at-visually-hidden">{{ t('shell.loading') }}</span>${blocks === 2 ? SKELETON + SKELETON : SKELETON}</div>`;
}

/** A list or card area that failed to load: what failed and one button (spec §10.1). With `resetIf` true (the server
 * rejected the list's filters, 400) the button resets them instead of retrying. Expressions are template code. */
export function loadFailed(
  text: string,
  busy: string,
  retry: string,
  resetIf = 'false',
  reset = 'null',
): string {
  return `<article class="at-card">
      @if (${resetIf}) {
        <div class="at-empty" [art]="'empty-search'" [text]="t('filters.invalid')">
          <button class="at-button" [variant]="'primary'" (click)="${reset}">{{ t('filters.reset') }}</button>
        </div>
      } @else {
        <div class="at-empty" [art]="'empty-search'" [text]="${text}">
          <button class="at-button" [variant]="'primary'" [busy]="${busy}" (click)="${retry}">{{ t('action.retry') }}</button>
        </div>
      }
    </article>`;
}

/** A page inside a list came back empty (the list changed between the count and the rows): one reload button. */
export function listChanged(busy: string, reload: string): string {
  return `<article class="at-card">
      <div class="at-empty" [art]="'empty-search'" [text]="t('filters.changed')">
        <button class="at-button" [variant]="'primary'" [busy]="${busy}" (click)="${reload}">{{ t('filters.reload') }}</button>
      </div>
    </article>`;
}

/** The viewer's roles as the screens ask for them. */
export function rolesOf(roles: readonly string[] | undefined) {
  const has = (r: string) => (roles ?? []).includes(r);
  return {
    farmer: has('FARMER'),
    overseer: has('INSPECTOR') || has('ADMIN'),
    inspector: has('INSPECTOR'),
    participant: has('FARMER') || has('PROCESSOR') || has('RETAILER'),
  };
}
