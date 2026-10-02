import ru from '@agrotrace/i18n/public/ru.json';
import { publicT } from '@agrotrace/i18n/public';

// Ruling FM35: the public page has only its own keys, of the active locale (never `@agrotrace/i18n` itself).
export const LOCALE = 'ru' as const;
export const t = publicT(ru, LOCALE);
