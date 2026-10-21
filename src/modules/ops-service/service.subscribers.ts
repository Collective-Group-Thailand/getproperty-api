import { systemTenantContext } from '@common/context/tenant-context';
import { FieldEncryption } from '@common/crypto/field-encryption';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import {
  billedParty,
  operators,
  type Recipient,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { registerRealtimeChannels } from '@core/subscribers/subscribers';
import { type Tx } from '@database/prisma.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { IntegrationEventsService } from '../bridge-integrations/integration-events.service';
import { SERVICE_REQUEST_SUBJECT, ServiceRequestsService } from './service-requests.service';
import { AUTO_REASONS, AUTO_REQUEST_DEDUP_MS, autoRequestCategory } from './service-rules';

/** Thai / English labels of request statuses for resident messages. */
const STATUS_LABELS: Record<string, { th: string; en: string }> = {
  new: { th: 'รับเรื่องแล้ว', en: 'received' },
  triaged: { th: 'กำลังพิจารณา', en: 'being reviewed' },
  assigned: { th: 'มอบหมายช่างแล้ว', en: 'technician assigned' },
  in_progress: { th: 'กำลังดำเนินการ', en: 'in progress' },
  waiting_parts: { th: 'รออะไหล่', en: 'waiting for parts' },
  done: { th: 'ซ่อมเสร็จแล้ว โปรดให้คะแนน', en: 'done — please rate it' },
  closed: { th: 'ปิดงานแล้ว', en: 'closed' },
  cancelled: { th: 'ยกเลิกแล้ว', en: 'cancelled' },
};

/** A party as a technician recipient (its LINE id or the LINE of its linked login). */
async function technicianParty(tx: Tx, partyId: string): Promise<Recipient[]> {
  return (await billedParty(tx, partyId)).map((r) => ({ ...r, audience: 'technician' as const }));
}

async function userRecipient(tx: Tx, userId: string, tenantId: string): Promise<Recipient[]> {
  const u = await tx.userAccount.findUnique({ where: { id: userId } });
  if (!u || u.status !== 'active') return [];
  const m = await tx.membership.findFirst({ where: { userId, tenantId, status: 'active', deletedAt: null } });
  return [
    {
      audience: (m?.role as Recipient['audience'] | undefined) ?? 'staff',
      type: 'user',
      id: u.id,
      tenantId,
      language: u.language,
      line: u.lineUserId,
      phone: u.phoneVerifiedAt ? u.phoneE164 : null,
      email: u.emailVerifiedAt ? u.email : null,
    },
  ];
}

/** Request summary for templates. */
async function requestData(tx: Tx, id: string) {
  const sr = await tx.serviceRequest.findUnique({
    where: { id },
    include: { category: true, unit: { select: { unitNo: true } }, building: { select: { name: true } } },
  });
  if (!sr) return null;
  return {
    sr,
    data: {
      id: sr.id,
      ref: sr.id.slice(-6).toUpperCase(),
      category: sr.category.nameTh,
      categoryEn: sr.category.nameEn,
      unitNo: sr.unit?.unitNo ?? sr.building.name,
      description: sr.description.slice(0, 120),
      priority: sr.priority,
    },
  };
}

/** The logins linked to parties (realtime `user:` channels). */
async function linkedUsers(tx: Tx, partyIds: string[]): Promise<string[]> {
  if (!partyIds.length) return [];
  const links = await tx.partyUserLink.findMany({
    where: { partyId: { in: partyIds }, state: 'active' },
    select: { userId: true },
  });
  return links.map((l) => l.userId);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Notifications and realtime channels of B5.1 (D-072): the resident on each state change of their request (LINE,
 * quiet hours and consent apply, topic `service_requests`), the operators when a request arrives, the assignee
 * (staff login or technician party) on assignment; the owner on an SLA breach comes from `workflow.sla_breached`.
 * Realtime: request events go to `unit:<id>` and the requester's logins; work-order events to the assignee's logins.
 * LIFF #28 (D-218): every resident / technician LINE message carries `link`, the screen of the app it opens
 * (`PUBLIC_RESIDENT_APP_URL/requests/{id}`, `…/technician/work-orders/{id}`). LIFF #23 / #24: a message in a thread
 * tells the resident and the technicians who did not write it; a confirmed visit tells the technician.
 */
@Injectable()
export class ServiceNotifications implements OnModuleInit {
  constructor(private readonly config: AppConfig) {}

  private link(path: string): string {
    return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}${path}`;
  }

  onModuleInit(): void {
    registerNotifiable('service_request.created', async (tx, e) => {
      if (!e.tenantId) return null;
      const r = await requestData(tx, e.payload.serviceRequestId as string);
      if (!r) return null;
      return {
        recipients: await operators(tx, e.tenantId, ['owner', 'manager', 'staff'], 'owner'),
        data: { tenant: { name: await tenantName(tx, e.tenantId) }, request: r.data },
        urgent: r.sr.priority === 'urgent',
      };
    });
    registerNotifiable('service_request.changed', async (tx, e) => {
      const partyId = e.payload.requesterPartyId as string | null;
      if (!e.tenantId || !partyId || e.payload.reporterKind !== 'resident') return null;
      const r = await requestData(tx, e.payload.serviceRequestId as string);
      if (!r) return null;
      const label = STATUS_LABELS[e.payload.to as string] ?? {
        th: String(e.payload.to),
        en: String(e.payload.to),
      };
      return {
        recipients: await billedParty(tx, partyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          request: { ...r.data, statusTh: label.th, statusEn: label.en },
          link: this.link(`/requests/${r.sr.id}`),
        },
        consentPurpose: 'resident.service',
      };
    });
    registerNotifiable('work_order.assigned', async (tx, e) => {
      if (!e.tenantId) return null;
      const wo = await tx.workOrder.findUnique({
        where: { id: e.payload.workOrderId as string },
        include: { unit: { select: { unitNo: true } }, building: { select: { name: true } } },
      });
      if (!wo) return null;
      const userId = e.payload.assigneeUserId as string | null;
      const partyId = e.payload.assigneePartyId as string | null;
      const recipients = userId
        ? await userRecipient(tx, userId, e.tenantId)
        : partyId
          ? await technicianParty(tx, partyId)
          : [];
      return {
        recipients,
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          workOrder: {
            id: wo.id,
            ref: wo.id.slice(-6).toUpperCase(),
            title: wo.title,
            kind: wo.kind,
            place: wo.unit?.unitNo ?? wo.building.name,
            scheduledAt: wo.scheduledAt?.toISOString() ?? '-',
          },
          link: this.link(`/technician/work-orders/${wo.id}`),
        },
        consentPurpose: 'resident.service',
      };
    });
    registerNotifiable('service_request.message', async (tx, e) => {
      if (!e.tenantId) return null;
      const p = e.payload;
      const author = p.authorKind as string;
      const requestId = typeof p.serviceRequestId === 'string' ? p.serviceRequestId : null;
      const sr = requestId ? await requestData(tx, requestId) : null;
      const recipients: Recipient[] = [];
      // the resident who reported it, unless they wrote it
      if (
        sr &&
        author !== 'resident' &&
        sr.sr.reporterKind === 'resident' &&
        typeof p.requesterPartyId === 'string'
      )
        recipients.push(...(await billedParty(tx, p.requesterPartyId)));
      // the technicians of the thread's active work orders, unless they wrote it
      for (const partyId of strings(p.assigneePartyIds))
        if (partyId !== p.authorPartyId) recipients.push(...(await technicianParty(tx, partyId)));
      if (!recipients.length) return null;
      const message = await tx.serviceMessage.findUnique({ where: { id: p.messageId as string } });
      if (!message) return null;
      const workOrderId = (p.workOrderId as string | null) ?? strings(p.workOrderIds)[0] ?? null;
      return {
        recipients,
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          request: sr?.data ?? { ref: (workOrderId ?? '').slice(-6).toUpperCase(), unitNo: '-' },
          message: { authorName: message.authorName, excerpt: message.body.slice(0, 120) },
          link: requestId
            ? this.link(`/requests/${requestId}`)
            : this.link(`/technician/work-orders/${workOrderId}`),
          technicianLink: workOrderId ? this.link(`/technician/work-orders/${workOrderId}`) : null,
        },
        consentPurpose: 'resident.service',
      };
    });
    registerNotifiable('service_request.visit_confirmed', async (tx, e) => {
      const partyId = e.payload.assigneePartyId as string | null;
      if (!e.tenantId || !partyId) return null;
      const r = await requestData(tx, e.payload.serviceRequestId as string);
      if (!r) return null;
      return {
        recipients: await technicianParty(tx, partyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          request: r.data,
          visit: { scheduledAt: e.payload.scheduledAt as string },
          link: this.link(`/technician/work-orders/${e.payload.workOrderId as string}`),
        },
        consentPurpose: 'resident.service',
      };
    });

    // LIFF #23 / #24: messages and visit confirmations reach the unit, the requester's and the assignees' logins
    registerRealtimeChannels(
      ['service_request.message', 'service_request.visit_confirmed'],
      async (tx, e) => {
        const p = e.payload;
        const channels: string[] = [];
        if (typeof p.unitId === 'string') channels.push(`unit:${p.unitId}`);
        const workOrders = [...strings(p.workOrderIds), ...strings([p.workOrderId])];
        channels.push(...new Set(workOrders.map((w) => `work_order:${w}`)));
        const parties = [
          ...(typeof p.requesterPartyId === 'string' ? [p.requesterPartyId] : []),
          ...strings(p.assigneePartyIds),
          ...strings([p.assigneePartyId]),
        ];
        const users = [
          ...(await linkedUsers(tx, parties)),
          ...strings(p.assigneeUserIds),
          ...strings([p.assigneeUserId]),
        ];
        return [...channels, ...new Set(users.map((u) => `user:${u}`))];
      },
    );
    registerRealtimeChannels(
      ['service_request.created', 'service_request.changed', 'service_request.rated'],
      async (tx, e) => {
        const channels: string[] = [];
        if (typeof e.payload.unitId === 'string') channels.push(`unit:${e.payload.unitId}`);
        const partyId = e.payload.requesterPartyId;
        if (typeof partyId === 'string') {
          const links = await tx.partyUserLink.findMany({
            where: { partyId, state: 'active' },
            select: { userId: true },
          });
          channels.push(...links.map((l) => `user:${l.userId}`));
        }
        return channels;
      },
    );
    registerRealtimeChannels(
      ['work_order.assigned', 'work_order.changed', 'work_order.completed', 'work_order.cost_changed'],
      async (tx, e) => {
        const channels = [`work_order:${e.aggregateId}`];
        const userIds = [e.payload.assigneeUserId, e.payload.previousAssigneeUserId].filter(
          (x): x is string => typeof x === 'string',
        );
        const partyIds = [e.payload.assigneePartyId, e.payload.previousAssigneePartyId].filter(
          (x): x is string => typeof x === 'string',
        );
        if (partyIds.length) {
          const links = await tx.partyUserLink.findMany({
            where: { partyId: { in: partyIds }, state: 'active' },
            select: { userId: true },
          });
          userIds.push(...links.map((l) => l.userId));
        }
        return [...channels, ...new Set(userIds.map((u) => `user:${u}`))];
      },
    );
  }
}

/**
 * Automatic requests (D-034, B5.1): a stale or silent meter (`meter.stale`, `service.auto_request_requested`), a
 * gateway offline (`device.offline`) or a lock with a low battery (B5.2) opens a `system` request on the asset item
 * — at most one per asset item per 24 h (an advisory lock per item serialises concurrent events).
 */
@Injectable()
export class AutoServiceRequests implements EventSubscriber, OnModuleInit {
  private readonly logger = new Logger(AutoServiceRequests.name);
  readonly name = 'service-auto-requests';
  readonly eventTypes = ['service.auto_request_requested', 'meter.stale', 'device.offline'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly requests: ServiceRequestsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (!event.tenantId) return;
    let assetItemId: string;
    let reason: string;
    let label: string;
    if (event.type === 'device.offline') {
      const device = await tx.device.findUnique({ where: { id: event.aggregateId } });
      if (device?.kind !== 'gateway' || !device.assetItemId) return;
      assetItemId = device.assetItemId;
      reason = 'gateway_offline';
      label = device.serial;
    } else {
      assetItemId = (event.payload.assetItemId as string | undefined) ?? event.aggregateId;
      const p = event.payload as { reason?: string; code?: string; serial?: string };
      reason = event.type === 'meter.stale' ? 'meter_stale' : (p.reason ?? 'meter_silent');
      label = p.code ?? p.serial ?? '';
    }
    await this.open(tx, event, assetItemId, reason, label);
  }

  async open(tx: Tx, event: DomainEventEnvelope, assetItemId: string, reason: string, label: string) {
    const item = await tx.assetItem.findUnique({ where: { id: assetItemId } });
    if (!item || item.deletedAt || item.tenantId !== event.tenantId) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auto_sr:${assetItemId}`}, 0))`;
    const since = new Date(this.clock.now().getTime() - AUTO_REQUEST_DEDUP_MS);
    const recent = await tx.serviceRequest.count({
      where: { assetItemId, reporterKind: 'system', createdAt: { gte: since } },
    });
    if (recent) {
      this.logger.log({ event: 'auto_request_deduplicated', assetItemId, reason });
      return;
    }
    const text = AUTO_REASONS[reason] ?? { th: reason, en: reason };
    await this.requests.open(tx, systemTenantContext(item.tenantId), {
      assetItemId,
      buildingId: item.buildingId,
      unitId: item.unitId,
      categoryKey: autoRequestCategory(item.category, event.payload.utility),
      description: `${text.th}${label ? ` — ${label}` : ''} (${text.en})`,
      priority: 'high',
      reporterKind: 'system',
      autoReason: reason,
      sourceDeviceEventId:
        typeof event.payload.deviceEventId === 'string' ? event.payload.deviceEventId : null,
    });
  }
}

/**
 * Warranty hook (blueprint A4.6, D-153): a referred request writes one outbound `warranty.defect.reported`
 * (`bridge.integration_event`, contract of @collective/asset-core, status `pending` — stored and never sent until
 * getbuild exists); `warranty.defect.closed` from getbuild closes the request (`fixed`, `replaced`, `duplicate`) or
 * hands it back to the building (`not_a_defect`, `out_of_warranty` → triaged, the owner assigns it).
 */
@Injectable()
export class WarrantyBridge implements EventSubscriber, OnModuleInit {
  readonly name = 'warranty-bridge';
  readonly eventTypes = ['service_request.warranty_referred'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly integrations: IntegrationEventsService,
    private readonly requests: ServiceRequestsService,
    private readonly documents: DocumentsService,
    private readonly crypto: FieldEncryption,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.integrations.onInbound('warranty.defect.closed', (tx, envelope, row) =>
      this.closed(tx, envelope, row.id),
    );
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const sr = await tx.serviceRequest.findUnique({
      where: { id: event.payload.serviceRequestId as string },
      include: {
        category: true,
        building: { select: { id: true, sourceRef: true } },
        unit: { select: { sourceRef: true } },
        assetItem: { select: { sourceRef: true } },
        requester: { select: { displayName: true, phoneE164: true } },
      },
    });
    if (!sr || !sr.inWarranty) return;
    const photos = await tx.attachment.findMany({
      where: { subjectType: SERVICE_REQUEST_SUBJECT, subjectId: sr.id, role: 'report' },
      include: { document: true },
      orderBy: { position: 'asc' },
      take: 20,
    });
    const urls: string[] = [];
    for (const p of photos) {
      const { url } = await this.documents.signedUrl(p.document);
      if (url.startsWith('https://')) urls.push(url);
    }
    const reporter = JSON.stringify({
      name: sr.requester?.displayName ?? null,
      phone: sr.requester?.phoneE164 ?? null,
    });
    const envelope = {
      eventId: uuidv7(this.clock.now().getTime()),
      type: 'warranty.defect.reported',
      version: 1,
      occurredAt: event.occurredAt,
      idempotencyKey: `getproperty:service_request:${sr.id}:reported`,
      sourcePlatform: 'getproperty',
      tenantId: sr.tenantId,
      correlationId: event.correlationId,
      causationId: event.id,
      payload: {
        serviceRequestId: sr.id,
        buildingRef: sr.building.sourceRef ?? sr.building.id,
        ...(sr.unit?.sourceRef ? { unitRef: sr.unit.sourceRef } : {}),
        ...(sr.assetItem?.sourceRef ? { assetItemRef: sr.assetItem.sourceRef } : {}),
        category: sr.category.key,
        description: sr.description,
        photos: urls,
        reportedAt: sr.createdAt.toISOString(),
        // PII travels encrypted (blueprint "Integration contracts"); the platform key stands in for the shared
        // Collective integration key until KMS (D-230) — the consumer re-encrypts with its own tenant key
        reporter: {
          enc: Buffer.from(this.crypto.encrypt(reporter, 'integration:warranty.defect.reported')).toString(
            'base64',
          ),
        },
      },
    };
    const row = await this.integrations.outbound(tx, {
      platform: 'getbuild',
      envelope,
      tenantId: sr.tenantId,
      buildingId: sr.buildingId,
      subjectType: SERVICE_REQUEST_SUBJECT,
      subjectId: sr.id,
      causationEventId: event.id,
    });
    await tx.serviceRequest.update({
      where: { id: sr.id },
      data: { warrantyIntegrationEventId: row.id },
    });
  }

  /** `warranty.defect.closed` → the request is closed, or handed back to the building's team. */
  private async closed(tx: Tx, envelope: Record<string, unknown>, rowId: string): Promise<void> {
    const p = envelope.payload as { serviceRequestId: string; resolution: string; resolutionNote?: string };
    const sr = await tx.serviceRequest.findUnique({ where: { id: p.serviceRequestId } });
    if (!sr?.inWarranty)
      throw new Error(`service request ${p.serviceRequestId} is not referred to a warranty`);
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${sr.tenantId}, true)`;
    await tx.integrationEvent.update({
      where: { id: rowId },
      data: {
        tenantId: sr.tenantId,
        buildingId: sr.buildingId,
        subjectType: SERVICE_REQUEST_SUBJECT,
        subjectId: sr.id,
      },
    });
    const resolution = `${p.resolution}${p.resolutionNote ? `: ${p.resolutionNote}` : ''}`.slice(0, 2000);
    const now = this.clock.now();
    if (['not_a_defect', 'out_of_warranty'].includes(p.resolution)) {
      await this.requests.transition(tx, sr, 'warranty_returned', {
        inWarranty: false,
        warrantyResolution: resolution,
      });
      return;
    }
    await this.requests.transition(tx, sr, 'warranty_closed', {
      warrantyResolution: resolution,
      doneAt: now,
      closedAt: now,
    });
  }
}
