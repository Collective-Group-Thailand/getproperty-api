import { AppConfig } from '@config/app-config';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

/**
 * PostgreSQL 18 + TimescaleDB connection (ADR-0001). In B1.1 the service only owns a `pg` pool for
 * `/health`; Prisma (`PrismaService`, `withTx`, the `TenantScoped` repository base) arrives with the
 * schema in B1.2 and will sit next to this pool. With `DATA_STORES_MODE=fake` no connection is
 * opened and `ping()` resolves at once.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly mode: 'fake' | 'real';
  private readonly pool?: Pool;

  constructor(config: AppConfig) {
    this.mode = config.useFakeDataStores ? 'fake' : 'real';
    if (this.mode === 'real') {
      this.pool = new Pool({
        connectionString: config.get('DATABASE_URL'),
        max: 4,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 30_000,
        application_name: config.get('OTEL_SERVICE_NAME'),
      });
      // A dropped idle connection must not crash the process.
      this.pool.on('error', () => undefined);
    }
  }

  /** `SELECT 1` on the real pool; a no-op on the fake. */
  async ping(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
