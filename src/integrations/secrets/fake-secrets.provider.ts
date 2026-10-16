import { type SecretsProvider } from './secrets.port';

/** In-memory secret store for tests and `pnpm dev`. */
export class FakeSecretsProvider implements SecretsProvider {
  /** `fallback`: returned for unknown ids (fake integrations that ignore their credentials). */
  constructor(
    private readonly secrets: Record<string, Record<string, string>> = {},
    private readonly fallback?: Record<string, string>,
  ) {}

  getJsonSecret(secretId: string): Promise<Record<string, string>> {
    const secret = this.secrets[secretId] ?? this.fallback;
    if (!secret) return Promise.reject(new Error(`Secret ${secretId} not found`));
    return Promise.resolve({ ...secret });
  }
}
