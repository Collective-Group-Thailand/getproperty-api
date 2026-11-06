import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { zip, type ZipEntry } from '@common/zip/zip';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type ExportJob } from '@generated/prisma/client';
import { type ExportBuilder, type ExportFile, ExportsService } from '@modules/ops-documents/exports.service';
import { csvOf } from '@modules/ops-receivables/exports/sheets';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { LedgerService } from '../accounting/ledger.service';

/** Billing and register tables of the tenant that travel with the juristic tables (when they exist). */
export const FULL_EXPORT_EXTRA_TABLES: readonly string[] = [
  'core.property',
  'core.building',
  'core.floor',
  'core.unit',
  'core.party',
  'core.unit_ownership',
  'core.occupancy',
  'ops.rate_plan',
  'ops.rate_plan_version',
  'ops.billing_cycle',
  'ops.invoice',
  'ops.invoice_line',
  'ops.invoice_charge',
  'ops.credit_note',
  'ops.credit_note_line',
  'ops.debit_note',
  'ops.debit_note_line',
  'ops.payment',
  'ops.payment_allocation',
  'ops.receipt',
];

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * "You can leave any time" (D-313, D-332): export kind `juristic_full_export` — a ZIP with one CSV per table of the
 * tenant: **every table of schema `juristic`** (read from the catalogue, so later tables join automatically) and the
 * register and billing tables of `FULL_EXPORT_EXTRA_TABLES`, rows filtered by `tenant_id`, values as PostgreSQL text;
 * `bytea` columns (encrypted ID numbers, lookup hashes, checksums) are left out. `manifest.csv` lists every table
 * with its row count and columns.
 */
@Injectable()
export class JuristicFullExportService implements ExportBuilder, OnModuleInit {
  readonly kind = 'juristic_full_export' as const;

  constructor(
    private readonly db: TenantTx,
    private readonly exports: ExportsService,
    private readonly ledger: LedgerService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.exports.register(this);
  }

  /** `POST /v1/owner/juristic/export`. */
  async request(ctx: TenantContext) {
    if (ctx.buildingIds) throw new DomainException('auth.forbidden');
    await this.db.tenant(ctx, (tx) => this.ledger.assertJuristic(tx, ctx.tenantId));
    return this.exports.request(ctx, { kind: this.kind, params: {} });
  }

  validate(): { path: string; message: string }[] {
    return [];
  }

  /** Tables (schema.table) with a tenant_id column and their exportable columns, in catalogue order. */
  async tables(tx: Tx): Promise<{ name: string; columns: string[] }[]> {
    const rows = await tx.$queryRaw<{ schema: string; table: string; column: string; type: string }[]>`
      SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column, c.data_type AS type
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE t.table_type = 'BASE TABLE'
         AND (c.table_schema = 'juristic' OR (c.table_schema || '.' || c.table_name) = ANY(${[...FULL_EXPORT_EXTRA_TABLES]}::text[]))
       ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
    const by = new Map<string, { columns: string[]; tenant: boolean }>();
    for (const r of rows) {
      const name = `${r.schema}.${r.table}`;
      const t = by.get(name) ?? { columns: [], tenant: false };
      if (r.column === 'tenant_id') t.tenant = true;
      if (r.type !== 'bytea' && IDENT.test(r.column)) t.columns.push(r.column);
      by.set(name, t);
    }
    return [...by.entries()]
      .filter(([name, t]) => t.tenant && name.split('.').every((p) => IDENT.test(p)))
      .map(([name, t]) => ({ name, columns: t.columns }));
  }

  async build(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const tables = await this.tables(tx);
    const entries: ZipEntry[] = [];
    const manifest: (string | number)[][] = [];
    let total = 0;
    for (const t of tables) {
      const [schema, table] = t.name.split('.') as [string, string];
      const select = t.columns.map((c) => `"${c}"::text AS "${c}"`).join(', ');
      const order = t.columns.includes('id') ? ' ORDER BY "id"' : '';
      // identifiers come from the catalogue (checked against IDENT); the tenant id is a bound parameter
      const rows = await tx.$queryRawUnsafe<Record<string, string | null>[]>(
        `SELECT ${select} FROM "${schema}"."${table}" WHERE "tenant_id" = $1::uuid${order}`,
        job.tenantId,
      );
      entries.push({
        name: `${schema}/${table}.csv`,
        data: Buffer.from(
          csvOf(
            t.columns,
            rows.map((r) => t.columns.map((c) => r[c] ?? null)),
          ),
          'utf8',
        ),
      });
      manifest.push([t.name, rows.length, t.columns.join(' ')]);
      total += rows.length;
    }
    entries.unshift({
      name: 'manifest.csv',
      data: Buffer.from(csvOf(['table', 'rows', 'columns'], manifest), 'utf8'),
    });
    return {
      fileName: `juristic-export-${bangkokDate(this.clock.now())}.zip`,
      mimeType: 'application/zip',
      body: zip(entries),
      rowCount: total,
    };
  }
}
