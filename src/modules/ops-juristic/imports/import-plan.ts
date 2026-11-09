import { createHash } from 'node:crypto';

import Decimal from 'decimal.js';

import { type Issue, type ParsedRow, parsePeriod, type SheetKey } from './import-sheets';

/**
 * The import plan (D-313, D-332) — pure: the parsed sheets of a job and what the building already holds in, the rows'
 * cross-file errors / warnings and exactly what a commit would write out. The commit recomputes the plan inside its
 * transaction and refuses when its hash differs from the validated one (`import.preview_stale`).
 */

const D = (v: Decimal.Value) => new Decimal(v);
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export interface ExistingUnit {
  id: string;
  unitNo: string;
  type: string;
  areaSqm: string | null;
  landAreaSqwa: string | null;
  plotNo: string | null;
  ownershipRatio: string | null;
  floorId: string | null;
  currentOwners: number;
}

export interface ExistingState {
  building: { id: string; name: string; code: string | null; type: string };
  units: readonly ExistingUnit[];
  floors: readonly { id: string; level: number; name: string }[];
  /** Parties of the tenant that share a phone or an e-mail with someone in the file. */
  parties: readonly { id: string; displayName: string; phone: string | null; email: string | null }[];
  bankAccounts: readonly { id: string; last4: string }[];
  funds: readonly { id: string; name: string; bankAccountId: string | null }[];
}

export interface PlanInput {
  asOf: string;
  sheets: Partial<Record<SheetKey, ParsedRow[]>>;
  existing: ExistingState;
}

export interface PlannedFloor {
  key: string;
  level: number;
  name: string;
}
export interface PlannedUnit {
  unitNo: string;
  existingId: string | null;
  floorKey: string | null;
  floorId: string | null;
  type: string;
  plotNo: string | null;
  landAreaSqwa: string | null;
  areaSqm: string | null;
  ownershipRatio: string | null;
}
export interface PlannedParty {
  key: string;
  existingId: string | null;
  type: 'person' | 'company';
  displayName: string;
  phone: string | null;
  email: string | null;
  idType: string | null;
  ownerCode: string | null;
}
export interface PlannedOwnership {
  unitNo: string;
  partyKey: string;
  sharePct: string;
  validFrom: string;
}
export interface PlannedBillTo {
  unitNo: string;
  ownerKey: string;
  payerKey: string;
  kind: 'named_party' | 'agency';
  validFrom: string;
}
export interface PlannedLine {
  lineKind: 'opening_balance' | 'late_fee';
  sourceType: 'common_fee' | 'fund' | 'penalty';
  description: string;
  amount: string;
  periodFrom: string;
  periodTo: string;
}
export interface PlannedInvoice {
  unitNo: string;
  ownerKey: string;
  billedKey: string;
  periodStart: string;
  periodEnd: string;
  total: string;
  lines: PlannedLine[];
}
export interface PlannedPayment {
  unitNo: string;
  partyKey: string | null;
  paidOn: string;
  amount: string;
  method: string;
  reference: string | null;
}
export interface PlannedBankRow {
  rowNo: number;
  accountType: 'operating' | 'fund';
  bankAccountId: string | null;
  fundId: string | null;
  fundName: string | null;
  last4: string | null;
  balance: string;
}

export interface PlanTotals {
  units: number;
  unitsNew: number;
  unitsAttached: number;
  floorsNew: number;
  parties: number;
  partiesNew: number;
  partiesAttached: number;
  ownerships: number;
  unitsIncomplete: number;
  billTos: number;
  openingInvoices: number;
  unitsInArrears: number;
  principal: string;
  surcharge: string;
  receivables: string;
  historyCount: number;
  historyAmount: string;
  bankOperating: string;
  bankFund: string;
  errors: number;
  warnings: number;
}

export interface ImportPlan {
  floors: PlannedFloor[];
  units: PlannedUnit[];
  parties: PlannedParty[];
  ownerships: PlannedOwnership[];
  billTos: PlannedBillTo[];
  invoices: PlannedInvoice[];
  payments: PlannedPayment[];
  bankRows: PlannedBankRow[];
}

export interface PlanResult {
  rows: Partial<Record<SheetKey, ParsedRow[]>>;
  plan: ImportPlan;
  totals: PlanTotals;
  hash: string;
}

const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function defaultUnitType(buildingType: string): string {
  return buildingType === 'house_cluster' || buildingType === 'house' ? 'house' : 'condo_unit';
}

/** Shares of a unit's owners: explicit ones kept, blanks share what is left (4 dp, remainder on the first blank). */
export function fillShares(explicit: readonly (string | null)[]): { shares: string[]; sum: Decimal } {
  const given = explicit.filter((s): s is string => s !== null).reduce((s, v) => s.plus(v), D(0));
  const blanks = explicit.filter((s) => s === null).length;
  const rest = D(100).minus(given);
  const each = blanks ? rest.div(blanks).toDecimalPlaces(4, Decimal.ROUND_DOWN) : D(0);
  let firstBlank = true;
  const shares = explicit.map((s) => {
    if (s !== null) return D(s).toFixed(4);
    const v = firstBlank ? rest.minus(each.times(blanks - 1)) : each;
    firstBlank = false;
    return v.toFixed(4);
  });
  return { shares, sum: shares.reduce((s, v) => s.plus(v), D(0)) };
}

const partyKeyOf = (code: string | null, name: string, phone: string | null, email: string | null) =>
  code ? `code:${lc(code)}` : `name:${lc(name)}|${phone ?? email ?? ''}`;

const err = (row: ParsedRow, column: string, code: string, params?: Issue['params']) =>
  row.errors.push({ column, code, ...(params ? { params } : {}) });
const warn = (row: ParsedRow, column: string, code: string, params?: Issue['params']) =>
  row.warnings.push({ column, code, ...(params ? { params } : {}) });

export function planImport(input: PlanInput): PlanResult {
  const { asOf, existing } = input;
  // copies: the field issues of the parse stay, the cross-file ones are added here
  const rows: Partial<Record<SheetKey, ParsedRow[]>> = {};
  for (const [k, v] of Object.entries(input.sheets) as [SheetKey, ParsedRow[]][])
    rows[k] = v.map((r) => ({ ...r, data: { ...r.data }, errors: [...r.errors], warnings: [...r.warnings] }));
  const register = rows.register ?? [];
  const existingUnits = new Map(existing.units.map((u) => [lc(u.unitNo), u]));

  // ------------------------------------------------------------- register: parties
  const parties = new Map<string, PlannedParty & { firstRow: ParsedRow }>();
  const codeName = new Map<string, { name: string; row: number }>();
  const attach = (name: string, phone: string | null, email: string | null) =>
    existing.parties.find(
      (p) =>
        lc(p.displayName) === lc(name) &&
        ((phone !== null && p.phone === phone) || (email !== null && lc(p.email) === email)),
    ) ?? null;
  const partyOf = (
    row: ParsedRow,
    key: string,
    p: Omit<PlannedParty, 'key' | 'existingId'>,
  ): PlannedParty => {
    const known = parties.get(key);
    if (known) return known;
    const hit = attach(p.displayName, p.phone, p.email);
    if (hit) warn(row, 'owner_name', 'party_attached', { name: hit.displayName });
    const created = { ...p, key, existingId: hit?.id ?? null, firstRow: row };
    parties.set(key, created);
    return created;
  };

  // ------------------------------------------------------------- register: units, owners
  interface UnitAcc {
    unitNo: string;
    rows: ParsedRow[];
    attrs: Record<string, { value: string; row: number }>;
  }
  const units = new Map<string, UnitAcc>();
  const seenOwner = new Map<string, number>();
  const ownerKeyOfRow = new Map<ParsedRow, string>();
  const ATTRS = ['floor', 'unit_type', 'plot_no', 'land_area_sqwa', 'area_sqm', 'ownership_ratio'] as const;
  const bName = lc(existing.building.name);
  const bCode = lc(existing.building.code);
  for (const r of register) {
    const d = r.data;
    if (d.building && lc(d.building) !== bName && lc(d.building) !== bCode)
      err(r, 'building', 'building_mismatch', { building: existing.building.name });
    if (!d.unit_no || !d.owner_name) continue;
    const code = d.owner_code;
    if (code) {
      const seen = codeName.get(lc(code));
      if (seen && lc(seen.name) !== lc(d.owner_name))
        err(r, 'owner_code', 'owner_code_conflict', { code, other: seen.name, row: seen.row });
      else if (!seen) codeName.set(lc(code), { name: d.owner_name, row: r.rowNo });
    }
    const key = partyKeyOf(code, d.owner_name, d.phone, d.email);
    ownerKeyOfRow.set(r, key);
    const dupKey = `${lc(d.unit_no)}#${key}`;
    if (seenOwner.has(dupKey)) err(r, 'owner_name', 'duplicate', { row: seenOwner.get(dupKey)! });
    else seenOwner.set(dupKey, r.rowNo);
    const u = units.get(lc(d.unit_no)) ?? { unitNo: d.unit_no, rows: [], attrs: {} };
    for (const a of ATTRS) {
      const v = d[a];
      if (v === null) continue;
      const prev = u.attrs[a];
      if (!prev) u.attrs[a] = { value: v, row: r.rowNo };
      else if (lc(prev.value) !== lc(v)) err(r, a, 'unit_values_conflict', { row: prev.row });
    }
    u.rows.push(r);
    units.set(lc(d.unit_no), u);
  }

  // floors
  const floorsByLevel = new Map(existing.floors.map((f) => [f.level, f]));
  const floorsByName = new Map(existing.floors.map((f) => [lc(f.name), f]));
  const newFloors = new Map<string, PlannedFloor>();
  const numericLevels = [...units.values()]
    .map((u) => u.attrs.floor?.value)
    .filter((v): v is string => v !== undefined && /^-?\d+$/.test(v))
    .map(Number);
  let nextLevel = Math.max(0, ...existing.floors.map((f) => f.level), ...numericLevels) + 1;
  const floorFor = (value: string): { key: string | null; id: string | null } => {
    if (/^-?\d+$/.test(value)) {
      const level = Number(value);
      const f = floorsByLevel.get(level);
      if (f) return { key: null, id: f.id };
      const key = `level:${level}`;
      if (!newFloors.has(key)) newFloors.set(key, { key, level, name: `ชั้น ${level}` });
      return { key, id: null };
    }
    const f = floorsByName.get(lc(value));
    if (f) return { key: null, id: f.id };
    const key = `name:${lc(value)}`;
    if (!newFloors.has(key)) {
      newFloors.set(key, { key, level: nextLevel, name: value });
      nextLevel += 1;
    }
    return { key, id: null };
  };

  const plannedUnits: PlannedUnit[] = [];
  const ownerships: PlannedOwnership[] = [];
  const billTos: PlannedBillTo[] = [];
  /** unit (lower) → its owners (key, display name, code) and the owner's bill-to payer key. */
  const unitOwners = new Map<
    string,
    { key: string; name: string; code: string | null; payerKey: string | null }[]
  >();
  let incomplete = 0;
  const unitDefault = defaultUnitType(existing.building.type);
  for (const [k, u] of units) {
    const ex = existingUnits.get(k);
    const first = u.rows[0]!;
    if (ex && ex.currentOwners > 0)
      for (const r of u.rows) err(r, 'unit_no', 'unit_has_owners', { unit: u.unitNo });
    if (ex) {
      const current: Record<string, string | null> = {
        unit_type: ex.type,
        plot_no: ex.plotNo,
        land_area_sqwa: ex.landAreaSqwa,
        area_sqm: ex.areaSqm,
        ownership_ratio: ex.ownershipRatio,
      };
      for (const [a, cur] of Object.entries(current)) {
        const v = u.attrs[a]?.value;
        if (v !== undefined && cur !== null && lc(cur) !== lc(v))
          warn(first, a, 'unit_attribute_differs', { unit: u.unitNo, current: cur });
      }
    }
    const floor =
      u.attrs.floor && !ex ? floorFor(u.attrs.floor.value) : { key: null, id: ex?.floorId ?? null };
    plannedUnits.push({
      unitNo: ex?.unitNo ?? u.unitNo,
      existingId: ex?.id ?? null,
      floorKey: floor.key,
      floorId: floor.id,
      type: ex?.type ?? u.attrs.unit_type?.value ?? unitDefault,
      plotNo: ex ? ex.plotNo : (u.attrs.plot_no?.value ?? null),
      landAreaSqwa: ex ? ex.landAreaSqwa : (u.attrs.land_area_sqwa?.value ?? null),
      areaSqm: ex ? ex.areaSqm : (u.attrs.area_sqm?.value ?? null),
      ownershipRatio: ex ? ex.ownershipRatio : (u.attrs.ownership_ratio?.value ?? null),
    });
    const { shares, sum } = fillShares(u.rows.map((r) => r.data.share_pct));
    if (sum.gt(100) || shares.some((s) => D(s).lte(0)))
      for (const r of u.rows) err(r, 'share_pct', 'shares_exceeded', { unit: u.unitNo, sum: sum.toFixed(2) });
    else if (sum.lt(100)) {
      incomplete += 1;
      warn(first, 'share_pct', 'shares_incomplete', { unit: u.unitNo, sum: sum.toFixed(2) });
    }
    const owners: { key: string; name: string; code: string | null; payerKey: string | null }[] = [];
    u.rows.forEach((r, i) => {
      const d = r.data;
      const key = ownerKeyOfRow.get(r)!;
      const validFrom = d.owned_since ?? asOf;
      if (validFrom > asOf) err(r, 'owned_since', 'after_as_of', { asOf });
      partyOf(r, key, {
        type: (d.owner_type as 'person' | 'company' | null) ?? 'person',
        displayName: d.owner_name!,
        phone: d.phone,
        email: d.email,
        idType: d.id_type,
        ownerCode: d.owner_code,
      });
      let payerKey: string | null = null;
      if (d.bill_to_name) {
        payerKey = `billto:${lc(d.bill_to_name)}|${d.bill_to_phone ?? d.bill_to_email ?? ''}`;
        if (lc(d.bill_to_name) === lc(d.owner_name) && (d.bill_to_phone ?? null) === (d.phone ?? null))
          err(r, 'bill_to_name', 'bill_to_same_as_owner');
        else {
          partyOf(r, payerKey, {
            type: d.bill_to_kind === 'agency' ? 'company' : 'person',
            displayName: d.bill_to_name,
            phone: d.bill_to_phone,
            email: d.bill_to_email,
            idType: null,
            ownerCode: null,
          });
          billTos.push({
            unitNo: u.unitNo,
            ownerKey: key,
            payerKey,
            kind: (d.bill_to_kind as 'named_party' | 'agency' | null) ?? 'named_party',
            validFrom: validFrom > asOf ? asOf : validFrom,
          });
        }
      }
      ownerships.push({ unitNo: u.unitNo, partyKey: key, sharePct: shares[i]!, validFrom });
      owners.push({ key, name: d.owner_name!, code: d.owner_code, payerKey });
    });
    unitOwners.set(k, owners);
  }

  // ------------------------------------------------------------- owner lookup for the other sheets
  const ownerOf = (
    r: ParsedRow,
    required: boolean,
  ): { key: string; payerKey: string | null } | null | false => {
    const unit = r.data.unit_no;
    if (!unit) return false;
    const owners = unitOwners.get(lc(unit));
    if (!owners) {
      err(r, 'unit_no', 'unit_not_in_register', { unit });
      return false;
    }
    const code = r.data.owner_code;
    const name = r.data.owner_name;
    if (code || name) {
      const hit = owners.find((o) => (code ? lc(o.code) === lc(code) : lc(o.name) === lc(name)));
      if (!hit) {
        err(r, code ? 'owner_code' : 'owner_name', 'owner_not_in_register', { owner: code ?? name!, unit });
        return false;
      }
      return hit;
    }
    if (owners.length === 1) return owners[0]!;
    if (required) {
      err(r, 'owner_code', 'owner_ambiguous', { unit });
      return false;
    }
    return null;
  };

  // ------------------------------------------------------------- opening balances → invoices
  const invoices = new Map<string, PlannedInvoice>();
  const seenBalance = new Map<string, number>();
  let principal = D(0);
  let surcharge = D(0);
  for (const r of rows.opening_balance ?? []) {
    const d = r.data;
    const owner = ownerOf(r, true);
    if (d.as_of && d.as_of !== asOf) err(r, 'as_of', 'as_of_mismatch', { asOf });
    const period = d.period ? parsePeriod(d.period) : null;
    if (period && period.to > asOf) err(r, 'period', 'period_after_as_of', { asOf });
    const p = D(d.principal ?? '0');
    const s = D(d.surcharge ?? '0');
    if (p.plus(s).lte(0) && !r.errors.some((e) => e.column === 'principal' || e.column === 'surcharge'))
      err(r, 'principal', 'amount_zero');
    if (!owner || !period) continue;
    const charge = d.charge ?? 'common_fee';
    const dup = `${lc(d.unit_no)}#${owner.key}#${charge}#${period.key}`;
    if (seenBalance.has(dup)) err(r, 'period', 'duplicate', { row: seenBalance.get(dup)! });
    else seenBalance.set(dup, r.rowNo);
    if (r.errors.length) continue;
    const billedKey = owner.payerKey ?? owner.key;
    const invKey = `${lc(d.unit_no)}#${billedKey}#${owner.key}`;
    const unitNo = plannedUnits.find((u) => lc(u.unitNo) === lc(d.unit_no))!.unitNo;
    const inv = invoices.get(invKey) ?? {
      unitNo,
      ownerKey: owner.key,
      billedKey,
      periodStart: period.from,
      periodEnd: asOf,
      total: '0.00',
      lines: [],
    };
    const label = charge === 'fund' ? 'เงินกองทุน' : 'ค่าส่วนกลาง';
    if (p.gt(0))
      inv.lines.push({
        lineKind: 'opening_balance',
        sourceType: charge === 'fund' ? 'fund' : 'common_fee',
        description: `ยอดยกมา ${label} งวด ${period.key}`,
        amount: p.toFixed(2),
        periodFrom: period.from,
        periodTo: period.to,
      });
    if (s.gt(0))
      inv.lines.push({
        lineKind: 'late_fee',
        sourceType: 'penalty',
        description: `เงินเพิ่มยกมา ${label} งวด ${period.key}`,
        amount: s.toFixed(2),
        periodFrom: period.from,
        periodTo: period.to,
      });
    if (period.from < inv.periodStart) inv.periodStart = period.from;
    inv.total = D(inv.total).plus(p).plus(s).toFixed(2);
    invoices.set(invKey, inv);
    principal = principal.plus(p);
    surcharge = surcharge.plus(s);
  }
  for (const inv of invoices.values())
    inv.lines.sort(
      (a, b) =>
        a.periodFrom.localeCompare(b.periodFrom) ||
        a.sourceType.localeCompare(b.sourceType) ||
        a.lineKind.localeCompare(b.lineKind),
    );

  // ------------------------------------------------------------- payment history (history only)
  const payments: PlannedPayment[] = [];
  const seenPayment = new Map<string, number>();
  const oldest = addDays(asOf, -366);
  let historyAmount = D(0);
  for (const r of rows.payment_history ?? []) {
    const d = r.data;
    const owner = ownerOf(r, false);
    if (d.paid_on && d.paid_on > asOf) err(r, 'paid_on', 'after_as_of', { asOf });
    if (d.paid_on && d.paid_on < oldest) err(r, 'paid_on', 'paid_on_too_old');
    if (d.amount && D(d.amount).lte(0)) err(r, 'amount', 'amount_positive');
    if (owner === false || r.errors.length) continue;
    const dup = `${lc(d.unit_no)}#${d.paid_on}#${d.amount}#${lc(d.reference)}`;
    if (seenPayment.has(dup)) warn(r, 'paid_on', 'duplicate_payment', { row: seenPayment.get(dup)! });
    else seenPayment.set(dup, r.rowNo);
    payments.push({
      unitNo: plannedUnits.find((u) => lc(u.unitNo) === lc(d.unit_no))!.unitNo,
      partyKey: owner?.key ?? null,
      paidOn: d.paid_on!,
      amount: d.amount!,
      method: d.method ?? 'transfer',
      reference: d.reference,
    });
    historyAmount = historyAmount.plus(d.amount!);
  }

  // ------------------------------------------------------------- bank opening balances
  const bankRows: PlannedBankRow[] = [];
  const seenBank = new Map<string, number>();
  let bankOperating = D(0);
  let bankFund = D(0);
  for (const r of rows.bank_balance ?? []) {
    const d = r.data;
    if (d.as_of && d.as_of !== asOf) err(r, 'as_of', 'as_of_mismatch', { asOf });
    let bankAccountId: string | null = null;
    if (d.bank_account_last4) {
      const hits = existing.bankAccounts.filter((b) => b.last4 === d.bank_account_last4);
      if (!hits.length)
        err(r, 'bank_account_last4', 'bank_account_not_found', { last4: d.bank_account_last4 });
      else if (hits.length > 1)
        err(r, 'bank_account_last4', 'bank_account_ambiguous', { last4: d.bank_account_last4 });
      else bankAccountId = hits[0]!.id;
    } else if (d.account_type === 'operating') err(r, 'bank_account_last4', 'bank_account_required');
    let fundId: string | null = null;
    if (d.account_type === 'fund' && d.fund_name) {
      const f = existing.funds.find((x) => lc(x.name) === lc(d.fund_name));
      if (!f) err(r, 'fund_name', 'fund_not_found', { fund: d.fund_name });
      else fundId = f.id;
    }
    if (!d.account_type || !d.balance) continue;
    const dup = `${d.account_type}#${bankAccountId ?? ''}#${fundId ?? lc(d.fund_name)}`;
    if (seenBank.has(dup)) err(r, 'account_type', 'duplicate', { row: seenBank.get(dup)! });
    else seenBank.set(dup, r.rowNo);
    if (r.errors.length) continue;
    bankRows.push({
      rowNo: r.rowNo,
      accountType: d.account_type as 'operating' | 'fund',
      bankAccountId,
      fundId,
      fundName: d.fund_name,
      last4: d.bank_account_last4,
      balance: d.balance,
    });
    if (d.account_type === 'operating') bankOperating = bankOperating.plus(d.balance);
    else bankFund = bankFund.plus(d.balance);
  }

  const plan: ImportPlan = {
    floors: [...newFloors.values()],
    units: plannedUnits,
    parties: [...parties.values()].map(({ firstRow: _f, ...p }) => p),
    ownerships,
    billTos,
    invoices: [...invoices.values()],
    payments,
    bankRows,
  };
  const all = Object.values(rows).flat();
  const totals: PlanTotals = {
    units: plannedUnits.length,
    unitsNew: plannedUnits.filter((u) => !u.existingId).length,
    unitsAttached: plannedUnits.filter((u) => u.existingId).length,
    floorsNew: plan.floors.length,
    parties: plan.parties.length,
    partiesNew: plan.parties.filter((p) => !p.existingId).length,
    partiesAttached: plan.parties.filter((p) => p.existingId).length,
    ownerships: ownerships.length,
    unitsIncomplete: incomplete,
    billTos: billTos.length,
    openingInvoices: plan.invoices.length,
    unitsInArrears: new Set(plan.invoices.map((i) => lc(i.unitNo))).size,
    principal: principal.toFixed(2),
    surcharge: surcharge.toFixed(2),
    receivables: principal.plus(surcharge).toFixed(2),
    historyCount: payments.length,
    historyAmount: historyAmount.toFixed(2),
    bankOperating: bankOperating.toFixed(2),
    bankFund: bankFund.toFixed(2),
    errors: all.filter((r) => r.errors.length).length,
    warnings: all.filter((r) => r.warnings.length).length,
  };
  const hash = createHash('sha256').update(JSON.stringify({ asOf, plan })).digest('base64url');
  return { rows, plan, totals, hash };
}

// ------------------------------------------------------------------------------------------- reconcile

export type ReconcileStatus = 'match' | 'mismatch' | 'no_statement';
export interface ReconcileItem {
  key: string;
  kind: 'receivables' | 'bank';
  label: string;
  /** What the import brings (Σ of the sheet / the bank row's balance). */
  imported: string;
  /** What it is compared with (the declared total / the bank statement balance); null when there is none. */
  reference: string | null;
  difference: string | null;
  status: ReconcileStatus;
  /** Bank items (J-CR): the account the row names; absent on receivables and on reconciliations stored before. */
  accountType?: 'operating' | 'fund';
  last4?: string | null;
  fundName?: string | null;
}

/** One bank row of the import with the statement balance it is compared with. */
export interface ReconcileBankInput {
  rowNo: number;
  label: string;
  accountType: 'operating' | 'fund';
  last4: string | null;
  fundName: string | null;
  balance: string;
  statementBalance: string | null;
}

export function reconcileItems(
  totals: Pick<PlanTotals, 'receivables'>,
  declaredReceivables: string,
  bank: readonly ReconcileBankInput[],
): { items: ReconcileItem[]; explanationRequired: boolean } {
  const items: ReconcileItem[] = [];
  const diff = D(totals.receivables).minus(declaredReceivables);
  items.push({
    key: 'receivables',
    kind: 'receivables',
    label: 'receivables',
    imported: D(totals.receivables).toFixed(2),
    reference: D(declaredReceivables).toFixed(2),
    difference: diff.toFixed(2),
    status: diff.eq(0) ? 'match' : 'mismatch',
  });
  for (const b of bank) {
    const d = b.statementBalance === null ? null : D(b.balance).minus(b.statementBalance);
    items.push({
      key: `bank:${b.rowNo}`,
      kind: 'bank',
      label: b.label,
      imported: D(b.balance).toFixed(2),
      reference: b.statementBalance === null ? null : D(b.statementBalance).toFixed(2),
      difference: d === null ? null : d.toFixed(2),
      status: d === null ? 'no_statement' : d.eq(0) ? 'match' : 'mismatch',
      accountType: b.accountType,
      last4: b.last4,
      fundName: b.fundName,
    });
  }
  return { items, explanationRequired: items.some((i) => i.status !== 'match') };
}

/** Per unit: the parallel cycle's computed amount against the legacy bill (both sides' units). */
export function cycleDifferences(
  computed: ReadonlyMap<string, { unitId: string; unitNo: string; amount: Decimal }>,
  legacy: readonly { unitNo: string; amount: string }[],
): { unitNo: string; unitId: string | null; computed: string; legacy: string; difference: string }[] {
  const legacyBy = new Map<string, { unitNo: string; amount: Decimal }>();
  for (const l of legacy) {
    const k = lc(l.unitNo);
    const cur = legacyBy.get(k);
    legacyBy.set(k, { unitNo: cur?.unitNo ?? l.unitNo, amount: (cur?.amount ?? D(0)).plus(l.amount) });
  }
  const keys = [...new Set([...computed.keys(), ...legacyBy.keys()])].sort();
  return keys.map((k) => {
    const c = computed.get(k);
    const l = legacyBy.get(k);
    const ca = c?.amount ?? D(0);
    const la = l?.amount ?? D(0);
    return {
      unitNo: c?.unitNo ?? l!.unitNo,
      unitId: c?.unitId ?? null,
      computed: ca.toFixed(2),
      legacy: la.toFixed(2),
      difference: ca.minus(la).toFixed(2),
    };
  });
}
