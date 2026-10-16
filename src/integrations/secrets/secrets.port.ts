export const SECRETS_PROVIDER = Symbol('SECRETS_PROVIDER');

/** Reads a JSON secret (key → string value) from the secret store. */
export interface SecretsProvider {
  getJsonSecret(secretId: string): Promise<Record<string, string>>;
}
