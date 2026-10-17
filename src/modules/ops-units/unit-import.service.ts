import { createHash } from 'node:crypto';

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { mapConflicts } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Building, type UnitType } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';

import { operatedBuilding, visibleBuilding } from './building-access';
import { UNIT_NO_PATTERN } from './unit-rules';
import { UnitsService } from './units.service';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ROWS = 2_000;
const MAX_BYTES = 5_000_000;
const UNIT_TYPES: readonly UnitType[] = ['room', 'condo_unit', 'house', 'shop', 'parking'];

/** Columns of the units sheet, in order (the template, the export and the import share them). */
export const UNIT_COLUMNS = [
  { key: 'unit_no', th: 'เลขห้อง (บังคับ)', width: 14 },
  { key: 'floor_level', th: 'ชั้น (ตัวเลข)', width: 10 },
  { key: 'type', th: 'ประเภท: room | condo_unit | house | shop | parking', width: 16 },
  { key: 'area_sqm', th: 'พื้นที่ (ตร.ม.)', width: 12 },
  { key: 'base_rent', th: 'ค่าเช่าต่อเดือน (บาท)', width: 16 },
  { key: 'unit_profile', th: 'ประเภทห้อง (ชื่อตามที่ตั้งไว้)', width: 22 },
  { key: 'notes', th: 'หมายเหตุ', width: 30 },
] as const;
type ColumnKey = (typeof UNIT_COLUMNS)[number]['key'];

export interface ImportRowError {
  column: ColumnKey | 'row';
  code: string;
  message: string;
}

export interface ImportRow {
  row: number;
  unitNo: string;
  floorLevel: number | null;
  type: UnitType;
  areaSqm: string | null;
  baseRent: string | null;
  unitProfile: string | null;
  notes: string | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  createsFloor: boolean;
  errors: ImportRowError[];
}

export interface ImportPreview {
  fileId: string;
  buildingId: string;
  rows: ImportRow[];
  summary: { create: number; update: number; unchanged: number; error: number; floorsToCreate: number[] };
  previewToken: string;
}

const text = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v)
      return v.richText
        .map((r) => r.text)
        .join('')
        .trim();
    if ('result' in v) return text(v.result);
    if ('text' in v) return String(v.text).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v).trim();
};

const DECIMAL = /^\d{1,12}(\.\d{1,2})?$/;
const normDecimal = (raw: string) => {
  const s = raw.replace(/,/g, '');
  return DECIMAL.test(s) ? Number(s).toFixed(2) : null;
};

/**
 * Excel import/export of units (B2.1, the Phase 1 "import from Excel" acceptance): download the template, upload the
 * file through `files/presign` (kind `other`, xlsx), **preview** (validation per row and column, the action each row
 * will take: create, update or unchanged, floors that would be created) and **commit** with the preview token — the
 * file is parsed again and must give the same plan, so what was previewed is exactly what is written, in one
 * transaction. The export uses the same columns so a file round-trips.
 */
@Injectable()
export class UnitImportService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly documents: DocumentsService,
    private readonly units: UnitsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {
    super();
  }

  /** The template workbook: the units sheet with the header row and an instructions sheet. */
  async template(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'getproperty';
    wb.created = new Date(0);
    this.unitsSheet(wb);
    const help = wb.addWorksheet('คำอธิบาย');
    help.columns = [
      { header: 'คอลัมน์', key: 'k', width: 16 },
      { header: 'ความหมาย', key: 'v', width: 70 },
    ];
    for (const c of UNIT_COLUMNS) help.addRow({ k: c.key, v: c.th });
    help.addRow({});
    help.addRow({ k: 'หมายเหตุ', v: 'แถวที่มีเลขห้องซ้ำกับห้องที่มีอยู่แล้วจะเป็นการแก้ไขข้อมูลห้องนั้น' });
    help.addRow({ k: '', v: 'ชั้นที่ยังไม่มีในอาคารจะถูกสร้างให้อัตโนมัติเมื่อเลือก "สร้างชั้นที่ขาด"' });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private unitsSheet(wb: ExcelJS.Workbook) {
    const ws = wb.addWorksheet('units');
    ws.columns = UNIT_COLUMNS.map((c) => ({ header: c.key, key: c.key, width: c.width }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).getCell(1).note = 'แถวแรกต้องเป็นชื่อคอลัมน์ตามแม่แบบ';
    return ws;
  }

  /** Units of a building as a workbook with the import columns. */
  async export(ctx: TenantContext, buildingId: string): Promise<{ building: Building; body: Buffer }> {
    const { building, units } = await this.db.tenant(ctx, async (tx) => {
      const b = await visibleBuilding(tx, ctx, buildingId);
      const rows = await tx.unit.findMany({
        where: { buildingId, deletedAt: null },
        include: { floor: true, unitDetailUnit: { include: { profile: true } } },
        orderBy: { unitNo: 'asc' },
      });
      return { building: b, units: rows };
    });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'getproperty';
    wb.created = new Date(0);
    const ws = this.unitsSheet(wb);
    for (const u of units)
      ws.addRow({
        unit_no: u.unitNo,
        floor_level: u.floor?.level ?? null,
        type: u.type,
        area_sqm: u.areaSqm ? u.areaSqm.toFixed(2) : null,
        base_rent: u.baseRent ? u.baseRent.toFixed(2) : null,
        unit_profile: u.unitDetailUnit?.profile?.name ?? null,
        notes: u.unitDetailUnit?.notes ?? null,
      });
    return { building, body: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  private async parse(body: Buffer): Promise<Omit<ImportRow, 'action' | 'createsFloor'>[]> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(body as unknown as ArrayBuffer);
    } catch {
      throw new DomainException('import.file_invalid', { params: { reason: 'not an xlsx workbook' } });
    }
    const ws = wb.getWorksheet('units') ?? wb.worksheets[0];
    if (!ws) throw new DomainException('import.file_invalid', { params: { reason: 'no worksheet' } });
    const header = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((v) => text(v).toLowerCase());
    const index = new Map<ColumnKey, number>();
    for (const c of UNIT_COLUMNS) {
      const at = header.indexOf(c.key);
      if (at >= 0) index.set(c.key, at + 1);
    }
    if (!index.has('unit_no'))
      throw new DomainException('import.file_invalid', {
        params: { reason: 'the header row has no unit_no column' },
      });
    const rows: Omit<ImportRow, 'action' | 'createsFloor'>[] = [];
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const cell = (k: ColumnKey) => (index.has(k) ? text(row.getCell(index.get(k)!).value) : '');
      const values = UNIT_COLUMNS.map((c) => cell(c.key));
      if (values.every((v) => v === '')) continue;
      if (rows.length >= MAX_ROWS)
        throw new DomainException('import.file_invalid', {
          params: { reason: `more than ${MAX_ROWS} rows` },
        });
      const errors: ImportRowError[] = [];
      const unitNo = cell('unit_no');
      if (!unitNo) errors.push({ column: 'unit_no', code: 'required', message: 'เลขห้องว่าง' });
      else if (!UNIT_NO_PATTERN.test(unitNo))
        errors.push({
          column: 'unit_no',
          code: 'format',
          message: 'เลขห้องใช้ได้เฉพาะตัวอักษร ตัวเลข และ - _ . /',
        });
      const floorRaw = cell('floor_level');
      let floorLevel: number | null = null;
      if (floorRaw) {
        if (/^-?\d{1,3}$/.test(floorRaw) && Number(floorRaw) >= -5 && Number(floorRaw) <= 200)
          floorLevel = Number(floorRaw);
        else
          errors.push({ column: 'floor_level', code: 'format', message: 'ชั้นต้องเป็นจำนวนเต็ม -5 ถึง 200' });
      }
      const typeRaw = cell('type') || 'room';
      if (!(UNIT_TYPES as readonly string[]).includes(typeRaw))
        errors.push({ column: 'type', code: 'isIn', message: `ประเภทต้องเป็น ${UNIT_TYPES.join(' | ')}` });
      const areaRaw = cell('area_sqm');
      const areaSqm = areaRaw ? normDecimal(areaRaw) : null;
      if (areaRaw && (!areaSqm || Number(areaSqm) <= 0 || Number(areaSqm) > 9_999_999))
        errors.push({
          column: 'area_sqm',
          code: 'format',
          message: 'พื้นที่ต้องเป็นตัวเลขมากกว่า 0 (ทศนิยม 2 ตำแหน่ง)',
        });
      const rentRaw = cell('base_rent');
      const baseRent = rentRaw ? normDecimal(rentRaw) : null;
      if (rentRaw && !baseRent)
        errors.push({
          column: 'base_rent',
          code: 'money',
          message: 'ค่าเช่าต้องเป็นจำนวนเงิน เช่น 4500 หรือ 4500.00',
        });
      rows.push({
        row: r,
        unitNo,
        floorLevel,
        type: (UNIT_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as UnitType) : 'room',
        areaSqm,
        baseRent,
        unitProfile: cell('unit_profile') || null,
        notes: cell('notes') || null,
        errors,
      });
    }
    if (!rows.length)
      throw new DomainException('import.file_invalid', { params: { reason: 'no data rows' } });
    return rows;
  }

  /** Validates the rows against the building (floors, profiles, existing units) and plans each row. */
  private async plan(
    tx: Tx,
    building: Building,
    parsed: Omit<ImportRow, 'action' | 'createsFloor'>[],
    createFloors: boolean,
  ): Promise<ImportRow[]> {
    const [floors, profiles, existing] = await Promise.all([
      tx.floor.findMany({ where: { buildingId: building.id, deletedAt: null } }),
      tx.unitProfile.findMany({ where: { buildingId: building.id, deletedAt: null } }),
      tx.unit.findMany({
        where: { buildingId: building.id, deletedAt: null },
        include: { floor: true, unitDetailUnit: { include: { profile: true } } },
      }),
    ]);
    const floorLevels = new Set(floors.map((f) => f.level));
    const profileNames = new Set(profiles.map((p) => p.name));
    const byNo = new Map(existing.map((u) => [u.unitNo.toLowerCase(), u]));
    const seen = new Map<string, number>();
    return parsed.map((p) => {
      const errors = [...p.errors];
      const key = p.unitNo.toLowerCase();
      if (p.unitNo && seen.has(key))
        errors.push({ column: 'unit_no', code: 'duplicate', message: `เลขห้องซ้ำกับแถว ${seen.get(key)}` });
      else seen.set(key, p.row);
      const missingFloor = p.floorLevel !== null && !floorLevels.has(p.floorLevel);
      if (missingFloor && !createFloors)
        errors.push({
          column: 'floor_level',
          code: 'notFound',
          message: `ไม่มีชั้น ${p.floorLevel} ในอาคารนี้`,
        });
      if (p.unitProfile && !profileNames.has(p.unitProfile))
        errors.push({
          column: 'unit_profile',
          code: 'notFound',
          message: `ไม่มีประเภทห้อง "${p.unitProfile}"`,
        });
      const current = byNo.get(key);
      let action: ImportRow['action'] = errors.length ? 'error' : current ? 'unchanged' : 'create';
      if (action === 'unchanged' && current) {
        const same =
          (current.floor?.level ?? null) === p.floorLevel &&
          current.type === p.type &&
          (current.areaSqm ? current.areaSqm.toFixed(2) : null) === p.areaSqm &&
          (current.baseRent ? current.baseRent.toFixed(2) : null) === p.baseRent &&
          (current.unitDetailUnit?.profile?.name ?? null) === p.unitProfile &&
          (current.unitDetailUnit?.notes ?? null) === p.notes;
        if (!same) action = 'update';
      }
      return { ...p, errors, action, createsFloor: missingFloor && createFloors && !errors.length };
    });
  }

  private summarise(fileId: string, buildingId: string, sha256: string, rows: ImportRow[]): ImportPreview {
    const count = (a: ImportRow['action']) => rows.filter((r) => r.action === a).length;
    const floorsToCreate = [
      ...new Set(rows.filter((r) => r.createsFloor && r.floorLevel !== null).map((r) => r.floorLevel!)),
    ].sort((a, b) => a - b);
    const previewToken = createHash('sha256')
      .update(JSON.stringify({ fileId, buildingId, sha256, rows: rows.map(({ errors: _e, ...r }) => r) }))
      .digest('base64url');
    return {
      fileId,
      buildingId,
      rows,
      summary: {
        create: count('create'),
        update: count('update'),
        unchanged: count('unchanged'),
        error: count('error'),
        floorsToCreate,
      },
      previewToken,
    };
  }

  private async load(ctx: TenantContext, fileId: string) {
    const { document, body } = await this.documents.readBytes(ctx, fileId, {
      kinds: ['other'],
      mimeTypes: [XLSX_MIME],
      maxBytes: MAX_BYTES,
    });
    return { sha256: Buffer.from(document.sha256).toString('hex'), parsed: await this.parse(body) };
  }

  async preview(ctx: TenantContext, buildingId: string, input: { fileId: string; createFloors?: boolean }) {
    const { sha256, parsed } = await this.load(ctx, input.fileId);
    const rows = await this.db.tenant(ctx, async (tx) => {
      const building = await operatedBuilding(tx, ctx, buildingId);
      return this.plan(tx, building, parsed, input.createFloors ?? false);
    });
    return this.summarise(input.fileId, buildingId, sha256, rows);
  }

  /** Writes the previewed plan in one transaction (409 `import.preview_stale` if the plan changed since). */
  async commit(
    ctx: TenantContext,
    buildingId: string,
    input: { fileId: string; previewToken: string; createFloors?: boolean },
  ) {
    const { sha256, parsed } = await this.load(ctx, input.fileId);
    return mapConflicts(
      () =>
        this.db.tenant(
          ctx,
          async (tx) => {
            const building = await operatedBuilding(tx, ctx, buildingId);
            const rows = await this.plan(tx, building, parsed, input.createFloors ?? false);
            const preview = this.summarise(input.fileId, buildingId, sha256, rows);
            if (preview.previewToken !== input.previewToken)
              throw new DomainException('import.preview_stale');
            if (preview.summary.error > 0)
              throw new DomainException('import.invalid_rows', {
                params: { count: preview.summary.error },
                errors: rows
                  .filter((r) => r.errors.length)
                  .slice(0, 50)
                  .flatMap((r) =>
                    r.errors.map((e) => ({
                      path: `rows[${r.row}].${e.column}`,
                      code: e.code,
                      message: e.message,
                    })),
                  ),
              });
            const floors = new Map(
              (await tx.floor.findMany({ where: { buildingId, deletedAt: null } })).map((f) => [
                f.level,
                f.id,
              ]),
            );
            for (const level of preview.summary.floorsToCreate) {
              const f = await tx.floor.create({
                data: {
                  tenantId: building.tenantId,
                  buildingId,
                  level,
                  name: `ชั้น ${level}`,
                  sortOrder: level,
                  createdBy: userIdOf(RequestContext.actor()),
                },
              });
              floors.set(level, f.id);
            }
            const profiles = new Map(
              (await tx.unitProfile.findMany({ where: { buildingId, deletedAt: null } })).map((p) => [
                p.name,
                p.id,
              ]),
            );
            const existing = new Map(
              (await tx.unit.findMany({ where: { buildingId, deletedAt: null } })).map((u) => [
                u.unitNo.toLowerCase(),
                u,
              ]),
            );
            for (const r of rows) {
              const data = {
                floorId: r.floorLevel === null ? null : (floors.get(r.floorLevel) ?? null),
                type: r.type,
                areaSqm: r.areaSqm,
                baseRent: r.baseRent,
                unitProfileId: r.unitProfile ? (profiles.get(r.unitProfile) ?? null) : null,
                notes: r.notes,
              };
              if (r.action === 'create')
                await this.units.insertUnit(tx, ctx, building, { unitNo: r.unitNo, ...data }, 'import');
              if (r.action === 'update') {
                const u = existing.get(r.unitNo.toLowerCase())!;
                await tx.unit.update({
                  where: { id: u.id },
                  data: {
                    floorId: data.floorId,
                    type: data.type,
                    areaSqm: data.areaSqm,
                    baseRent: data.baseRent,
                    updatedBy: userIdOf(RequestContext.actor()),
                    version: { increment: 1 },
                  },
                });
                await tx.unitDetail.update({
                  where: { unitId: u.id },
                  data: { unitProfileId: data.unitProfileId, notes: data.notes, version: { increment: 1 } },
                });
                await this.events.record(tx, {
                  type: 'unit.changed',
                  aggregateType: 'unit',
                  aggregateId: u.id,
                  tenantId: u.tenantId,
                  buildingId,
                  payload: { unitId: u.id, change: 'updated', source: 'import' },
                });
              }
            }
            await this.audit.record(tx, {
              action: 'unit.imported',
              tenantId: building.tenantId,
              buildingId,
              subjectType: 'core.building',
              subjectId: buildingId,
              metadata: { fileId: input.fileId, ...preview.summary },
            });
            return preview;
          },
          { timeout: 120_000 },
        ),
      () => new DomainException('import.preview_stale'),
    );
  }
}
