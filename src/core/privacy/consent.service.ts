import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type ConsentChannel, type NotificationAudience } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';

export interface ConsentSubjectRef {
  type: 'user' | 'party';
  id: string;
}

export interface PurposeView {
  key: string;
  required: boolean;
  version: number;
  language: string;
  title: string;
  bodyMarkdown: string;
  effectiveFrom: Date;
  granted: boolean | null;
  grantedVersion: number | null;
  capturedAt: Date | null;
}

/**
 * PDPA consents (D-025): purposes are versioned per language; a consent is an append-only log row per subject,
 * purpose version and tenant (the tenant is the controller of resident data; `tenant_id` NULL for platform terms);
 * the current state is the latest row (`platform.v_consent_state`). A purpose whose current version is newer than the
 * one granted counts as not granted. Every change is audited and emits `consent.changed` (held notifications are
 * released when `resident.service` is granted).
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Tenants whose controller consents a resident user gives (tenants of the parties linked to the user). */
  residentTenants(userId: string): Promise<string[]> {
    return this.db.platform(async (tx) => {
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active' },
        select: { tenantId: true },
      });
      return [...new Set(links.map((l) => l.tenantId))];
    });
  }

  async purposes(
    audiences: NotificationAudience[],
    language: string,
    subject: ConsentSubjectRef,
    tenantId: string | null,
  ): Promise<PurposeView[]> {
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const purposes = await tx.consentPurpose.findMany({
        where: { audience: { in: audiences } },
        include: { versions: { where: { effectiveFrom: { lte: now } }, orderBy: { version: 'desc' } } },
        orderBy: { key: 'asc' },
      });
      const state = await tx.$queryRaw<
        { purpose_key: string; granted: boolean; purpose_version: number; captured_at: Date }[]
      >`
        SELECT DISTINCT ON (purpose_key) purpose_key, granted, purpose_version, captured_at FROM platform.v_consent_state
         WHERE subject_type = ${subject.type}::platform.consent_subject AND subject_id = ${subject.id}::uuid
           AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid OR tenant_id IS NULL)
         ORDER BY purpose_key, captured_at DESC`;
      const byKey = new Map(state.map((s) => [s.purpose_key, s]));
      return purposes.flatMap((p) => {
        const current =
          p.versions.find((v) => v.language === language) ?? p.versions.find((v) => v.language === 'th');
        if (!current) return [];
        const s = byKey.get(p.key);
        const valid = s && s.purpose_version >= current.version;
        return [
          {
            key: p.key,
            required: p.required,
            version: current.version,
            language: current.language,
            title: current.title,
            bodyMarkdown: current.bodyMarkdown,
            effectiveFrom: current.effectiveFrom,
            granted: valid ? s.granted : null,
            grantedVersion: s?.purpose_version ?? null,
            capturedAt: s?.captured_at ?? null,
          },
        ];
      });
    });
  }

  async record(
    subject: ConsentSubjectRef,
    items: { purposeKey: string; version: number; granted: boolean }[],
    input: { channel: ConsentChannel; language: string; tenantIds: (string | null)[] },
  ): Promise<number> {
    return this.db.platform(async (tx) => {
      let written = 0;
      for (const item of items)
        for (const tenantId of input.tenantIds) {
          await this.recordIn(tx, subject, item, { ...input, tenantId });
          written += 1;
        }
      return written;
    });
  }

  /**
   * Writes one consent row (+ audit + `consent.changed`) inside the caller's transaction and returns its id — for
   * flows that store the consent with what it allows (a review, an energy opt-in; G9, D-301).
   */
  async recordIn(
    tx: Tx,
    subject: ConsentSubjectRef,
    item: { purposeKey: string; version: number; granted: boolean },
    input: { channel: ConsentChannel; language: string; tenantId: string | null },
  ): Promise<{ id: string; purposeVersionId: string }> {
    const request = RequestContext.current();
    const now = this.clock.now();
    const version = await tx.consentPurposeVersion.findFirst({
      where: { purpose: { key: item.purposeKey }, version: item.version, language: input.language },
    });
    const fallback =
      version ??
      (await tx.consentPurposeVersion.findFirst({
        where: { purpose: { key: item.purposeKey }, version: item.version },
      }));
    if (!fallback) throw new DomainException('consent.unknown_purpose');
    const tenantId = input.tenantId;
    if (subject.type === 'party' && !tenantId) throw new DomainException('consent.unknown_purpose');
    const row = await tx.consent.create({
      data: {
        tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        purposeVersionId: fallback.id,
        granted: item.granted,
        capturedAt: now,
        channel: input.channel,
        ip: request?.ip ?? null,
        userAgent: request?.userAgent ?? null,
      },
    });
    await this.audit.record(tx, {
      action: 'consent.changed',
      tenantId,
      subjectType: 'platform.consent',
      subjectId: row.id,
      after: {
        subjectType: subject.type,
        subjectId: subject.id,
        purpose: item.purposeKey,
        version: item.version,
        granted: item.granted,
        channel: input.channel,
      },
    });
    await this.events.record(tx, {
      type: 'consent.changed',
      aggregateType: 'consent',
      aggregateId: row.id,
      tenantId,
      payload: {
        subjectType: subject.type,
        subjectId: subject.id,
        purposeKey: item.purposeKey,
        version: item.version,
        granted: item.granted,
      },
    });
    return { id: row.id, purposeVersionId: fallback.id };
  }

  /** The current (effective) version number of a purpose, or null when it has none yet. */
  async currentVersion(tx: Tx, purposeKey: string): Promise<number | null> {
    const v = await tx.consentPurposeVersion.findFirst({
      where: { purpose: { key: purposeKey }, effectiveFrom: { lte: this.clock.now() } },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return v?.version ?? null;
  }
}
