import { type TenantContext } from '@common/context/tenant-context';
import { formatMoney } from '@common/money/money';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type UnitStatus, type UnitType, type Utility } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { visibleBuilding } from './building-access';

export interface BoardLessee {
  partyId: string;
  displayName: string;
}

export interface BoardUnit {
  id: string;
  unitNo: string;
  type: UnitType;
  status: UnitStatus;
  statusReason: string | null;
  profileName: string | null;
  baseRent: string | null;
  lessee: BoardLessee | null;
  leaseId: string | null;
  leaseStatus: string | null;
  leaseEndDate: string | null;
  /** Outstanding balance of the unit (B4.5); null until receivables exist. */
  balance: string | null;
  meters: { utility: Utility; code: string; health: string | null }[];
  /** Worst meter health of the unit (B3.4); null until meter health exists. */
  meterHealth: string | null;
}

export interface Board {
  building: { id: string; code: string; name: string };
  generatedAt: Date;
  summary: Record<UnitStatus, number> & { total: number; occupancyPct: string };
  floors: { id: string | null; level: number | null; name: string; units: BoardUnit[] }[];
}

/** Leases whose lessee is shown on the board (B2.3 fills it; the hook keeps 2.1 independent of leases). */
export interface BoardLease {
  leaseId: string;
  status: string;
  endDate: Date;
  lessee: BoardLessee;
}

export interface BoardLeaseSource {
  currentLeases(tx: Tx, unitIds: string[]): Promise<Map<string, BoardLease>>;
}

/**
 * Unit board of a building (`GET /v1/owner/buildings/{id}/board`, B2.1): floors with unit cards — status, lessee,
 * lease end, balance and meter health (balance and health stay null until B4/B3). One round trip for the web app's
 * main screen.
 */
@Injectable()
export class BoardService extends TenantScopedRepository {
  private leaseSource: BoardLeaseSource | null = null;

  constructor(
    private readonly db: TenantTx,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** Called by the leases module (B2.3) at start-up. */
  useLeaseSource(source: BoardLeaseSource): void {
    this.leaseSource = source;
  }

  board(ctx: TenantContext, buildingId: string): Promise<Board> {
    return this.db.tenant(ctx, async (tx) => {
      const building = await visibleBuilding(tx, ctx, buildingId);
      const [floors, units, meters] = await Promise.all([
        tx.floor.findMany({
          where: { buildingId, deletedAt: null },
          orderBy: [{ sortOrder: 'desc' }, { level: 'desc' }],
        }),
        tx.unit.findMany({
          where: { buildingId, deletedAt: null },
          include: { unitDetailUnit: { include: { profile: { select: { name: true } } } } },
          orderBy: { unitNo: 'asc' },
        }),
        tx.meterAssignment.findMany({
          where: { buildingId, validTo: null, purpose: 'unit' },
          select: { unitId: true, utility: true, code: true },
          orderBy: { utility: 'asc' },
        }),
      ]);
      const leases = this.leaseSource
        ? await this.leaseSource.currentLeases(
            tx,
            units.map((u) => u.id),
          )
        : new Map<string, BoardLease>();
      const metersByUnit = new Map<string, BoardUnit['meters']>();
      for (const m of meters) {
        if (!m.unitId) continue;
        const list = metersByUnit.get(m.unitId) ?? [];
        list.push({ utility: m.utility, code: m.code, health: null });
        metersByUnit.set(m.unitId, list);
      }
      const card = (u: (typeof units)[number]): BoardUnit => {
        const lease = leases.get(u.id);
        return {
          id: u.id,
          unitNo: u.unitNo,
          type: u.type,
          status: u.status,
          statusReason: u.unitDetailUnit?.statusReason ?? null,
          profileName: u.unitDetailUnit?.profile?.name ?? null,
          baseRent: u.baseRent ? formatMoney(u.baseRent.toString()) : null,
          lessee: lease?.lessee ?? null,
          leaseId: lease?.leaseId ?? null,
          leaseStatus: lease?.status ?? null,
          leaseEndDate: lease ? lease.endDate.toISOString().slice(0, 10) : null,
          balance: null,
          meters: metersByUnit.get(u.id) ?? [],
          meterHealth: null,
        };
      };
      const summary = {
        total: units.length,
        vacant: 0,
        reserved: 0,
        occupied: 0,
        maintenance: 0,
        inactive: 0,
      };
      for (const u of units) summary[u.status] += 1;
      const countable = summary.total - summary.inactive;
      const occupancyPct = countable ? ((summary.occupied * 100) / countable).toFixed(1) : '0.0';
      const result: Board['floors'] = floors.map((f) => ({
        id: f.id,
        level: f.level,
        name: f.name,
        units: units.filter((u) => u.floorId === f.id).map(card),
      }));
      const loose = units.filter((u) => !u.floorId);
      if (loose.length) result.push({ id: null, level: null, name: 'ไม่ระบุชั้น', units: loose.map(card) });
      return {
        building: { id: building.id, code: building.code, name: building.name },
        generatedAt: this.clock.now(),
        summary: { ...summary, occupancyPct },
        floors: result,
      };
    });
  }
}
