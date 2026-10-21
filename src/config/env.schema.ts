import { parseCidrList } from '@common/http/cidr';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/** `real` talks to AWS and third-party providers; `fake` uses the in-memory fakes (tests, `pnpm dev`, contract build). */
export enum IntegrationsMode {
  Real = 'real',
  Fake = 'fake',
}

/**
 * `real` connects to PostgreSQL, Redis and the MQTT broker; `fake` keeps every data store in memory
 * (unit/e2e tests without Docker, the contract build, `pnpm dev` on a laptop without compose).
 * B1.1 assumption (docs/PROGRESS.md): Testcontainers cannot run everywhere, so the three processes
 * must boot and answer `/health` with fakes.
 */
export enum DataStoresMode {
  Real = 'real',
  Fake = 'fake',
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
  if (['false', '0', 'no', ''].includes(value.toLowerCase())) return false;
  return value;
};

@ValidatorConstraint({ name: 'isCidrList' })
class IsCidrList implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
      parseCidrList(value);
      return true;
    } catch {
      return false;
    }
  }
}

const toNumber = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;

/**
 * Every environment variable the three processes read. Documented in `.env.example`.
 * Business values never live here — they are effective-dated settings (ADR-0004).
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: LogLevel = 'info';

  @Transform(toBoolean)
  @IsBoolean()
  LOG_PRETTY = false;

  @IsEnum(IntegrationsMode)
  INTEGRATIONS_MODE: IntegrationsMode = IntegrationsMode.Fake;

  /** Per-provider override for object storage; defaults to `INTEGRATIONS_MODE` when unset. */
  @IsOptional()
  @IsEnum(IntegrationsMode)
  OBJECT_STORAGE_MODE?: IntegrationsMode;

  /**
   * PDF renderer (D-236, D-242, ADR-0012): `fake` (deterministic, no browser), `real` (this process's own Chromium —
   * local development, and production only until getpack's `pdf-render` consumer is deployed: worker 1.5 GB), `queue`
   * (the platform's shared `pdf-render` BullMQ queue — docs/pdf-render-queue.md). Defaults to `INTEGRATIONS_MODE`
   * (`fake` / `real`). collective-infra sets it from `GETPROPERTY_PDF_RENDERER_MODE`.
   */
  @IsOptional()
  @IsIn(['fake', 'real', 'queue'])
  PDF_RENDERER_MODE?: 'fake' | 'real' | 'queue';

  @IsEnum(DataStoresMode)
  DATA_STORES_MODE: DataStoresMode = DataStoresMode.Fake;

  // --- Data stores (required when DATA_STORES_MODE=real; see validate-env.ts) -----------------------

  @IsOptional()
  @IsString()
  @Matches(/^postgres(ql)?:\/\//, { message: 'DATABASE_URL must be a postgres:// URL' })
  DATABASE_URL?: string;

  /**
   * `SET LOCAL ROLE` at the start of every tenant-scoped transaction (schema-design §4.5): set to `gp_app` when
   * the login user is a member of gp_app but not gp_app itself (e.g. local development as a superuser).
   * Empty = the login role is used as is (production logs in as a gp_app member with INHERIT).
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z_][a-z0-9_]*$/, { message: 'DATABASE_APP_ROLE must be a plain role name' })
  DATABASE_APP_ROLE?: string;

  /**
   * PostgreSQL pool size of this process (blueprint T-5): default api 10, worker 10, ingest 5; at most api 15,
   * worker 10, ingest 5 (the Collective platform's pool limits — `src/config/process-role.ts`). A `connection_limit`
   * query parameter in DATABASE_URL has no effect with the pg driver adapter: use this.
   */
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(15)
  DATABASE_POOL_MAX?: number;

  @IsOptional()
  @IsString()
  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL must be a redis:// or rediss:// URL' })
  REDIS_URL?: string;

  /** MQTT 5 broker (EMQX): `mqtt://`, `mqtts://`, `ws://` or `wss://` (D-130). */
  @IsOptional()
  @IsString()
  @Matches(/^(mqtts?|wss?):\/\//, { message: 'MQTT_URL must be an mqtt://, mqtts://, ws:// or wss:// URL' })
  MQTT_URL?: string;

  /** Development broker credentials (docker/emqx); production uses the client certificate (D-130). */
  @IsOptional()
  @IsString()
  MQTT_USERNAME?: string;

  @IsOptional()
  @IsString()
  MQTT_PASSWORD?: string;

  /** PEM files for TLS / mTLS towards the broker. */
  @IsOptional()
  @IsString()
  MQTT_TLS_CA?: string;

  @IsOptional()
  @IsString()
  MQTT_TLS_CERT?: string;

  @IsOptional()
  @IsString()
  MQTT_TLS_KEY?: string;

  /** EMQX shared-subscription group of the ingest replicas (`$share/<group>/gp/v1/+/telemetry`). */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'MQTT_SHARED_GROUP must be a plain token' })
  MQTT_SHARED_GROUP = 'ingest';

  /**
   * Use an EMQX shared subscription (`$share/<group>/…`) so ingest replicas split the load. Off for brokers without
   * shared subscriptions (e.g. the in-process test broker): then run a single ingest replica.
   */
  @Transform(toBoolean)
  @IsBoolean()
  MQTT_SHARED_SUBSCRIPTION = true;

  /** MQTT protocol version of the cloud's broker connection: 5 (EMQX, D-130) or 4 (3.1.1, test brokers). */
  @Transform(toNumber)
  @IsIn([4, 5])
  MQTT_PROTOCOL_VERSION: 4 | 5 = 5;

  /** Stable MQTT client id prefix; the process id is appended so replicas never collide. */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'MQTT_CLIENT_ID_PREFIX must be a plain token' })
  MQTT_CLIENT_ID_PREFIX = 'getproperty-api';

  // --- AWS (D-230: production runs on AWS ap-southeast-1 like getpack; LocalStack in development) -------------
  // Credentials come from the default provider chain: the ECS task role in deployments (never keys in env),
  // LocalStack's dummy keys locally.

  @IsString()
  AWS_REGION = 'ap-southeast-1';

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  AWS_ENDPOINT_URL?: string;

  @IsString()
  S3_BUCKET = 'getproperty-dev';

  @Transform(toBoolean)
  @IsBoolean()
  S3_FORCE_PATH_STYLE = false;

  /** Prepended to every object key when the bucket is shared (e.g. `getproperty/`). Empty: keys at the root. */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Za-z0-9._-]+\/)*$/, {
    message: 'S3_KEY_PREFIX: path segments ending in /, e.g. getproperty/',
  })
  S3_KEY_PREFIX?: string;

  /**
   * Secrets Manager secret (JSON object of VAR=value) loaded into the environment before validation
   * (`src/config/secrets.loader.ts`); explicit variables win. Each ECS task definition sets its own (D-230).
   */
  @IsOptional()
  @IsString()
  AWS_SECRETS_ID?: string;

  // --- HTTP ----------------------------------------------------------------------------------------

  @Transform(toBoolean)
  @IsBoolean()
  DOCS_ENABLED = false;

  /**
   * Who may open /docs* outside development/test (contract §5): comma-separated IPs/CIDRs.
   * Empty = nobody on IP alone; platform tokens are accepted from B1.3.
   */
  @IsOptional()
  @IsString()
  @Validate(IsCidrList)
  DOCS_ALLOWED_CIDRS?: string;

  /**
   * Number of trusted reverse-proxy hops in front of the API (Express `trust proxy`, counted from the right of
   * `X-Forwarded-For`); 0 = none. Behind the Application Load Balancer: 1 — the ALB is the socket peer and appends
   * the address it saw (RUNBOOK §11, D-229, D-230). Add one per extra proxy that appends (e.g. CloudFront in front).
   */
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(5)
  TRUST_PROXY = 0;

  /**
   * Where our own BFFs (getproperty-web, getproperty-liff ECS tasks) call the API from, comma-separated IPs/CIDRs —
   * the VPC's private app subnets, since they reach the API through the internal ALB: a hop from there is trusted
   * too, so the end user's address the BFF forwards is `req.ip` (per-IP auth throttling, e-sign evidence). Empty =
   * none (D-229, D-230).
   */
  @IsOptional()
  @IsString()
  @Validate(IsCidrList)
  TRUSTED_PROXY_CIDRS?: string;

  /**
   * Who may read the API's `GET /metrics` (by `req.ip`, comma-separated IPs/CIDRs). Empty = loopback and the private
   * ranges, i.e. Grafana Alloy on the platform's docker network; a request through Caddy carries the public client
   * address and gets 404 (D-230).
   */
  @IsOptional()
  @IsString()
  @Validate(IsCidrList)
  METRICS_ALLOWED_CIDRS?: string;

  /** Port of the worker process's `/health` + `/metrics` server (the platform's image contract: 3001; D-230). */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(65535)
  WORKER_HEALTH_PORT = 3001;

  /** Port of the ingest process's `/health` + `/metrics` server (3002, D-230). */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(65535)
  INGEST_HEALTH_PORT = 3002;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  THROTTLE_TTL_SECONDS = 60;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT = 300;

  /** Public origin of this API (absolute links in documents and LINE messages); no trailing slash. */
  @Matches(/^https?:\/\/[^/]+$/, {
    message: 'PUBLIC_API_BASE_URL must be an origin without a trailing slash',
  })
  PUBLIC_API_BASE_URL = 'http://localhost:3000';

  // --- Observability -------------------------------------------------------------------------------

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  SENTRY_DSN?: string;

  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  @Max(1)
  SENTRY_TRACES_SAMPLE_RATE = 0;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;

  @IsString()
  OTEL_SERVICE_NAME = 'getproperty-api';

  /**
   * AES-256-GCM key (base64, 32 bytes) for secrets stored in the database (national ids, TOTP secrets, D-025).
   * Required in production; development and tests derive a per-process key.
   */
  @IsOptional()
  @IsString()
  FIELD_ENCRYPTION_KEY?: string;

  /**
   * HMAC key for lookup hashes (`*_hash` columns: phones, id numbers, bank accounts — D-148, schema-design §4.7).
   * Required in production; development and tests use a fixed development key (hashes must survive restarts).
   */
  @IsOptional()
  @IsString()
  FIELD_HASH_KEY?: string;

  /** Overrides DATA_STORES_MODE for Redis only (fake | real) — e.g. a real database with in-memory Redis in tests. */
  @IsOptional()
  @IsEnum(DataStoresMode)
  REDIS_MODE?: DataStoresMode;

  /** Overrides DATA_STORES_MODE for the MQTT broker only (fake | real). */
  @IsOptional()
  @IsEnum(DataStoresMode)
  MQTT_MODE?: DataStoresMode;

  /**
   * `SET LOCAL ROLE` for platform transactions (identity lookups, `/v1/admin`, relays, cross-tenant jobs —
   * schema-design §4.5): `gp_platform` when the login is a member of it; empty = the login role as is.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z_][a-z0-9_]*$/, { message: 'DATABASE_PLATFORM_ROLE must be a plain role name' })
  DATABASE_PLATFORM_ROLE?: string;

  // --- Auth (contract §4, ADR-0003) ------------------------------------------------------------------

  /**
   * Ed25519 private key (PKCS#8 PEM, or base64 of the PEM) that signs access tokens (EdDSA). Required in
   * production; elsewhere a key is generated per process (tokens do not survive a restart).
   */
  @IsOptional()
  @IsString()
  AUTH_JWT_PRIVATE_KEY?: string;

  /** Key id (`kid`) of AUTH_JWT_PRIVATE_KEY, published in the JWKS. */
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,64}$/, { message: 'AUTH_JWT_KID must be a plain token' })
  AUTH_JWT_KID = 'gp-dev-1';

  /** Previous public keys still accepted during a rotation: JSON `[{"kid":"…","publicKeyPem":"…"}]`. */
  @IsOptional()
  @IsString()
  AUTH_JWT_PREVIOUS_KEYS?: string;

  /** Access token lifetime (contract §4: 10–15 min). */
  @Transform(toNumber)
  @IsInt()
  @Min(60)
  @Max(900)
  ACCESS_TOKEN_TTL_SECONDS = 900;

  /** Refresh token family lifetime for operators, residents and technicians. */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(180)
  REFRESH_TOKEN_TTL_DAYS = 30;

  /**
   * Grace window of refresh-token rotation (review LIFF M3, D-229): presenting the immediately previous refresh token
   * again within this many seconds of its rotation answers the same successor refresh token (and a fresh access token)
   * instead of revoking the family — two BFF instances refreshing at once must not sign the user out. 0 = off.
   */
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(60)
  REFRESH_REUSE_GRACE_SECONDS = 30;

  /** Refresh token family lifetime for platform staff (shorter: TOTP-protected admin surface). */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(72)
  PLATFORM_REFRESH_TOKEN_TTL_HOURS = 12;

  /** Device JWT lifetime (minted at bootstrap, refreshed with the device refresh token). */
  @Transform(toNumber)
  @IsInt()
  @Min(300)
  @Max(86400)
  DEVICE_ACCESS_TOKEN_TTL_SECONDS = 3600;

  /** Device refresh token lifetime (the certificate lives 12 months; the agent re-bootstraps on expiry). */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(400)
  DEVICE_REFRESH_TOKEN_TTL_DAYS = 365;

  /** SMS OTP: lifetime of a code, attempts per challenge, resend interval and hourly cap per phone and purpose. */
  @Transform(toNumber)
  @IsInt()
  @Min(60)
  @Max(900)
  OTP_TTL_SECONDS = 300;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(10)
  OTP_MAX_ATTEMPTS = 5;

  @Transform(toNumber)
  @IsInt()
  @Min(10)
  @Max(600)
  OTP_RESEND_SECONDS = 60;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(20)
  OTP_MAX_PER_HOUR = 5;

  /** Failed password logins before the credential is locked, and for how long. */
  @Transform(toNumber)
  @IsInt()
  @Min(3)
  @Max(20)
  LOGIN_MAX_FAILURES = 5;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(1440)
  LOGIN_LOCK_MINUTES = 15;

  // --- LINE (D-060, D-154) ----------------------------------------------------------------------------

  /** LINE Login channel ids whose id tokens are accepted (`aud`): the resident LIFF and technician LIFF channels. */
  @IsOptional()
  @IsString()
  LINE_LOGIN_CHANNEL_IDS?: string;

  /** LINE Messaging API channel access token (push messages, Flex). */
  @IsOptional()
  @IsString()
  LINE_MESSAGING_ACCESS_TOKEN?: string;

  // --- SMS OTP provider (ThaiBulkSMS-class) -------------------------------------------------------------

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  SMS_API_URL?: string;

  @IsOptional()
  @IsString()
  SMS_API_KEY?: string;

  @IsOptional()
  @IsString()
  SMS_API_SECRET?: string;

  /** Sender name registered with the provider. */
  @IsString()
  @Matches(/^[A-Za-z0-9 .-]{1,11}$/, { message: 'SMS_SENDER: up to 11 letters/digits' })
  SMS_SENDER = 'getproperty';

  // --- PDF rendering (Puppeteer, contracts and statements; master plan §3) ---------------------------------

  /** Chromium/Chrome binary for puppeteer-core; required when the PDF renderer is real. */
  @IsOptional()
  @IsString()
  PDF_CHROMIUM_EXECUTABLE?: string;

  @Transform(toNumber)
  @IsInt()
  @Min(1_000)
  @Max(120_000)
  PDF_RENDER_TIMEOUT_MS = 30_000;

  /**
   * `PDF_RENDERER_MODE=queue`: the Valkey of the shared `pdf-render` queue (the platform's shared-queue logical DB —
   * docs/pdf-render-queue.md); empty = REDIS_URL.
   */
  @IsOptional()
  @IsString()
  @Matches(/^rediss?:\/\//, { message: 'PDF_RENDER_REDIS_URL must be a redis:// or rediss:// URL' })
  PDF_RENDER_REDIS_URL?: string;

  /** BullMQ key prefix of the shared queue (the same for every producer and the consumer). */
  @IsString()
  @Matches(/^[a-z][a-z0-9_-]{0,31}$/, { message: 'PDF_RENDER_QUEUE_PREFIX must be a plain token' })
  PDF_RENDER_QUEUE_PREFIX = 'collective';

  /** How long a producer waits for a queued render (queueing + retries) before the subscriber retries later. */
  @Transform(toNumber)
  @IsInt()
  @Min(5_000)
  @Max(600_000)
  PDF_RENDER_QUEUE_TIMEOUT_MS = 120_000;

  // --- Payments (B4.4, D-042; real adapters behind the payments.provider.* flags — O-001) -------------------

  @IsUrl({ require_tld: false })
  PAYMENTS_SCB_BASE_URL = 'https://api-sandbox.partners.scb';

  @IsUrl({ require_tld: false })
  PAYMENTS_KBANK_BASE_URL = 'https://openapi-sandbox.kasikornbank.com';

  @IsUrl({ require_tld: false })
  PAYMENTS_OPN_BASE_URL = 'https://api.omise.co';

  /**
   * D-240 (O-013): provider credentials live in `platform.provider_credential`. `true` = while migrating, a credential
   * without a row is still read from its former Secrets Manager path (the `*_SECRETS_PREFIX` below); default off.
   */
  @Transform(toBoolean)
  @IsBoolean()
  PROVIDER_CREDENTIALS_LEGACY_SECRETS = false;

  /**
   * Legacy (D-240: migration only) prefix of the per-merchant secret ids (`<prefix>/<provider>/<merchantRef>`).
   */
  @IsString()
  PAYMENTS_SECRETS_PREFIX = 'getproperty/payments';

  /** Lifetime of a dynamic Thai QR (minutes). */
  @Transform(toNumber)
  @IsInt()
  @Min(5)
  @Max(60 * 24 * 60)
  PAYMENTS_QR_TTL_MINUTES = 60 * 24 * 45;

  @IsUrl({ require_tld: false })
  SLIP_VERIFY_BASE_URL = 'https://developer.easyslip.com';

  /** Slip verification API key; the fake verifier is used while unset or in fake mode. */
  @IsOptional()
  @IsString()
  SLIP_VERIFY_API_KEY?: string;

  // --- Smart locks (B5.2, D-070; real adapters behind the locks.vendor.* flags) --------------------------

  /** TTLock Open Platform (EU cloud by default; the account's region decides). */
  @IsUrl({ require_tld: false })
  LOCKS_TTLOCK_BASE_URL = 'https://euapi.ttlock.com';

  /** Tuya OpenAPI data centre of the tenant's cloud project. */
  @IsUrl({ require_tld: false })
  LOCKS_TUYA_BASE_URL = 'https://openapi-sg.iotbing.com';

  /** Prefix of the per-tenant vendor secrets (`<prefix>/<vendor>/<tenantId>`): API keys, account. */
  @IsString()
  LOCKS_SECRETS_PREFIX = 'getproperty/locks';

  // --- e-Tax service providers (B6.2, D-215; real adapters only with INTEGRATIONS_MODE=real) -------------

  /** INET One e-Tax web service (`etaxdocumentws`); UAT and production hosts differ. */
  @IsUrl({ require_tld: false })
  ETAX_INET_BASE_URL = 'https://service-etax.one.th/etaxdocumentws';

  /** Prefix of the per-tenant provider account secrets (`<prefix>/<provider>/<tenantId>`). */
  @IsString()
  ETAX_SECRETS_PREFIX = 'getproperty/etax';

  // --- Email (SES v2) -----------------------------------------------------------------------------------

  /** Verified SES sender (the product SES identity in collective-infra, D-230); same name as getpack's. */
  @IsString()
  SES_FROM_ADDRESS = 'getproperty <no-reply@getproperty.co>';

  // --- Web push (VAPID) ---------------------------------------------------------------------------------

  @IsOptional()
  @IsString()
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;

  @IsOptional()
  @IsString()
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;

  @IsString()
  WEB_PUSH_SUBJECT = 'mailto:dev@getproperty.co';

  // --- Devices (D-130) ----------------------------------------------------------------------------------

  /**
   * Platform device CA (PEM certificate and PKCS#8 private key, or base64 of the PEM) that signs gateway CSRs. Required
   * in production. Source: the platform-owned Secrets Manager secret `collective/<env>/platform/device-ca` (keys
   * `DEVICE_CA_CERT`, `DEVICE_CA_KEY`, `DEVICE_CA_CHAIN`), rendered by the box into the env file (D-235, T-6).
   */
  @IsOptional()
  @IsString()
  DEVICE_CA_CERT?: string;

  @IsOptional()
  @IsString()
  DEVICE_CA_KEY?: string;

  /**
   * The chain gateways receive as `caChainPem` (bootstrap, renewal) — the issuing CA first, then its issuers (PEM
   * bundle or base64 of it); must contain DEVICE_CA_CERT. Unset: the issuing CA alone (T-6).
   */
  @IsOptional()
  @IsString()
  DEVICE_CA_CHAIN?: string;

  /** Gateway certificate lifetime (device protocol §1: rotate every 12 months). */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(825)
  DEVICE_CERT_VALIDITY_DAYS = 365;

  /** Broker URL handed to gateways at bootstrap (mqtts://… in production). */
  @IsString()
  @Matches(/^(mqtts?|wss?):\/\//, { message: 'MQTT_PUBLIC_URL must be an mqtt(s):// or ws(s):// URL' })
  MQTT_PUBLIC_URL = 'mqtts://mqtt.getproperty.invalid:8883';

  /**
   * OTA manifest signing keys trusted by the API (JSON object `{ "<keyId>": "<base64 raw ed25519 public key>" }`);
   * a release whose manifest signature does not verify against one of them is refused (D-131, edge CR-011).
   */
  @IsOptional()
  @IsString()
  OTA_SIGNING_PUBLIC_KEYS?: string;

  /**
   * WebSocket broker URL for buildings whose network blocks 8883 (device protocol §1: WSS on 443). **Unset** (the
   * default): the bootstrap answer carries no `mqtt.wsUrl` — the Collective platform has no WSS endpoint that sees the
   * gateway certificate while O-012 is open (D-231, edge CR-013). Setting it is the explicit switch that sends it.
   */
  @IsOptional()
  @IsString()
  @Matches(/^(wss?:\/\/\S+)?$/, { message: 'MQTT_PUBLIC_WS_URL must be a ws(s):// URL or empty' })
  MQTT_PUBLIC_WS_URL?: string;

  /**
   * Origin of the device host (Caddy `DEVICE_HOST`, gateway client certificates — D-230), no trailing slash. URLs the
   * API hands to gateways (`ota_apply.manifestUrl`) are built on it; empty (the default) → they are relative
   * `/v1/device/…` paths, which the agent resolves against its own device host (protocol §6, D-231, edge CR-012).
   * Never the public API host: it strips the certificate header.
   */
  @IsOptional()
  @IsString()
  @Matches(/^(https?:\/\/[^/\s]+)?$/, {
    message: 'DEVICE_PUBLIC_BASE_URL must be an origin without a trailing slash, or empty',
  })
  DEVICE_PUBLIC_BASE_URL?: string;

  /**
   * Where the gateway's mTLS client certificate comes from on `/v1/device/*` (CR-002): `socket` = this process
   * terminates TLS and requests client certificates; `pem_header` = a trusted proxy forwards the URL-encoded PEM in
   * DEVICE_MTLS_HEADER (nginx `$ssl_client_escaped_cert`, Envoy); `sha256_header` = the proxy forwards the
   * certificate's SHA-256 fingerprint (hex or base64). On AWS (D-230) the device ALB verifies the chain against the
   * device CA trust store and forwards the leaf as URL-encoded PEM in `X-Amzn-Mtls-Clientcert-Leaf`: `pem_header`
   * with DEVICE_MTLS_HEADER=x-amzn-mtls-clientcert-leaf. Header modes trust the header: the API must only be
   * reachable through that proxy.
   */
  @IsIn(['socket', 'pem_header', 'sha256_header'])
  DEVICE_MTLS_SOURCE: 'socket' | 'pem_header' | 'sha256_header' = 'socket';

  /** Request header carrying the forwarded client certificate (pem_header / sha256_header). */
  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'DEVICE_MTLS_HEADER must be a lower-case header name' })
  DEVICE_MTLS_HEADER = 'x-client-cert';

  // --- EMQX HTTP authn / authz (D-235, T-7; collective-infra platform/docker-compose.yml) -------------------------

  /**
   * Shared secret EMQX sends in `x-emqx-auth-token` on `POST /internal/emqx/authn|authz` (collective-infra renders
   * `platform/emqx` `getproperty_auth_token` into both sides). **Empty = every request is refused** (the broker then
   * lets no gateway in — fail closed).
   */
  @IsOptional()
  @IsString()
  EMQX_AUTH_TOKEN?: string;

  /** Who may call `/internal/emqx/*` (by `req.ip`, comma-separated IPs/CIDRs). Empty = loopback + private ranges. */
  @IsOptional()
  @IsString()
  @Validate(IsCidrList)
  EMQX_HTTP_ALLOWED_CIDRS?: string;

  /**
   * getproperty's service users on EMQX's internal listener (comma-separated): authz allows them below `gp/v1/`
   * (shared subscriptions included). Empty = MQTT_USERNAME.
   */
  @IsOptional()
  @IsString()
  EMQX_SERVICE_USERNAMES?: string;

  /**
   * Requests per minute EMQX may send to `/internal/emqx/*` (one client: the broker). 300 gateways × 6 topics with a
   * 1-minute authz cache, plus a fleet reconnect burst, stay well below the default.
   */
  @Transform(toNumber)
  @IsInt()
  @Min(60)
  @Max(600_000)
  EMQX_HTTP_RATE_LIMIT = 6000;

  // --- AI gateway (D-161) ----------------------------------------------------------------------------------

  /** Collective AI gateway base URL (vision OCR of meter photos and utility invoices); empty = OCR unavailable. */
  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/[^\s]+$/, { message: 'AI_GATEWAY_URL must be an http(s) URL' })
  AI_GATEWAY_URL?: string;

  @IsOptional()
  @IsString()
  AI_GATEWAY_API_KEY?: string;

  /** Vision model name requested from the gateway. */
  @IsString()
  AI_VISION_MODEL = 'vision-default';

  @Transform(toNumber)
  @IsInt()
  @Min(1000)
  @Max(120000)
  AI_GATEWAY_TIMEOUT_MS = 30000;

  // --- Files ----------------------------------------------------------------------------------------------

  /** ClamAV daemon (INSTREAM) for the virus-scan port; empty with INTEGRATIONS_MODE=real = scans fail closed. */
  @IsOptional()
  @IsString()
  CLAMAV_HOST?: string;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(65535)
  CLAMAV_PORT = 3310;

  // --- Front-end origins (links in SMS, LINE and email) ----------------------------------------------

  @Matches(/^https?:\/\/[^/]+$/, { message: 'PUBLIC_WEB_APP_URL must be an origin without a trailing slash' })
  PUBLIC_WEB_APP_URL = 'http://localhost:3001';

  /** Staff PWA origin of getproperty-web (`STAFF_HOST`): invitations of the Staff role link here. */
  @Matches(/^https?:\/\/[^/]+$/, {
    message: 'PUBLIC_STAFF_APP_URL must be an origin without a trailing slash',
  })
  PUBLIC_STAFF_APP_URL = 'http://staff.localhost:3001';

  /** getproperty-liff origin (its dev server listens on 3300). */
  @Matches(/^https?:\/\/[^/]+$/, {
    message: 'PUBLIC_RESIDENT_APP_URL must be an origin without a trailing slash',
  })
  PUBLIC_RESIDENT_APP_URL = 'http://localhost:3300';

  /** Git commit of the running build (set by the image build); shown by `admin.system.info`. */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{7,40}$/i, { message: 'GIT_COMMIT must be a hex commit id' })
  GIT_COMMIT?: string;
}
