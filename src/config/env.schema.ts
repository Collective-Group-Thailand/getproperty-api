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

  /** Git commit of the running build (set by the image build); shown by `admin.system.info`. */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{7,40}$/i, { message: 'GIT_COMMIT must be a hex commit id' })
  GIT_COMMIT?: string;
}
