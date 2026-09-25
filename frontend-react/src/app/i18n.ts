import { createT } from '@agrotrace/i18n';

/** The interface language (spec §9: Russian, English prepared). Every UI string goes through `t`. */
export const t = createT('ru');
export type Translate = typeof t;
