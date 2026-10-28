import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type EmployerAgreement,
  type EmployerSplitRule,
  type ExportJob,
  type LeaseStatus,
  type Prisma,
} from '@generated/prisma/client';
import { type ExportBuilder, type ExportFile, ExportsService } from '@modules/ops-documents/exports.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import {
  bangkokMonthRange,
  orderPeople,
  payrollCsv,
  type PayrollRow,
  splitInvoice,
  type StatementPerson,
  type WorkerShare,
} from './employer-statement';

const SUBJECT = 'ops.employer_agreement';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Leases an employer may take over (or let go of): not closed. Issued invoices never change (D-040). */
const OPEN: LeaseStatus[] = ['draft', 'pending_signature', 'active', 'notice_given', 'ending'];
/** People who stay at the unit (as TM30, B6.2): the split of `per_occupant` is between them. */
const STAYING = ['tenant', 'co_tenant', 'family'] as const;
const by = () => userIdOf(RequestContext.actor());

export const AGREEMENT_INCLUDE = {
  employer: { select: { id: true, displayName: true, type: true } },
  building: { select: { id: true, name: true } },
  workers: { select: { partyId: true, employeeNo: true }, orderBy: { employeeNo: 'asc' } },
  leases: { select: { id: true }, where: { status: { in: OPEN } } },
} as const satisfies Prisma.EmployerAgreementInclude;
export type AgreementRow = Prisma.EmployerAgreementGetPayload<{ include: typeof AGREEMENT_INCLUDE }>;

export interface AgreementInput {
  employerPartyId: string;
  buildingId?: string | null;
  reference?: string | null;
  splitRule?: EmployerSplitRule;
  /** Decimal string 0–100. */
  deductPercent?: string;
  validFrom: string;
  validTo?: string | null;
}

export interface AgreementPatch {
  reference?: string | null;
  splitRule?: EmployerSplitRule;
  deductPercent?: string;
  validTo?: string | null;
  /** Ends the agreement now: its open leases go back to their lessees for the next invoices. */
  end?: boolean;
}

export interface StatementLine {
  invoiceId: string;
  number: string | null;
  leaseId: string;
  unitNo: string;
  issuedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  total: Decimal;
  paidTotal: Decimal;
  balance: Decimal;
  shares: WorkerShare[];
}

export interface Statement {
  agreement: EmployerAgreement;
  employerName: string;
  month: string;
  lines: StatementLine[];
  total: Decimal;
  paid: Decimal;
  balance: Decimal;
  deductions: Decimal;
  employerPays: Decimal;
}

const invalid = (path: string, message: string, code = 'invalid') =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

function percent(value: string | undefined): Decimal | undefined {
  if (value === undefined) return undefined;
  const d = new Decimal(value);
  if (d.lt(0) || d.gt(100) || d.decimalPlaces() > 2) throw invalid('deductPercent', '0–100, two decimals');
  return d;
}

/**
 * Employer housing (G8, D-289 (4), D-299): an employer (a party of the tenant, usually a company) pays the leases of
 * its workers. A lease attached to an agreement has `payer_party_id` = the employer: billing addresses its next
 * invoices to the employer (issued invoices never change, D-040); the employer gets a monthly **statement** of those
 * invoices split per occupant (equal shares of the people staying) or per unit (the lessee), with the payroll
 * deduction of each share (`deduct_percent`), and a **payroll-deduction CSV** (export `payroll_deduction`). Whether
 * and how much the employer may deduct from wages is the employer's responsibility (Labour Protection Act s.76,
 * O-034). TM30 of the employer's foreign workers: the B6.2 rows filtered by the agreement.
 */
@Injectable()
export class EmployerHousingService extends TenantScopedRepository implements ExportBuilder, OnModuleInit {
  readonly kind = 'payroll_deduction' as const;

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly exports: ExportsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.exports.register(this);
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<AgreementRow> {
    return this.found(
      await tx.employerAgreement.findFirst({ where: this.own(ctx, { id }), include: AGREEMENT_INCLUDE }),
    );
  }

  list(ctx: TenantContext, q: { state?: EmployerAgreement['state'] } = {}) {
    return this.db.tenant(ctx, (tx) =>
      tx.employerAgreement.findMany({
        where: this.own(ctx, q.state ? { state: q.state } : {}),
        include: AGREEMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  async create(ctx: TenantContext, input: AgreementInput): Promise<AgreementRow> {
    const deduct = percent(input.deductPercent) ?? new Decimal(100);
    if (input.validTo && input.validTo < input.validFrom)
      throw invalid('validTo', 'on or after validFrom', 'range');
    return this.db.tenant(ctx, async (tx) => {
      const employer = await tx.party.findFirst({
        where: { id: input.employerPartyId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!employer) throw new DomainException('http.not_found');
      if (input.buildingId) {
        const building = await tx.building.findFirst({
          where: { id: input.buildingId, deletedAt: null },
          select: { id: true },
        });
        if (!building || (ctx.buildingIds && !ctx.buildingIds.includes(input.buildingId)))
          throw new DomainException('http.not_found');
      }
      const row = await tx.employerAgreement.create({
        data: {
          tenantId: ctx.tenantId,
          employerPartyId: employer.id,
          buildingId: input.buildingId ?? null,
          reference: input.reference?.trim() || null,
          splitRule: input.splitRule ?? 'per_occupant',
          deductPercent: deduct.toFixed(2),
          validFrom: new Date(`${input.validFrom}T00:00:00Z`),
          validTo: input.validTo ? new Date(`${input.validTo}T00:00:00Z`) : null,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'employer_agreement.created',
        tenantId: ctx.tenantId,
        buildingId: row.buildingId,
        subjectType: SUBJECT,
        subjectId: row.id,
        after: {
          employerPartyId: row.employerPartyId,
          splitRule: row.splitRule,
          deductPercent: deduct.toFixed(2),
          validFrom: input.validFrom,
          validTo: input.validTo ?? null,
        },
      });
      await this.events.record(tx, {
        type: 'employer_agreement.created',
        aggregateType: 'employer_agreement',
        aggregateId: row.id,
        tenantId: ctx.tenantId,
        buildingId: row.buildingId,
        payload: { agreementId: row.id, employerPartyId: row.employerPartyId },
      });
      return this.load(tx, ctx, row.id);
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    version: number,
    patch: AgreementPatch,
  ): Promise<AgreementRow> {
    const deduct = percent(patch.deductPercent);
    return this.db.tenant(ctx, async (tx) => {
      const current = await this.load(tx, ctx, id);
      if (current.version !== version) throw new DomainException('concurrency.stale');
      if (current.state === 'ended') throw new DomainException('employer.invalid_state');
      const validTo =
        patch.validTo === undefined
          ? current.validTo
          : patch.validTo
            ? new Date(`${patch.validTo}T00:00:00Z`)
            : null;
      if (validTo && validTo < current.validFrom) throw invalid('validTo', 'on or after validFrom', 'range');
      const now = this.clock.now();
      const data: Prisma.EmployerAgreementUncheckedUpdateInput = {
        ...(patch.reference !== undefined ? { reference: patch.reference?.trim() || null } : {}),
        ...(patch.splitRule ? { splitRule: patch.splitRule } : {}),
        ...(deduct ? { deductPercent: deduct.toFixed(2) } : {}),
        validTo,
        ...(patch.end ? { state: 'ended', endedAt: now } : {}),
        updatedBy: by(),
        version: { increment: 1 },
      };
      await tx.employerAgreement.update({ where: { id }, data });
      let released = 0;
      if (patch.end) {
        const leases = await tx.lease.findMany({
          where: { tenantId: ctx.tenantId, employerAgreementId: id },
          select: { id: true, tenantId: true, buildingId: true },
        });
        for (const lease of leases) await this.setPayer(tx, lease, null, null, 'agreement_ended');
        released = leases.length;
      }
      await this.audit.record(tx, {
        action: 'employer_agreement.updated',
        tenantId: ctx.tenantId,
        buildingId: current.buildingId,
        subjectType: SUBJECT,
        subjectId: id,
        before: {
          splitRule: current.splitRule,
          deductPercent: current.deductPercent.toFixed(2),
          validTo: current.validTo ? bangkokDate(current.validTo) : null,
          state: current.state,
        },
        after: {
          ...patch,
          ...(deduct ? { deductPercent: deduct.toFixed(2) } : {}),
          ...(patch.end ? { leasesReleased: released } : {}),
        },
      });
      await this.events.record(tx, {
        type: 'employer_agreement.updated',
        aggregateType: 'employer_agreement',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: current.buildingId,
        payload: { agreementId: id, ended: Boolean(patch.end) },
      });
      return this.load(tx, ctx, id);
    });
  }

  /** Replaces the payroll numbers of the agreement's workers (parties of the tenant). */
  async setWorkers(
    ctx: TenantContext,
    id: string,
    workers: { partyId: string; employeeNo: string }[],
  ): Promise<AgreementRow> {
    const seen = new Set<string>();
    workers.forEach((w, i) => {
      if (seen.has(w.partyId)) throw invalid(`workers[${i}].partyId`, 'listed twice', 'unique');
      seen.add(w.partyId);
    });
    return this.db.tenant(ctx, async (tx) => {
      const current = await this.load(tx, ctx, id);
      if (current.state === 'ended') throw new DomainException('employer.invalid_state');
      const parties = workers.length
        ? await tx.party.count({
            where: { tenantId: ctx.tenantId, id: { in: [...seen] }, deletedAt: null },
          })
        : 0;
      if (parties !== seen.size) throw new DomainException('http.not_found');
      await tx.employerWorker.deleteMany({ where: { tenantId: ctx.tenantId, agreementId: id } });
      if (workers.length)
        await tx.employerWorker.createMany({
          data: workers.map((w) => ({
            tenantId: ctx.tenantId,
            agreementId: id,
            partyId: w.partyId,
            employeeNo: w.employeeNo.trim(),
            createdBy: by(),
          })),
        });
      await tx.employerAgreement.update({
        where: { id },
        data: { updatedBy: by(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'employer_agreement.workers_set',
        tenantId: ctx.tenantId,
        buildingId: current.buildingId,
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { workers: workers.length },
      });
      await this.events.record(tx, {
        type: 'employer_agreement.updated',
        aggregateType: 'employer_agreement',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: current.buildingId,
        payload: { agreementId: id, workers: workers.length },
      });
      return this.load(tx, ctx, id);
    });
  }

  private async setPayer(
    tx: Tx,
    lease: { id: string; tenantId: string; buildingId: string },
    agreementId: string | null,
    payerPartyId: string | null,
    reason: 'owner' | 'agreement_ended',
  ): Promise<void> {
    await tx.lease.update({
      where: { id: lease.id },
      data: {
        employerAgreementId: agreementId,
        payerPartyId,
        updatedBy: by(),
        version: { increment: 1 },
      },
    });
    await this.audit.record(tx, {
      action: 'lease.payer_changed',
      tenantId: lease.tenantId,
      buildingId: lease.buildingId,
      subjectType: 'ops.lease',
      subjectId: lease.id,
      after: { employerAgreementId: agreementId, payerPartyId, reason },
    });
    await this.events.record(tx, {
      type: 'lease.payer_changed',
      aggregateType: 'lease',
      aggregateId: lease.id,
      tenantId: lease.tenantId,
      buildingId: lease.buildingId,
      payload: { leaseId: lease.id, employerAgreementId: agreementId, payerPartyId, reason },
    });
  }

  /**
   * `PUT /v1/owner/leases/{id}/employer`: attaches an open lease to an active agreement (its building, if the
   * agreement names one) or detaches it (`null`). Invoices from now on go to the payer; issued ones never change.
   */
  async setLeaseEmployer(ctx: TenantContext, leaseId: string, agreementId: string | null) {
    return this.db.tenant(ctx, async (tx) => {
      const lease = await tx.lease.findFirst({
        where: this.own(ctx, { id: leaseId }),
        select: { id: true, tenantId: true, buildingId: true, status: true, employerAgreementId: true },
      });
      if (!lease || (ctx.buildingIds && !ctx.buildingIds.includes(lease.buildingId)))
        throw new DomainException('http.not_found');
      let agreement: EmployerAgreement | null = null;
      if (agreementId) {
        agreement = await tx.employerAgreement.findFirst({ where: this.own(ctx, { id: agreementId }) });
        if (!agreement) throw new DomainException('http.not_found');
        if (agreement.state !== 'active') throw new DomainException('employer.invalid_state');
        if (agreement.buildingId && agreement.buildingId !== lease.buildingId)
          throw new DomainException('employer.building_mismatch');
      }
      if (!OPEN.includes(lease.status)) throw new DomainException('employer.invalid_state');
      if (lease.employerAgreementId !== (agreement?.id ?? null))
        await this.setPayer(tx, lease, agreement?.id ?? null, agreement?.employerPartyId ?? null, 'owner');
      return tx.lease.findUniqueOrThrow({
        where: { id: leaseId },
        select: { id: true, employerAgreementId: true, payerPartyId: true, version: true },
      });
    });
  }

  // ------------------------------------------------------------------------------------------- statement

  /**
   * The month's statement (works in a tenant transaction and in the export worker's): invoices addressed to the
   * employer for the agreement's leases, issued in the Bangkok month (not void), each split between the people who
   * stayed under the lease in the invoice period.
   */
  private async compute(tx: Tx, tenantId: string, id: string, month: string): Promise<Statement> {
    const agreement = await tx.employerAgreement.findFirst({
      where: { id, tenantId },
      include: { employer: { select: { displayName: true } }, workers: true },
    });
    if (!agreement) throw new DomainException('http.not_found');
    const { from, to } = bangkokMonthRange(month);
    const invoices = await tx.invoice.findMany({
      where: {
        tenantId,
        billedPartyId: agreement.employerPartyId,
        lease: { employerAgreementId: id },
        status: { notIn: ['draft', 'void'] },
        issuedAt: { gte: from, lt: to },
      },
      include: {
        unit: { select: { unitNo: true } },
        lease: { select: { id: true, lesseePartyId: true, lessee: { select: { displayName: true } } } },
      },
      orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
    });
    const leaseIds = [...new Set(invoices.map((i) => i.leaseId!))];
    const occupancies = leaseIds.length
      ? await tx.occupancy.findMany({
          where: { tenantId, leaseId: { in: leaseIds }, role: { in: [...STAYING] } },
          include: { party: { select: { displayName: true } } },
        })
      : [];
    const employeeNo = new Map(agreement.workers.map((w) => [w.partyId, w.employeeNo]));
    const deduct = new Decimal(agreement.deductPercent);
    const lines: StatementLine[] = invoices.map((inv) => {
      const staying = occupancies.filter(
        (o) =>
          o.leaseId === inv.leaseId &&
          o.validFrom <= inv.periodEnd &&
          (o.validTo === null || o.validTo >= inv.periodStart),
      );
      const people = orderPeople(
        [...new Map(staying.map((o) => [o.partyId, o])).values()].map((o) => ({
          partyId: o.partyId,
          name: o.party.displayName,
          employeeNo: employeeNo.get(o.partyId) ?? null,
        })),
      );
      const lessee: StatementPerson = {
        partyId: inv.lease!.lesseePartyId,
        name: inv.lease!.lessee.displayName,
        employeeNo: employeeNo.get(inv.lease!.lesseePartyId) ?? null,
      };
      return {
        invoiceId: inv.id,
        number: inv.number,
        leaseId: inv.leaseId!,
        unitNo: inv.unit?.unitNo ?? '',
        issuedAt: inv.issuedAt!,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        total: new Decimal(inv.total),
        paidTotal: new Decimal(inv.paidTotal),
        balance: new Decimal(inv.balance),
        shares: splitInvoice(new Decimal(inv.total), agreement.splitRule, people, lessee, deduct),
      };
    });
    const sum = (f: (l: StatementLine) => Decimal) => lines.reduce((n, l) => n.plus(f(l)), new Decimal(0));
    const deductions = lines.reduce(
      (n, l) => n.plus(l.shares.reduce((m, s) => m.plus(s.deduction), new Decimal(0))),
      new Decimal(0),
    );
    const total = sum((l) => l.total);
    return {
      agreement,
      employerName: agreement.employer.displayName,
      month,
      lines,
      total,
      paid: sum((l) => l.paidTotal),
      balance: sum((l) => l.balance),
      deductions,
      employerPays: total.minus(deductions),
    };
  }

  statement(ctx: TenantContext, id: string, month: string): Promise<Statement> {
    if (!MONTH.test(month)) throw invalid('month', 'a month YYYY-MM');
    return this.db.tenant(ctx, async (tx) => {
      await this.load(tx, ctx, id);
      return this.compute(tx, ctx.tenantId, id, month);
    });
  }

  /** `POST …/{id}/payroll-exports`: the agreement must be the tenant's (404 otherwise); built by the worker. */
  async requestPayrollExport(ctx: TenantContext, id: string, month: string) {
    if (!MONTH.test(month)) throw invalid('month', 'a month YYYY-MM');
    await this.get(ctx, id);
    return this.exports.request(ctx, {
      kind: 'payroll_deduction',
      params: { employerAgreementId: id, period: month },
    });
  }

  // ------------------------------------------------------------------------------------------- export builder

  validate(params: Record<string, unknown>) {
    const problems: { path: string; message: string }[] = [];
    if (typeof params.period !== 'string' || !MONTH.test(params.period))
      problems.push({ path: 'period', message: 'a month YYYY-MM' });
    if (typeof params.employerAgreementId !== 'string' || !UUID.test(params.employerAgreementId))
      problems.push({ path: 'employerAgreementId', message: 'an employer agreement id' });
    return problems;
  }

  async build(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const params = job.params as { employerAgreementId: string; period: string };
    const s = await this.compute(tx, job.tenantId, params.employerAgreementId, params.period);
    const rows: PayrollRow[] = s.lines.flatMap((l) =>
      l.shares.map((share) => ({
        employeeNo: share.employeeNo,
        name: share.name,
        unitNo: l.unitNo,
        invoiceNumber: l.number ?? '',
        share: share.share,
        deduction: share.deduction,
      })),
    );
    return {
      fileName: `payroll-deduction-${params.period}.csv`,
      mimeType: 'text/csv',
      body: payrollCsv(rows),
      rowCount: rows.length,
    };
  }
}
