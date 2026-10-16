import {
  FAKE_TEST_ENV,
  realDataStoresRequested,
  startTestInfra,
  type TestInfra,
} from '../support/containers';

declare global {
  var __GETPROPERTY_E2E_INFRA__: TestInfra | undefined;
}

/**
 * Prepares the environment of the e2e run once. With `DATA_STORES_MODE=real` it starts TimescaleDB,
 * Redis and EMQX in Testcontainers (CI job `e2e-real`); otherwise (default, and CI job `e2e`) the
 * stores are in-memory fakes and nothing is started. Migrations arrive with the schema in B1.2.
 */
export default async function globalSetup(): Promise<void> {
  if (!realDataStoresRequested()) {
    Object.assign(process.env, FAKE_TEST_ENV);
    return;
  }
  const infra = await startTestInfra();
  globalThis.__GETPROPERTY_E2E_INFRA__ = infra;
  Object.assign(process.env, infra.env);
}
