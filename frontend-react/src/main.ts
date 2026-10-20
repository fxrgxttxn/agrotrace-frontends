import '@agrotrace/design-system/index.css';
import { applyTheme, readTheme } from './app/theme';

// Single entry of index.html (no inline script: gateway CSP `script-src 'self'`). The public QR pages (/p/*) load
// their own light chunk without any cabinet code (spec §9.6); everything else loads the cabinet.
applyTheme(readTheme());

const isPublic = location.pathname === '/p' || location.pathname.startsWith('/p/');
if (isPublic) void import('./public/main');
else void import('./app/main');
