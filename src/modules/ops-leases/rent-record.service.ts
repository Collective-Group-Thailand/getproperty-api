import { createHash, randomBytes } from 'node:crypto';

import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { type RentRecordShare } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { type RentRecordFacts, rentRecordFacts } from './rent-record';

type Tx = Parameters<Parameters<TenantTx['platform']>[0]>[0];

/** Crockford base32 without look-alikes: a letter code is read aloud or typed from paper. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

export function newLetterCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

export function normaliseLetterCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 32);
}

const hashCode = (code: string) => createHash('sha256').update(normaliseLetterCode(code)).digest();

export type ShareWithLead = RentRecordShare & {
  lead: { id: string; listing: { titleTh: string | null }; tenant: { displayName: string } } | null;
};

/**
 * The portable rent record (B7.11, D-256): computed on read from the person's invoices (`rentRecordFacts` — facts,
 * no score), and shared only where the person chose — one enquiry (the owner sees it on the lead) or a letter with a
 * verification code anyone holding it can check — revocable at any time. Nothing is shared without a share row.
 */
@Injectable()
export class RentRecordService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The record of one person from the invoices of every party linked to their account (every tenant). */
  async facts(userId: string, tx?: Tx): Promise<RentRecordFacts> {
    const run = async (t: Tx) => {
      const links = await t.partyUserLink.findMany({
        where: { userId, state: 'active' },
        select: { partyId: true },
      });
      if (!links.length) return rentRecordFacts([], this.clock.now());
      const invoices = await t.invoice.findMany({
        where: {
          billedPartyId: { in: links.map((l) => l.partyId) },
          leaseId: { not: null },
          status: { notIn: ['draft', 'void'] },
          dueDate: { not: null },
        },
        select: {
          periodStart: true,
          dueDate: true,
          status: true,
          balance: true,
          allocations: {
            where: { reversedAt: null },
            select: { payment: { select: { paidAt: true, status: true, confirmedVia: true } } },
          },
        },
        orderBy: { periodStart: 'desc' },
        take: 360,
      });
      return rentRecordFacts(
        invoices.map((i) => ({
          periodStart: i.periodStart,
          dueDate: i.dueDate,
          status: i.status,
          balance: i.balance.toFixed(2),
          payments: i.allocations.map((a) => a.payment),
        })),
        this.clock.now(),
      );
    };
    return tx ? run(tx) : this.db.platform(run);
  }

  /** My record and everything I shared (newest first). */
  async mine(userId: string) {
    return this.db.platform(async (tx) => ({
      facts: await this.facts(userId, tx),
      shares: await this.sharesOf(tx, userId),
    }));
  }

  private sharesOf(tx: Tx, userId: string): Promise<ShareWithLead[]> {
    return tx.rentRecordShare.findMany({
      where: { userId },
      include: {
        lead: {
          select: {
            id: true,
            listing: { select: { titleTh: true } },
            tenant: { select: { displayName: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** `live` / `revoked` / `expired` of a share at `now`. */
  stateOf(share: RentRecordShare): 'live' | 'revoked' | 'expired' {
    if (share.revokedAt) return 'revoked';
    if (share.expiresAt && share.expiresAt <= this.clock.now()) return 'expired';
    return 'live';
  }

  private async requireRecord(tx: Tx, userId: string): Promise<void> {
    const facts = await this.facts(userId, tx);
    if (!facts.months.length) throw new DomainException('rent_record.empty');
  }

  /** Shares my record with one of my enquiries; the same enquiry again answers the live share. */
  async shareWithLead(userId: string, leadId: string): Promise<ShareWithLead> {
    return this.db.platform(async (tx) => {
      const lead = await tx.listingLead.findFirst({
        where: { id: leadId, userId },
        select: { id: true, tenantId: true },
      });
      if (!lead) throw new DomainException('http.not_found');
      const live = await tx.rentRecordShare.findFirst({ where: { leadId, revokedAt: null } });
      if (!live) {
        await this.requireRecord(tx, userId);
        const row = await tx.rentRecordShare.create({ data: { userId, kind: 'enquiry', leadId } });
        await this.audit.record(tx, {
          action: 'rent_record.shared',
          tenantId: lead.tenantId,
          subjectType: 'platform.rent_record_share',
          subjectId: row.id,
          metadata: { kind: 'enquiry', leadId },
        });
        await this.events.record(tx, {
          type: 'rent_record.shared',
          aggregateType: 'rent_record_share',
          aggregateId: row.id,
          tenantId: lead.tenantId,
          payload: { shareId: row.id, kind: 'enquiry', leadId },
        });
      }
      return (await this.sharesOf(tx, userId)).find((s) => s.leadId === leadId && !s.revokedAt)!;
    });
  }

  /** A letter: a verification code shown once (only its sha256 is kept), valid `rent_record.letter.valid_days`. */
  async createLetter(userId: string): Promise<{ share: ShareWithLead; code: string }> {
    const days = Number(
      (await this.settings.valueAt<number>('rent_record.letter.valid_days', this.clock.now(), {})) ?? 90,
    );
    return this.db.platform(async (tx) => {
      await this.requireRecord(tx, userId);
      const code = newLetterCode();
      const row = await tx.rentRecordShare.create({
        data: {
          userId,
          kind: 'letter',
          codeHash: hashCode(code),
          codeHint: code.slice(-4),
          expiresAt: new Date(this.clock.now().getTime() + days * 86_400_000),
        },
      });
      await this.audit.record(tx, {
        action: 'rent_record.shared',
        tenantId: null,
        subjectType: 'platform.rent_record_share',
        subjectId: row.id,
        metadata: { kind: 'letter' },
      });
      await this.events.record(tx, {
        type: 'rent_record.shared',
        aggregateType: 'rent_record_share',
        aggregateId: row.id,
        tenantId: null,
        payload: { shareId: row.id, kind: 'letter', leadId: null },
      });
      return { share: { ...row, lead: null }, code };
    });
  }

  /** Revokes one of my shares at once (idempotent). */
  async revoke(userId: string, shareId: string): Promise<ShareWithLead> {
    return this.db.platform(async (tx) => {
      const share = await tx.rentRecordShare.findFirst({
        where: { id: shareId, userId },
        include: { lead: { select: { tenantId: true } } },
      });
      if (!share) throw new DomainException('http.not_found');
      if (!share.revokedAt) {
        await tx.rentRecordShare.update({ where: { id: share.id }, data: { revokedAt: this.clock.now() } });
        await this.audit.record(tx, {
          action: 'rent_record.share_revoked',
          tenantId: share.lead?.tenantId ?? null,
          subjectType: 'platform.rent_record_share',
          subjectId: share.id,
          metadata: { kind: share.kind },
        });
        await this.events.record(tx, {
          type: 'rent_record.share_revoked',
          aggregateType: 'rent_record_share',
          aggregateId: share.id,
          tenantId: share.lead?.tenantId ?? null,
          payload: { shareId: share.id, kind: share.kind, leadId: share.leadId },
        });
      }
      return (await this.sharesOf(tx, userId)).find((s) => s.id === shareId)!;
    });
  }

  /** The live share per enquiry among `leadIds` (prospect views). */
  async liveShares(leadIds: string[]): Promise<Map<string, string>> {
    if (!leadIds.length) return new Map();
    const rows = await this.db.platform((tx) =>
      tx.rentRecordShare.findMany({
        where: { leadId: { in: leadIds }, revokedAt: null },
        select: { id: true, leadId: true },
      }),
    );
    return new Map(rows.map((r) => [r.leadId!, r.id]));
  }

  /** What the owner sees on their leads: the record of each prospect who shared it with that enquiry. */
  async forLeads(leadIds: string[]): Promise<Map<string, RentRecordFacts & { sharedAt: Date }>> {
    if (!leadIds.length) return new Map();
    return this.db.platform(async (tx) => {
      const shares = await tx.rentRecordShare.findMany({
        where: { leadId: { in: leadIds }, revokedAt: null, kind: 'enquiry' },
        select: { leadId: true, userId: true, createdAt: true },
      });
      const out = new Map<string, RentRecordFacts & { sharedAt: Date }>();
      for (const share of shares)
        out.set(share.leadId!, { ...(await this.facts(share.userId, tx)), sharedAt: share.createdAt });
      return out;
    });
  }

  /** `GET /v1/public/rent-records/{code}`: a live letter's record and holder; anything else is a 404. */
  async byCode(code: string) {
    const normalised = normaliseLetterCode(code);
    if (normalised.length !== CODE_LENGTH) throw new DomainException('http.not_found');
    return this.db.platform(async (tx) => {
      const share = await tx.rentRecordShare.findFirst({
        where: { codeHash: hashCode(normalised), kind: 'letter' },
        include: { user: { select: { displayName: true } } },
      });
      if (!share || this.stateOf(share) !== 'live') throw new DomainException('http.not_found');
      return {
        holderName: share.user.displayName,
        issuedAt: share.createdAt,
        expiresAt: share.expiresAt!,
        facts: await this.facts(share.userId, tx),
      };
    });
  }
}
