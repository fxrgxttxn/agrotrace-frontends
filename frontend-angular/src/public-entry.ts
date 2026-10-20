// How the shared entry (src/main.ts) loads the public QR page. Here (development, tests): the public app from source.
// The production and mock builds replace this file (angular.json fileReplacements) with public-entry.build.ts, which
// scripts/build.mjs writes after building the public page as its own application (spec §9.6: its own Angular, no
// cabinet code, ≤ 60 KB JS gzip — scripts/public-budget.mjs) — then this is an import of that build's main file.
export const loadPublic = (): Promise<unknown> => import('./public/main');
