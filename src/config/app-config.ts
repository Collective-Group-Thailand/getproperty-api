import { DataStoresMode, type EnvironmentVariables, IntegrationsMode, NodeEnv } from './env.schema';

/**
 * Typed, read-only view of the validated environment. Built by `AppConfigModule` when Nest
 * instantiates providers — i.e. after `loadSecretsIntoEnv()` has run in the entry point.
 */
export class AppConfig {
  constructor(private readonly env: EnvironmentVariables) {}

  get<K extends keyof EnvironmentVariables>(key: K): EnvironmentVariables[K] {
    return this.env[key];
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === NodeEnv.Production;
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === NodeEnv.Test;
  }

  /** Third-party providers (S3, Secrets Manager, LINE, SMS…) are in-memory fakes. */
  get useFakes(): boolean {
    return this.env.INTEGRATIONS_MODE === IntegrationsMode.Fake;
  }

  /** Object storage can be real S3 while every other provider stays fake (local dev against a real bucket). */
  get useFakeObjectStorage(): boolean {
    return (this.env.OBJECT_STORAGE_MODE ?? this.env.INTEGRATIONS_MODE) === IntegrationsMode.Fake;
  }

  /** The PDF renderer is the deterministic fake (no browser): `PDF_RENDERER_MODE`, else `INTEGRATIONS_MODE`. */
  get useFakePdfRenderer(): boolean {
    return (this.env.PDF_RENDERER_MODE ?? this.env.INTEGRATIONS_MODE) === IntegrationsMode.Fake;
  }

  /** PostgreSQL, Redis and MQTT are in-memory fakes (no connection is ever opened). */
  get useFakeDataStores(): boolean {
    return this.env.DATA_STORES_MODE === DataStoresMode.Fake;
  }

  /** Redis (and therefore BullMQ) is the in-memory stand-in: `REDIS_MODE`, else `DATA_STORES_MODE`. */
  get useFakeRedis(): boolean {
    return (this.env.REDIS_MODE ?? this.env.DATA_STORES_MODE) === DataStoresMode.Fake;
  }

  /** The MQTT broker is the in-memory stand-in: `MQTT_MODE`, else `DATA_STORES_MODE`. */
  get useFakeMqtt(): boolean {
    return (this.env.MQTT_MODE ?? this.env.DATA_STORES_MODE) === DataStoresMode.Fake;
  }

  /**
   * Who may open `/docs*` (contract §5): everyone in development/test; in production nobody unless
   * `DOCS_ENABLED=true`, and then only callers inside `DOCS_ALLOWED_CIDRS` (platform-token access
   * arrives with auth in B1.3).
   */
  get docsAccess(): 'open' | 'allow-list' | 'off' {
    if (!this.isProduction) return 'open';
    return this.env.DOCS_ENABLED ? 'allow-list' : 'off';
  }
}
