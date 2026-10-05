const SKELETON = `<span class="at-skeleton" [shape]="'block'"></span>`;

export function areaLoading(blocks: 1 | 2 | 3): string {
  return `<div aria-busy="true" style="display: grid; gap: var(--sp-3)"><span class="at-visually-hidden">{{ t('shell.loading') }}</span>${blocks === 3 ? SKELETON + SKELETON + SKELETON : blocks === 2 ? SKELETON + SKELETON : SKELETON}</div>`;
}

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

export function listChanged(busy: string, reload: string): string {
  return `<article class="at-card">
      <div class="at-empty" [art]="'empty-search'" [text]="t('filters.changed')">
        <button class="at-button" [variant]="'primary'" [busy]="${busy}" (click)="${reload}">{{ t('filters.reload') }}</button>
      </div>
    </article>`;
}

export function rolesOf(roles: readonly string[] | undefined) {
  const has = (r: string) => (roles ?? []).includes(r);
  return {
    farmer: has('FARMER'),
    overseer: has('INSPECTOR') || has('ADMIN'),
    inspector: has('INSPECTOR'),
    participant: has('FARMER') || has('PROCESSOR') || has('RETAILER'),
  };
}
