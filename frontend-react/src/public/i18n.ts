import ru from '@agrotrace/i18n/public/ru.json';
import { publicT } from '@agrotrace/i18n/public';

export const LOCALE = 'ru' as const;
export const t = publicT(ru, LOCALE);
