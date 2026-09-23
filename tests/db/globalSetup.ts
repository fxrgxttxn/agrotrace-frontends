export default async function setup() {
  return async function teardown() {
    const { appPool, ownerPool } = await import('./helpers');
    await appPool.end();
    await ownerPool.end();
  };
}
