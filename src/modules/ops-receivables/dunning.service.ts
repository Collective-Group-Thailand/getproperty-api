import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { evaluateLateFeePolicy } from '@core/compliance/evaluators';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type QuietHours, quietUntil } from '@core/notifications/quiet-hours';
import { SettingsService } from '@core/settings/settings.service';
import { WorkflowService } from '@core/workflow/workflow.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type DunningReminder,
  type Invoice,
  type PenaltyAssessment,
  type Prisma,
} from '@generated/prisma/client';
import { InvoicesService, LATE_FEE_TERM } from '@modules/ops-billing/invoices.service';
import { PaymentsService } from '@modules/ops-payments/payments.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { daysPastDue } from './aging';

const by = () => userIdOf(RequestContext.actor());
const OPEN: Invoice['status'][] = ['issued', 'partially_paid', 'overdue'];
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** The days after the due date of `reminders.schedule`: positive whole days, unique, ascending. */
export function scheduleDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is number => Number.isInteger(v) && v > 0 && v <= 365))].sort(
    (a, b) => a - b,
  );
}

/**
 * Light dunning (B4.5, D-045, blueprint A2.5) on the workflow engine (D-159): when an invoice becomes overdue a
 * `dunning` instance starts with one step timer per day of `reminders.schedule` after the due date (00:00 Asia/Bangkok;
 * the notification service holds it through quiet hours); each step sends the LINE Flex reminder with the payment
 * link (the QR refreshed for what is due) unless the invoice was paid meanwhile; paying or voiding the invoice closes
 * the instance and cancels the steps left. The owner can "send a reminder now". The late fee is assessed once when
 * the invoice becomes overdue — only when `late_fee.enabled`, an amount is set and compliance.late_fee_policy allows
 * (⚖ O-002) — as a charge for the next invoice, never on the issued one. Nothing else is automatic (D-024).
 */
@Injectable()
export class DunningService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'dunning';
  readonly eventTypes = ['invoice.overdue', 'workflow.step_due', 'invoice.paid', 'invoice.voided'] as const;
  private readonly logger = new Logger(DunningService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly workflow: WorkflowService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    switch (event.type) {
      case 'invoice.overdue': {
        const id = event.payload.invoiceId as string;
        await this.start(tx, id);
        await this.assessPenalty(tx, id);
        return;
      }
      case 'workflow.step_due':
        if (event.payload.definitionKey === 'dunning')
          await this.runStep(tx, event.payload.timerId as string);
        return;
      case 'invoice.paid':
      case 'invoice.voided':
        await this.stop(
          tx,
          event.payload.invoiceId as string,
          event.type === 'invoice.paid' ? 'pay' : 'cancel',
        );
        return;
      default:
        return;
    }
  }

  private openInstance(tx: Tx, invoiceId: string) {
    return tx.workflowInstance.findFirst({
      where: {
        subjectType: 'ops.invoice',
        subjectId: invoiceId,
        closedAt: null,
        definition: { key: 'dunning' },
      },
    });
  }

  /** Starts the reminders of an overdue invoice (idempotent). */
  async start(tx: Tx, invoiceId: string): Promise<DunningReminder[]> {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (inv.status !== 'overdue' || !inv.dueDate || new Decimal(inv.balance.toString()).lte(0)) return [];
    if (await this.openInstance(tx, invoiceId)) return [];
    if (await tx.dunningReminder.count({ where: { invoiceId, triggeredBy: 'schedule' } })) return [];
    const days = scheduleDays(
      await this.settings.valueAt<unknown>('reminders.schedule', this.clock.now(), {
        tenantId: inv.tenantId,
      }),
    );
    const instance = await this.workflow.start(tx, {
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      subjectType: 'ops.invoice',
      subjectId: inv.id,
      definitionKey: 'dunning',
      context: { number: inv.number, dueDate: dayOf(inv.dueDate), schedule: days },
    });
    const dueOn = dayOf(inv.dueDate);
    const fireAts = days.map((d) => startOfBangkokDay(addCalendarDays(dueOn, d)));
    const timers = await this.workflow.addStepTimers(tx, instance, fireAts);
    const rows: DunningReminder[] = [];
    for (const [i, d] of days.entries())
      rows.push(
        await tx.dunningReminder.create({
          data: {
            tenantId: inv.tenantId,
            buildingId: inv.buildingId,
            invoiceId: inv.id,
            workflowInstanceId: instance.id,
            timerId: timers[i]!.id,
            step: d,
            scheduledFor: timers[i]!.fireAt,
            triggeredBy: 'schedule',
          },
        }),
      );
    return rows;
  }

  private async runStep(tx: Tx, timerId: string): Promise<void> {
    const reminder = await tx.dunningReminder.findFirst({ where: { timerId, status: 'scheduled' } });
    if (!reminder) return;
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: reminder.invoiceId } });
    if (!OPEN.includes(inv.status) || new Decimal(inv.balance.toString()).lte(0)) {
      await tx.dunningReminder.update({ where: { id: reminder.id }, data: { status: 'skipped_paid' } });
      return;
    }
    await this.send(tx, reminder, inv);
  }

  /** Sends one reminder: the QR refreshed for what is due, the Flex through the notification service. */
  private async send(tx: Tx, reminder: DunningReminder, inv: Invoice): Promise<DunningReminder> {
    const now = this.clock.now();
    await tx.$executeRawUnsafe('SAVEPOINT dunning_qr');
    try {
      await this.payments.ensureQr(tx, inv.id);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT dunning_qr');
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT dunning_qr');
      this.logger.warn(`reminder ${reminder.id}: QR refresh failed: ${(error as Error).message}`);
    }
    const quiet = await this.settings.valueAt<QuietHours>('notifications.quiet_hours', now, {
      tenantId: inv.tenantId,
    });
    const held = quiet ? quietUntil(now, quiet) : null;
    const due = await this.payments.dueFor(tx, inv);
    const daysOverdue = inv.dueDate ? Math.max(0, daysPastDue(dayOf(inv.dueDate), bangkokDate(now))) : 0;
    const updated = await tx.dunningReminder.update({
      where: { id: reminder.id },
      data: { status: held ? 'deferred_quiet_hours' : 'sent', sentAt: now },
    });
    await this.events.record(tx, {
      type: 'invoice.reminder_sent',
      aggregateType: 'invoice',
      aggregateId: inv.id,
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      payload: {
        invoiceId: inv.id,
        number: inv.number,
        reminderId: reminder.id,
        step: reminder.step,
        triggeredBy: reminder.triggeredBy,
        balance: inv.balance.toFixed(2),
        due: due.toFixed(2),
        daysOverdue,
        heldUntil: held?.toISOString() ?? null,
      },
    });
    return updated;
  }

  /** Paid or voided: the instance closes (its timers are cancelled) and the steps left are skipped. */
  private async stop(tx: Tx, invoiceId: string, event: 'pay' | 'cancel'): Promise<void> {
    const instance = await this.openInstance(tx, invoiceId);
    if (instance) await this.workflow.transition(tx, instance.id, event, { invoiceId });
    await tx.dunningReminder.updateMany({
      where: { invoiceId, status: 'scheduled' },
      data: { status: event === 'pay' ? 'skipped_paid' : 'cancelled' },
    });
    if (event === 'cancel') {
      // a voided invoice owes nothing: its late fee waiting for the next invoice goes too
      const pending = await tx.penaltyAssessment.findMany({ where: { invoiceId, status: 'pending' } });
      for (const p of pending) {
        if (p.invoiceChargeId)
          await tx.invoiceCharge.updateMany({
            where: { id: p.invoiceChargeId, status: 'pending' },
            data: {
              status: 'cancelled',
              cancelledAt: this.clock.now(),
              cancelReason: 'invoice voided',
              updatedBy: by(),
            },
          });
        await tx.penaltyAssessment.update({
          where: { id: p.id },
          data: { status: 'waived', updatedBy: by(), version: { increment: 1 } },
        });
      }
    }
  }

  // ------------------------------------------------------------------------------------------- penalty

  /**
   * The late fee of an overdue invoice (D-045, ⚖ O-002): nothing unless `late_fee.enabled` and `late_fee.amount` > 0;
   * then compliance.late_fee_policy decides with the lease terms — allowed → a pending `late_fee` charge (source
   * `penalty`) the next invoice of the unit × party picks up; refused → a waived assessment kept for the record.
   */
  async assessPenalty(tx: Tx, invoiceId: string): Promise<PenaltyAssessment | null> {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const existing = await tx.penaltyAssessment.findUnique({ where: { invoiceId } });
    if (existing) return existing;
    const now = this.clock.now();
    const scope = { tenantId: inv.tenantId };
    const enabled = (await this.settings.valueAt<boolean>('late_fee.enabled', now, scope)) === true;
    if (!enabled) return null;
    const amount = new Decimal(
      (await this.settings.valueAt<string>('late_fee.amount', now, scope)) ?? '0',
    ).toDecimalPlaces(2);
    if (amount.lte(0)) return null;
    const lease = inv.leaseId
      ? await tx.lease.findUnique({ where: { id: inv.leaseId }, include: { lines: true } })
      : null;
    const terms = [
      ...((lease?.addendum ?? []) as { title?: string; text?: string }[]).map(
        (c) => `${c.title ?? ''} ${c.text ?? ''}`,
      ),
      ...(lease?.lines ?? []).map((l) => l.description),
    ];
    const check = evaluateLateFeePolicy({
      lateFeeEnabled: enabled,
      contractStatesLateFee: terms.some((t) => LATE_FEE_TERM.test(t)),
      amount,
      agreedAmount: null,
    });
    const allowed = !check.violated && inv.unitId !== null;
    const penalty = await tx.penaltyAssessment.create({
      data: {
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        invoiceId: inv.id,
        leaseId: inv.leaseId,
        partyId: inv.billedPartyId,
        unitId: inv.unitId,
        amount: amount.toFixed(2),
        basis: {
          setting: 'late_fee.amount',
          dueDate: inv.dueDate ? dayOf(inv.dueDate) : null,
          balance: inv.balance.toFixed(2),
          check: check.context,
          errors: check.errors ?? [],
        } as unknown as Prisma.InputJsonValue,
        allowed,
        status: allowed ? 'pending' : 'waived',
        createdBy: by(),
      },
    });
    if (allowed) {
      const charge = await tx.invoiceCharge.create({
        data: {
          tenantId: inv.tenantId,
          buildingId: inv.buildingId,
          unitId: inv.unitId!,
          partyId: inv.billedPartyId,
          leaseId: inv.leaseId,
          sourceType: 'penalty',
          lineKind: 'late_fee',
          sourceId: penalty.id,
          description: `ค่าปรับชำระล่าช้า ใบแจ้งหนี้ ${inv.number ?? ''}`.trim(),
          quantity: '1',
          unitPrice: amount.toFixed(4),
          amount: amount.toFixed(2),
          createdBy: by(),
        },
      });
      await tx.penaltyAssessment.update({ where: { id: penalty.id }, data: { invoiceChargeId: charge.id } });
    }
    await this.audit.record(tx, {
      action: 'penalty.assessed',
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      subjectType: 'ops.penalty_assessment',
      subjectId: penalty.id,
      metadata: { invoiceId: inv.id, amount: amount.toFixed(2), allowed, ruleId: check.ruleId },
    });
    await this.events.record(tx, {
      type: 'penalty.assessed',
      aggregateType: 'penalty_assessment',
      aggregateId: penalty.id,
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      payload: { penaltyId: penalty.id, invoiceId: inv.id, amount: amount.toFixed(2), allowed },
    });
    return tx.penaltyAssessment.findUniqueOrThrow({ where: { id: penalty.id } });
  }

  // ------------------------------------------------------------------------------------------- owner

  /** `POST /v1/owner/invoices/{id}/actions/send-reminder`: a reminder now, for any open invoice with a balance. */
  async sendNow(ctx: TenantContext, invoiceId: string): Promise<DunningReminder> {
    return this.db.tenant(ctx, async (tx) => {
      const inv = await this.invoices.load(tx, ctx, invoiceId);
      if (inv.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (!OPEN.includes(inv.status) || new Decimal(inv.balance.toString()).lte(0))
        throw new DomainException('invoice.nothing_due');
      const instance = await this.openInstance(tx, invoiceId);
      const reminder = await tx.dunningReminder.create({
        data: {
          tenantId: inv.tenantId,
          buildingId: inv.buildingId,
          invoiceId,
          workflowInstanceId: instance?.id ?? null,
          step: 0,
          scheduledFor: this.clock.now(),
          triggeredBy: 'owner',
          createdBy: by(),
        },
      });
      const sent = await this.send(tx, reminder, inv);
      await this.audit.record(tx, {
        action: 'dunning.reminder_sent',
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        subjectType: 'ops.invoice',
        subjectId: invoiceId,
        metadata: { reminderId: reminder.id, number: inv.number, balance: inv.balance.toFixed(2) },
      });
      return sent;
    });
  }

  /** The reminders of an invoice, scheduled and sent (`GET /v1/owner/invoices/{id}/reminders`). */
  reminders(ctx: TenantContext, invoiceId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.invoices.load(tx, ctx, invoiceId);
      const [rows, penalty] = await Promise.all([
        tx.dunningReminder.findMany({
          where: { tenantId: ctx.tenantId, invoiceId },
          orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        }),
        tx.penaltyAssessment.findUnique({ where: { invoiceId } }),
      ]);
      return { rows, penalty: penalty?.tenantId === ctx.tenantId ? penalty : null };
    });
  }
}
