import { systemTenantContext } from '@common/context/tenant-context';
import { type Tx } from '@database/prisma.service';
import { type ExportJob } from '@generated/prisma/client';
import { type ExportFile, ExportsService } from '@modules/ops-documents/exports.service';
import { csvOf } from '@modules/ops-receivables/exports/sheets';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { type LossRow, UtilityLossService } from './utility-loss.service';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUSPECT_TH: Record<string, string> = {
  zero_consumption_occupied: 'ห้องมีผู้เช่าแต่ใช้ 0 หน่วย',
  usage_while_vacant: 'ห้องว่างแต่มีการใช้',
  estimated_reading: 'ค่ามิเตอร์ประมาณการ',
  night_water_flow: 'น้ำไหลกลางดึก',
  stale_meter: 'มิเตอร์ไม่ส่งข้อมูล',
  consumption_anomaly: 'การใช้ผิดปกติ',
};

export const LOSS_CSV_HEADERS = [
  'ส่วน',
  'อาคาร',
  'สาธารณูปโภค',
  'งวดเริ่ม',
  'งวดสิ้นสุด',
  'หน่วยตามใบแจ้งหนี้การไฟฟ้า/ประปา',
  'หน่วยที่เรียกเก็บจากห้อง',
  'หน่วยพื้นที่ส่วนกลาง',
  'หน่วยสูญหาย',
  'สูญหาย (%)',
  'มูลค่าสูญหาย (บาท)',
  'ห้อง',
  'มิเตอร์',
  'ประเภทข้อสงสัย',
  'คะแนน',
  'รายละเอียด',
] as const;

/** The loss report as rows: one summary row, then one row per suspect with its unit and meter codes (D-032). */
export function lossReportCsv(
  report: LossRow,
  buildingName: string,
  codes: { units: ReadonlyMap<string, string>; meters: ReadonlyMap<string, string> },
): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const base = [buildingName, report.utility, day(report.periodStart), day(report.periodEnd)];
  const rows: (string | number | null)[][] = [
    [
      'สรุป',
      ...base,
      report.invoiceUnits.toFixed(3),
      report.unitBilledUnits.toFixed(3),
      report.commonAreaUnits.toFixed(3),
      report.lossUnits.toFixed(3),
      report.lossPct?.toFixed(2) ?? null,
      report.lossThb.toFixed(2),
      null,
      null,
      null,
      null,
      null,
    ],
  ];
  for (const s of report.suspects)
    rows.push([
      'ข้อสงสัย',
      ...base,
      null,
      null,
      null,
      null,
      null,
      null,
      s.unitId ? (codes.units.get(s.unitId) ?? null) : null,
      s.assetItemId ? (codes.meters.get(s.assetItemId) ?? null) : null,
      SUSPECT_TH[s.kind] ?? s.kind,
      s.score.toFixed(2),
      JSON.stringify(s.detail ?? {}),
    ]);
  return csvOf(LOSS_CSV_HEADERS, rows);
}

/**
 * `loss_report_csv` (web F2 2.5, D-208): the utility loss report of a building × utility × billing period as a UTF-8
 * CSV with BOM — the summary row and the ranked suspects with their unit and meter codes. Computed when missing
 * (same as `GET /v1/owner/buildings/{id}/loss`).
 */
@Injectable()
export class LossReportExportBuilder implements OnModuleInit {
  readonly kind = 'loss_report_csv' as const;

  constructor(
    private readonly exports: ExportsService,
    private readonly loss: UtilityLossService,
  ) {}

  onModuleInit(): void {
    this.exports.register(this);
  }

  validate(params: Record<string, unknown>): { path: string; message: string }[] {
    const problems: { path: string; message: string }[] = [];
    if (typeof params.buildingId !== 'string' || !UUID.test(params.buildingId))
      problems.push({ path: 'buildingId', message: 'the building of the report' });
    if (params.utility !== 'electric' && params.utility !== 'water')
      problems.push({ path: 'utility', message: 'electric or water' });
    if (params.period !== undefined && (typeof params.period !== 'string' || !MONTH.test(params.period)))
      problems.push({ path: 'period', message: 'a billing period YYYY-MM (default: the last closed one)' });
    return problems;
  }

  async build(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const p = job.params as { buildingId: string; utility: 'electric' | 'water'; period?: string };
    const { report } = await this.loss.report(
      systemTenantContext(job.tenantId),
      p.buildingId,
      p.utility,
      p.period,
    );
    const building = await tx.building.findUniqueOrThrow({
      where: { id: p.buildingId },
      select: { name: true },
    });
    const unitIds = report.suspects.map((s) => s.unitId).filter((x): x is string => Boolean(x));
    const meterIds = report.suspects.map((s) => s.assetItemId).filter((x): x is string => Boolean(x));
    const [units, meters] = await Promise.all([
      unitIds.length
        ? tx.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, unitNo: true } })
        : [],
      meterIds.length
        ? tx.meterAssignment.findMany({
            where: { assetItemId: { in: meterIds } },
            select: { assetItemId: true, code: true },
            orderBy: { validFrom: 'asc' },
          })
        : [],
    ]);
    const body = lossReportCsv(report, building.name, {
      units: new Map(units.map((u) => [u.id, u.unitNo])),
      meters: new Map(meters.map((m) => [m.assetItemId, m.code])),
    });
    const period = report.periodStart.toISOString().slice(0, 7);
    return {
      fileName: `loss-${p.utility}-${period}.csv`,
      mimeType: 'text/csv',
      body: Buffer.from(body, 'utf8'),
      rowCount: 1 + report.suspects.length,
    };
  }
}
