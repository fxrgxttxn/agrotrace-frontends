/**
 * tests/db only ever runs against a throwaway database whose name ends in `_test` (`./at.sh db:test` creates
 * `agrotrace_test`): some checks commit rows (LISTEN/NOTIFY), so a dev or production database must never be
 * reachable from here, whatever DATABASE_URL / APP_DATABASE_URL the environment carries (R83).
 */
export function assertTestDatabase(url: string | undefined, variable: string): void {
  if (!url) throw new Error(`tests/db: ${variable} is not set (run ./at.sh db:test)`);
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name.endsWith('_test'))
    throw new Error(
      `tests/db refuses to run against database "${name}" (${variable}): only databases whose name ends in _test (./at.sh db:test)`,
    );
}
