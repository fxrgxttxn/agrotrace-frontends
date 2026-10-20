import { createT } from '@agrotrace/i18n';

/** The interface language (spec §9: Russian, English prepared): texts and formatters use it, never a literal. */
export const LOCALE = 'ru' as const;

/** Every UI string goes through `t` (templates reach it through a component field `t = t`). */
export const t = createT(LOCALE);
export type Translate = typeof t;
