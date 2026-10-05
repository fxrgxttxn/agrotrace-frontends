import { createT } from '@agrotrace/i18n';

export const LOCALE = 'ru' as const;

export const t = createT(LOCALE);
export type Translate = typeof t;
