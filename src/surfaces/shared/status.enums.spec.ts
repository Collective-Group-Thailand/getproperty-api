import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADMIN_MENU, OWNER_MENU, STAFF_MENU } from '@core/rbac/menu';

import { ExportKindName, ExportStatusName } from '../owner/documents.dto';
import {
  AdminMenuKey,
  BillingCycleStatusName,
  EstimatePolicyName,
  InvoiceChargeStatusName,
  InvoiceLineKindName,
  InvoiceLineSourceTypeName,
  InvoiceStatusName,
  NoteReasonName,
  OwnerMenuKey,
  RateBasisName,
  RatePlanKindName,
  StaffMenuKey,
} from './status.enums';

describe('menu keys are named enums in step with the menu catalogue (web contract request)', () => {
  it.each([
    ['OwnerMenuKey', OWNER_MENU, OwnerMenuKey],
    ['StaffMenuKey', STAFF_MENU, StaffMenuKey],
    ['AdminMenuKey', ADMIN_MENU, AdminMenuKey],
  ] as const)('%s', (_name, menu, keys) => {
    expect(menu.map((m) => m.key).sort()).toEqual(Object.values(keys).sort());
  });
});

describe('B4 billing enums equal the database enums of migration 0020', () => {
  const sql = readFileSync(
    join(__dirname, '../../../prisma/migrations/20261017000020_0020_ops_billing/migration.sql'),
    'utf8',
  );
  const pgEnum = (name: string): string[] => {
    const m = new RegExp(`CREATE TYPE ops\\.${name} AS ENUM \\(([^;]+)\\);`).exec(sql);
    if (!m) throw new Error(`enum ${name} not found`);
    return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
  };
  it.each([
    ['invoice_status', InvoiceStatusName],
    ['invoice_line_source_type', InvoiceLineSourceTypeName],
    ['invoice_line_kind', InvoiceLineKindName],
    ['billing_cycle_status', BillingCycleStatusName],
    ['rate_plan_kind', RatePlanKindName],
    ['rate_basis', RateBasisName],
    ['note_reason', NoteReasonName],
    ['invoice_charge_status', InvoiceChargeStatusName],
    ['estimate_policy', EstimatePolicyName],
  ] as const)('%s', (name, e) => {
    expect(Object.values(e).sort()).toEqual(pgEnum(name));
  });
});

describe('B4.3 export enums equal the database enums of migration 0021', () => {
  const sql = readFileSync(
    join(__dirname, '../../../prisma/migrations/20261017000021_0021_ops_export_job/migration.sql'),
    'utf8',
  );
  const pgEnum = (name: string): string[] => {
    const m = new RegExp(`CREATE TYPE ops\\.${name} AS ENUM \\(([^;]+)\\);`).exec(sql);
    if (!m) throw new Error(`enum ${name} not found`);
    return [...m[1]!.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]!).sort();
  };
  it.each([
    ['export_kind', ExportKindName],
    ['job_status', ExportStatusName],
  ] as const)('%s', (name, e) => {
    expect(Object.values(e).sort()).toEqual(pgEnum(name));
  });
});
