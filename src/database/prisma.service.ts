import { type ActorKind, tenantScopeStatements } from '@collective/asset-core';
import { AppConfig } from '@config/app-config';
import { type Prisma, PrismaClient } from '@generated/prisma/client';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

export type Tx = Prisma.TransactionClient;

export interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** ms; Prisma's default is 5 000 — raised only by bulk operations (imports, seeds). */
  timeout?: number;
}

/** Who a tenant-scoped transaction runs for (schema-design §4.5 "Session variables"). */
export interface TenantScope {
  tenantId: string;
  /** core.user_account of the actor → `app.actor_id` (a user may read its own account row). */
  actorId?: string | null;
  actorKind?: ActorKind;
}

/** Used only to build the client in DATA_STORES_MODE=fake, where nothing ever connects. */
const UNUSED_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';

/**
 * Prisma 7 client over the `pg` driver adapter (reference: getpack-api). Connects lazily on the first query, so
 * DATA_STORES_MODE=fake never opens a connection. Every state change goes through `withTx` / `withTenant`
 * together with its audit row and outbox event (CLAUDE.md hard rules).
 *
 * Row-level security (D-152): tenant data is read and written inside `withTenant`, which runs
 * `SET LOCAL app.tenant_id` (+ `app.actor_id`, `app.actor_kind`) — and `SET LOCAL ROLE $DATABASE_APP_ROLE` when the
 * login is a member of gp_app rather than gp_app itself — at the start of the transaction. `SET LOCAL` dies with
 * the transaction, so pooled connections never leak a tenant.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  readonly appRole?: string;
  readonly platformRole?: string;

  constructor(config: AppConfig) {
    const url = config.useFakeDataStores
      ? (config.get('DATABASE_URL') ?? UNUSED_URL)
      : config.get('DATABASE_URL');
    super({
      adapter: new PrismaPg({
        connectionString: url ?? UNUSED_URL,
        max: 10,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        application_name: config.get('OTEL_SERVICE_NAME'),
        // The Prisma pg adapter reads timestamptz text and replaces its offset with +00:00, so every session must
        // run in UTC or instants shift by the server's offset (e.g. +7 h on a cluster set to Asia/Bangkok).
        // Business rules convert to Asia/Bangkok in code (CLAUDE.md "Time").
        options: '-c TimeZone=UTC',
      }),
    });
    this.appRole = config.get('DATABASE_APP_ROLE');
    this.platformRole = config.get('DATABASE_PLATFORM_ROLE');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** `SELECT 1` — the /health database probe in DATA_STORES_MODE=real. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  /** One database transaction without tenant scope, as the login role (seeds, tooling). Prefer withPlatform. */
  withTx<T>(work: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T> {
    return this.$transaction(work, options);
  }

  /**
   * One transaction as `gp_platform` (BYPASSRLS, schema-design §4.5): identity lookups (user by phone or LINE id),
   * the `/v1/admin` surface, the outbox relay, workflow timers and cross-tenant jobs. Every call site is listed in
   * docs/rbac.md ("platform role call sites") and writes are audited by the caller. `actorId` lets the platform
   * actor's own audit/user rows be attributed.
   */
  withPlatform<T>(
    work: (tx: Tx) => Promise<T>,
    options?: TxOptions & { actorId?: string | null; tenantId?: string | null },
  ): Promise<T> {
    const role = this.platformRole;
    if (role && !/^[a-z_][a-z0-9_]*$/.test(role))
      throw new TypeError(`invalid DATABASE_PLATFORM_ROLE "${role}"`);
    return this.$transaction(async (tx) => {
      if (role) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.actor_kind', 'platform', true)`,
        options?.tenantId ?? '',
        options?.actorId ?? '',
      );
      return work(tx);
    }, options);
  }

  /** One transaction scoped to a tenant: every statement inside is subject to its RLS policies. */
  withTenant<T>(scope: TenantScope, work: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T> {
    const statements = tenantScopeStatements(scope.tenantId, {
      actorId: scope.actorId ?? null,
      actorKind: scope.actorKind,
      role: this.appRole,
    });
    return this.$transaction(async (tx) => {
      for (const s of statements) {
        if (s.text.startsWith('SET ')) await tx.$executeRawUnsafe(s.text);
        else await tx.$queryRawUnsafe(s.text, ...s.values);
      }
      return work(tx);
    }, options);
  }
}
