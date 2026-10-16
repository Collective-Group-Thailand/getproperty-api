import { PrismaService, type Tx } from '@database/prisma.service';
import { Injectable } from '@nestjs/common';

export interface SettingValueAt {
  key: string;
  value: unknown;
  scope: 'platform' | 'tenant' | 'property';
  versionId: string;
  effectiveFrom: Date;
}

interface Row {
  rank: number;
  value: unknown;
  version_id: string;
  effective_from: Date;
}

const SCOPES = { 1: 'platform', 2: 'tenant', 3: 'property' } as const;

/**
 * `settings.at(key, at, {tenantId, propertyId})` — schema-design §4.1: the most specific scope wins
 * (property → tenant → platform) among the versions in force at `at`. Tenant and property versions are tenant
 * rows: with a tenantId the query runs inside `withTenant`, so RLS applies (a foreign tenant id finds nothing).
 * Caching and invalidation arrive with the settings service in B1.3.
 */
@Injectable()
export class SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async at(
    key: string,
    at: Date,
    scope: { tenantId?: string; propertyId?: string } = {},
  ): Promise<SettingValueAt | null> {
    const run = (db: Tx | PrismaService) => this.query(db, key, at, scope);
    return scope.tenantId ? this.prisma.withTenant({ tenantId: scope.tenantId }, run) : run(this.prisma);
  }

  private async query(
    db: Tx | PrismaService,
    key: string,
    at: Date,
    { tenantId, propertyId }: { tenantId?: string; propertyId?: string },
  ): Promise<SettingValueAt | null> {
    // An ISO string with offset, cast explicitly: a bare Date parameter would be compared as a zone-less timestamp.
    const ts = at.toISOString();
    const rows = await db.$queryRaw<Row[]>`
      WITH v AS (
        SELECT 3 AS rank, psv.value, psv.id AS version_id, psv.effective_from
          FROM platform.property_setting_version psv JOIN platform.setting s ON s.id = psv.setting_id
         WHERE s.key = ${key} AND psv.property_id = ${propertyId ?? null}::uuid
           AND psv.effective_from <= ${ts}::timestamptz AND coalesce(psv.effective_to, 'infinity') > ${ts}::timestamptz
        UNION ALL
        SELECT 2, tsv.value, tsv.id, tsv.effective_from
          FROM platform.tenant_setting_version tsv JOIN platform.setting s ON s.id = tsv.setting_id
         WHERE s.key = ${key} AND tsv.tenant_id = ${tenantId ?? null}::uuid
           AND tsv.effective_from <= ${ts}::timestamptz AND coalesce(tsv.effective_to, 'infinity') > ${ts}::timestamptz
        UNION ALL
        SELECT 1, sv.value, sv.id, sv.effective_from
          FROM platform.setting_version sv JOIN platform.setting s ON s.id = sv.setting_id
         WHERE s.key = ${key}
           AND sv.effective_from <= ${ts}::timestamptz AND coalesce(sv.effective_to, 'infinity') > ${ts}::timestamptz)
      SELECT rank, value, version_id, effective_from FROM v ORDER BY rank DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      key,
      value: row.value,
      scope: SCOPES[row.rank as 1 | 2 | 3],
      versionId: row.version_id,
      effectiveFrom: row.effective_from,
    };
  }
}
