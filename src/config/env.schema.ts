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

  /** Per-provider override for the PDF renderer (Puppeteer); defaults to `INTEGRATIONS_MODE` when unset. */
  @IsOptional()
  @IsEnum(IntegrationsMode)
  PDF_RENDERER_MODE?: IntegrationsMode;

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

  /** Stable MQTT client id prefix; the process id is appended so replicas never collide. */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'MQTT_CLIENT_ID_PREFIX must be a plain token' })
  MQTT_CLIENT_ID_PREFIX = 'getproperty-api';

  // --- AWS -----------------------------------------------------------------------------------------

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

  /** Number of trusted reverse-proxy hops in front of the API (Express `trust proxy`); 0 = none. */
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(5)
  TRUST_PROXY = 0;

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

  // --- Email (SES v2) -----------------------------------------------------------------------------------

  @IsString()
  EMAIL_FROM = 'getproperty <no-reply@getproperty.co>';

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

  /** Platform device CA (PEM certificate and PKCS#8 private key, or base64 of the PEM) that signs gateway CSRs. Required in production. */
  @IsOptional()
  @IsString()
  DEVICE_CA_CERT?: string;

  @IsOptional()
  @IsString()
  DEVICE_CA_KEY?: string;

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

  /** WebSocket broker URL for buildings whose network blocks 8883 (device protocol §1: WSS on 443). */
  @IsString()
  @Matches(/^wss?:\/\//, { message: 'MQTT_PUBLIC_WS_URL must be a ws(s):// URL' })
  MQTT_PUBLIC_WS_URL = 'wss://mqtt.getproperty.invalid/mqtt';

  /**
   * Where the gateway's mTLS client certificate comes from on `/v1/device/*` (CR-002): `socket` = this process
   * terminates TLS and requests client certificates; `pem_header` = a trusted proxy forwards the URL-encoded PEM in
   * DEVICE_MTLS_HEADER (nginx `$ssl_client_escaped_cert`, Envoy); `sha256_header` = the proxy forwards the
   * certificate's SHA-256 fingerprint (hex or base64; e.g. the GCP load balancer's `X-Client-Cert-Hash`). Header
   * modes trust the header: the API must only be reachable through that proxy.
   */
  @IsIn(['socket', 'pem_header', 'sha256_header'])
  DEVICE_MTLS_SOURCE: 'socket' | 'pem_header' | 'sha256_header' = 'socket';

  /** Request header carrying the forwarded client certificate (pem_header / sha256_header). */
  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'DEVICE_MTLS_HEADER must be a lower-case header name' })
  DEVICE_MTLS_HEADER = 'x-client-cert';

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
