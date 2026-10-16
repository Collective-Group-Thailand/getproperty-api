import { AppConfig } from '@config/app-config';
import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * PostgreSQL 18 (ADR-0001, D-162). `DATA_STORES_MODE=real`: the /health probe runs `SELECT 1` through
 * PrismaService (adapter-pg pool). `fake`: no connection is opened and `ping()` resolves at once.
 */
@Injectable()
export class DatabaseService {
  readonly mode: 'fake' | 'real';

  constructor(
    config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.mode = config.useFakeDataStores ? 'fake' : 'real';
  }

  /** `SELECT 1` on the real database; a no-op on the fake. */
  async ping(): Promise<void> {
    if (this.mode === 'fake') return;
    await this.prisma.ping();
  }
}
