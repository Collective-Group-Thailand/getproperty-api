/** Environments (contract §5). Real hosts are not decided yet (docs/PROGRESS.md) — `.invalid` is a reserved TLD. */
export const SERVERS: { url: string; description: string; host?: string }[] = [
  { url: 'http://localhost:3000', description: 'Local development (docker compose + pnpm dev)' },
  { url: 'https://{host}', description: 'Integration', host: 'integration.getproperty.invalid' },
  { url: 'https://{host}', description: 'Sandbox', host: 'sandbox.getproperty.invalid' },
  { url: 'https://{host}', description: 'Production', host: 'api.getproperty.invalid' },
];
