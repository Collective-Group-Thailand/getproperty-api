import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { PlatformBrand } from '@core/brand/platform-brand.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import {
  operators,
  type Recipient,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { registerRealtimeChannels } from '@core/subscribers/subscribers';
import { type Tx } from '@database/prisma.service';
import { flexMessage, visitBubble } from '@modules/ops-documents/flex';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { unitResidentRecipients } from './gate-residents';
import { plateText } from './gate-rules';

/** Visit event types streamed to the gate (`gate:<id>`) and the unit's residents (`unit:<id>`). */
export const GATE_STREAM_EVENTS = [
  'gate.visit.requested',
  'gate.visit.recorded',
  'gate.visit.answered',
  'gate.visit.timed_out',
  'gate.visit.entered',
  'gate.visit.exited',
  'gate.visit.cancelled',
  'gate.visit.photo_added',
  'gate.visit.overstayed',
  // J4.2 (D-328)
  'gate.open_requested',
] as const;

/** J4.2 (D-328): gate hardware events streamed to the gate (`gate:<id>`) only. */
export const GATE_HARDWARE_STREAM_EVENTS = [
  'gate.barrier_state',
  'gate.plate_detected',
  'gate.plate_detection.changed',
  'gate.edge_device_attached',
  'gate.edge_device_detached',
  'device.command_finished',
] as const;

/** J4.2 (D-317, D-328): incident events — every gate of the estate and the unit's LIFF. */
export const INCIDENT_STREAM_EVENTS = [
  'gate.incident.raised',
  'gate.incident.acknowledged',
  'gate.incident.resolved',
  'gate.incident.cancelled',
] as const;

const INCIDENT_KIND_TH: Record<string, string> = {
  fire: 'ไฟไหม้',
  medical: 'เจ็บป่วยฉุกเฉิน',
  intrusion: 'บุกรุก',
  other: 'เหตุฉุกเฉินอื่น',
};
const INCIDENT_KIND_EN: Record<string, string> = {
  fire: 'fire',
  medical: 'medical emergency',
  intrusion: 'intrusion',
  other: 'other emergency',
};

const KIND_TH: Record<string, string> = {
  guest: 'แขก',
  delivery: 'ส่งของ',
  contractor: 'ช่าง / ผู้รับเหมา',
  resident_vehicle: 'รถของบ้าน',
  other: 'อื่น ๆ',
};
const KIND_EN: Record<string, string> = {
  guest: 'guest',
  delivery: 'delivery',
  contractor: 'contractor',
  resident_vehicle: 'household car',
  other: 'other',
};

const policyLineTh = (action: string | null, seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (action === 'allow_and_log') return `ถ้าไม่ตอบใน ${minutes} นาที รปภ. จะให้เข้าและบันทึกไว้`;
  if (action === 'deny') return `ถ้าไม่ตอบใน ${minutes} นาที รปภ. จะไม่ให้เข้า`;
  return `ถ้าไม่ตอบใน ${minutes} นาที รปภ. จะโทรหาคุณ`;
};

/**
 * J4.1 notifications and realtime (D-315, D-327): the household is asked in LINE (Flex with approve / call me / deny,
 * urgent — a visitor is waiting, quiet hours do not hold it), told about notify-only entries, invite decisions; owner,
 * manager and committee hear about visits open too long and contractor invites waiting. Visit events reach the gate
 * stream (`gate:<id>`) and the unit's LIFF (`unit:<id>`) as ids only.
 */
@Injectable()
export class GateNotifications implements OnModuleInit {
  constructor(
    private readonly config: AppConfig,
    private readonly brand: PlatformBrand,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private link(path: string): string {
    return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}${path}`;
  }

  private async visitData(tx: Tx, visitId: string) {
    const v = await tx.visit.findUnique({
      where: { id: visitId },
      include: { unit: { select: { unitNo: true } }, gate: { select: { name: true } } },
    });
    if (!v?.unitId) return null;
    return v;
  }

  onModuleInit(): void {
    /** Owner and manager by their audiences; the committee hears it on the manager routes (no committee audience). */
    const estateOperators = async (tx: Tx, tenantId: string): Promise<Recipient[]> => [
      ...(await operators(tx, tenantId, ['owner', 'manager'], 'owner')),
      ...(await operators(tx, tenantId, ['committee'], 'manager')).map((r) => ({
        ...r,
        audience: 'manager' as const,
      })),
    ];

    registerRealtimeChannels(GATE_STREAM_EVENTS, (_tx, e) => {
      const p = e.payload as { gateId?: string; unitId?: string | null };
      return Promise.resolve([
        ...(p.gateId ? [`gate:${p.gateId}`] : []),
        ...(p.unitId ? [`unit:${p.unitId}`] : []),
      ]);
    });

    registerRealtimeChannels(GATE_HARDWARE_STREAM_EVENTS, (_tx, e) => {
      const p = e.payload as { gateId?: string };
      return Promise.resolve(p.gateId ? [`gate:${p.gateId}`] : []);
    });
    registerRealtimeChannels(INCIDENT_STREAM_EVENTS, (_tx, e) => {
      const p = e.payload as { gateIds?: string[]; unitId?: string | null };
      return Promise.resolve([
        ...(p.gateIds ?? []).map((id) => `gate:${id}`),
        ...(p.unitId ? [`unit:${p.unitId}`] : []),
      ]);
    });

    /** SOS: urgent to owner, manager, staff and the committee (manager routes) — quiet hours never hold it. */
    registerNotifiable('gate.incident.raised', async (tx, e) => {
      if (!e.tenantId) return null;
      const i = await tx.incident.findUnique({
        where: { id: e.payload.incidentId as string },
        include: {
          unit: { select: { unitNo: true, building: { select: { name: true } } } },
          property: { select: { name: true } },
          gate: { select: { name: true } },
        },
      });
      if (!i) return null;
      return {
        recipients: [
          ...(await estateOperators(tx, e.tenantId)),
          ...(await operators(tx, e.tenantId, ['staff'], 'staff')),
        ],
        urgent: true,
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          incident: {
            kindTh: INCIDENT_KIND_TH[i.kind] ?? i.kind,
            kindEn: INCIDENT_KIND_EN[i.kind] ?? i.kind,
            property: i.property.name,
            where: i.unit ? `${i.unit.building.name} ${i.unit.unitNo}` : (i.gate?.name ?? i.property.name),
            note: i.note ?? '-',
          },
        },
      };
    });

    /** The resident who raised the SOS hears that a guard / the office has it (urgent). */
    registerNotifiable('gate.incident.acknowledged', async (tx, e) => {
      if (!e.tenantId) return null;
      const i = await tx.incident.findUnique({
        where: { id: e.payload.incidentId as string },
        include: { unit: { select: { unitNo: true } } },
      });
      if (!i?.raisedByUserId || i.source !== 'resident_sos') return null;
      const user = await tx.userAccount.findUnique({ where: { id: i.raisedByUserId } });
      if (!user) return null;
      return {
        recipients: [
          {
            audience: 'resident' as const,
            type: 'user' as const,
            id: user.id,
            tenantId: e.tenantId,
            language: user.language,
            line: user.lineUserId,
            phone: null,
            email: null,
          },
        ],
        urgent: true,
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          incident: {
            kindTh: INCIDENT_KIND_TH[i.kind] ?? i.kind,
            kindEn: INCIDENT_KIND_EN[i.kind] ?? i.kind,
            unitNo: i.unit?.unitNo ?? '-',
            byTh: e.payload.by === 'guard' ? 'รปภ.' : 'สำนักงานนิติบุคคล',
            byEn: e.payload.by === 'guard' ? 'the guard' : 'the office',
          },
          link: this.link(`/sos/${i.id}`),
        },
      };
    });

    registerNotifiable('gate.visit.requested', async (tx, e) => {
      const v = await this.visitData(tx, e.payload.visitId as string);
      if (!v || v.state !== 'requested' || !e.tenantId) return null;
      const recipients = await unitResidentRecipients(
        tx,
        v.unitId!,
        v.tenantId,
        bangkokDate(this.clock.now()),
      );
      if (!recipients.length) return null;
      const seconds = Math.max(0, Math.round(((v.respondBy?.getTime() ?? 0) - v.createdAt.getTime()) / 1000));
      const plate = plateText({
        category: v.plateCategory,
        number: v.plateNumber,
        province: v.plateProvince,
      });
      const base = `/visits/${v.id}`;
      const flex = flexMessage(
        `มีผู้มาติดต่อบ้าน ${v.unit?.unitNo ?? ''} ที่${v.gate.name}${plate ? ` ทะเบียน ${plate}` : ''}`,
        [
          visitBubble(
            {
              gateName: v.gate.name,
              unitNo: v.unit?.unitNo ?? '-',
              kindTh: KIND_TH[v.kind] ?? v.kind,
              plate,
              visitorName: v.visitorName,
              policyLine: policyLineTh(v.timeoutAction, seconds),
              approveLink: this.link(`${base}?answer=approve`),
              denyLink: this.link(`${base}?answer=deny`),
              callLink: this.link(`${base}?answer=call_me`),
            },
            await this.brand.flex(),
          ),
        ],
      );
      return {
        recipients,
        urgent: true,
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          visit: {
            gate: v.gate.name,
            unitNo: v.unit?.unitNo ?? '',
            kindTh: KIND_TH[v.kind] ?? v.kind,
            kindEn: KIND_EN[v.kind] ?? v.kind,
            plate: plate ?? '-',
            visitorName: v.visitorName ?? '-',
            minutes: Math.max(1, Math.round(seconds / 60)),
          },
          link: this.link(base),
          flex: { altText: flex.altText, contents: flex.contents },
        },
      };
    });

    registerNotifiable('gate.visit.entered', async (tx, e) => {
      if (e.payload.notifyResidents !== true || !e.tenantId) return null;
      const v = await this.visitData(tx, e.payload.visitId as string);
      if (!v) return null;
      const recipients = await unitResidentRecipients(
        tx,
        v.unitId!,
        v.tenantId,
        bangkokDate(this.clock.now()),
      );
      if (!recipients.length) return null;
      const plate = plateText({
        category: v.plateCategory,
        number: v.plateNumber,
        province: v.plateProvince,
      });
      return {
        recipients,
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          visit: {
            gate: v.gate.name,
            unitNo: v.unit?.unitNo ?? '',
            kindTh: KIND_TH[v.kind] ?? v.kind,
            kindEn: KIND_EN[v.kind] ?? v.kind,
            plate: plate ?? '-',
            visitorName: v.visitorName ?? '-',
          },
          link: this.link(`/visits/${v.id}`),
        },
      };
    });

    const inviteDecision = async (
      tx: Tx,
      e: { tenantId: string | null; payload: Record<string, unknown> },
    ) => {
      const inv = await tx.visitInvite.findUnique({
        where: { id: e.payload.inviteId as string },
        include: { unit: { select: { unitNo: true } } },
      });
      if (!inv || !e.tenantId) return null;
      const user = await tx.userAccount.findUnique({ where: { id: inv.createdByUserId } });
      if (!user) return null;
      const recipient: Recipient = {
        audience: 'resident',
        type: 'user',
        id: user.id,
        tenantId: e.tenantId,
        language: user.language,
        line: user.lineUserId,
        phone: null,
        email: null,
      };
      return {
        recipients: [recipient],
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          invite: {
            unitNo: inv.unit.unitNo,
            visitorName: inv.visitorName ?? '-',
            reason: inv.rejectReason ?? '-',
          },
          link: this.link(`/units/${inv.unitId}/visit-invites`),
        },
      };
    };
    registerNotifiable('gate.invite.approved', inviteDecision);
    registerNotifiable('gate.invite.rejected', inviteDecision);

    registerNotifiable('gate.visit.overstayed', async (tx, e) => {
      if (!e.tenantId) return null;
      const v = await tx.visit.findUnique({
        where: { id: e.payload.visitId as string },
        include: { unit: { select: { unitNo: true } }, gate: { select: { name: true } } },
      });
      if (!v) return null;
      return {
        recipients: await estateOperators(tx, e.tenantId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          visit: {
            gate: v.gate.name,
            unitNo: v.unit?.unitNo ?? '-',
            hours: e.payload.hours ?? '',
            kindTh: KIND_TH[v.kind] ?? v.kind,
            kindEn: KIND_EN[v.kind] ?? v.kind,
          },
        },
      };
    });

    registerNotifiable('gate.invite.approval_required', async (tx, e) => {
      if (!e.tenantId) return null;
      const inv = await tx.visitInvite.findUnique({
        where: { id: e.payload.inviteId as string },
        include: { unit: { select: { unitNo: true } } },
      });
      if (!inv) return null;
      return {
        recipients: await estateOperators(tx, e.tenantId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          invite: {
            unitNo: inv.unit.unitNo,
            from: bangkokDate(inv.validFrom),
            to: bangkokDate(inv.validTo),
          },
        },
      };
    });
  }
}
