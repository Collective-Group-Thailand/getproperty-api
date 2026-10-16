export default async function globalTeardown(): Promise<void> {
  const pg = (globalThis as { __EMBEDDED_PG__?: { stop(): Promise<void> } }).__EMBEDDED_PG__;
  if (pg) await pg.stop();
}
