/** Mock mode hook (ruling FM23): the production build answers /api/v1 from the real backend — nothing to start.
 * The `mock` configuration (angular.json, `./at.sh fe:build angular --mock`) replaces this file with mock.mock.ts. */
export function startMock(): Promise<void> {
  return Promise.resolve();
}
