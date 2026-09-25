// Screens outside the cabinet shell (login, 2FA, password, registration, invite, 403/404 without a session, the
// «unavailable» screen): the routed component's host is a narrow `<main class="at-page">` (README «Страница»: the same
// page header, the content in an `at-card` below it). Only the login screen carries the furrow band.

/** Host attributes of an outside-the-shell page (`main.at-page`). */
export const AUTH_PAGE_HOST = { id: 'main', tabindex: '-1', style: 'max-width: 30rem' } as const;

/** Inline style of the illustration above the card content (centred). */
export const CENTERED_ART = 'display: block; margin-inline: auto';
