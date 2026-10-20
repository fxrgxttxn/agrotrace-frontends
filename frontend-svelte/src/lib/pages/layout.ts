// Inline layout of the screens (the design system has no layout utilities; the same values as the React screens).

/** A form or a card body: controls one under another. */
export const FORM_GRID = 'display: grid; gap: var(--sp-4)';

/** Secondary links under a form (forgot password, registration, back to login). */
export const LINKS = 'display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: space-between';

/** Cards of the profile: as many columns as fit (24rem each), one on a phone. */
export const CARD_GRID =
  'display: grid; gap: var(--sp-6); grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr)); align-items: start';

/** Items in a row that wraps. */
export const ROW = 'display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center';
