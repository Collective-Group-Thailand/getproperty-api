# Prompt pack v2 — getproperty-api (backend)

> v2 (2026-10-17): schema lock for the platform blueprint (D-150–D-161) — tenant / party / unit / invoice vocabulary, schemas `core` · `platform` · `ops` · `smart` · `bridge`, `collective-asset-core` package, `getproperty-liff` repo. Deliverable order unchanged.

**getproperty — บิลทำเอง เก็บเงินเอง ถูกกฎหมาย** · Collective Group (Thailand)

## ลำดับการรัน และข้อความ kickoff (วางใน Plan Mode ทีละ session แล้ว `/clear` ก่อน session ถัดไป)
คำนำหน้ามาตรฐาน (ใช้ทุก session): `Read CLAUDE.md, docs/prompts/00-master-plan.md, docs/decisions.md and docs/contract/api-conventions.md.`
ถ้า clone `getpack-api` ไว้ข้าง ๆ (`../getpack-api`) ให้เติม: `Use ../getpack-api as a conventions reference only (D-003).`

| Step | Kickoff (ต่อท้ายคำนำหน้ามาตรฐาน) | Release |
|---|---|---|
| B1.1 | `Then read docs/contract/device-protocol.md and docs/prompts/B1-foundation.md. Do Deliverable 1.1 only. Plan first.` | R1 |
| B1.2 (ก) | ✅ schema design v1 (review) → v2 schema lock (D-150–D-161) | R1 |
| B1.2 (ข-1) | `Then read docs/schema-design.md, docs/adr/0010-collective-asset-core-separate-package.md and docs/prompts/B1-foundation.md. Do Deliverable 1.2 step 2a only (collective-asset-core v0.1.0, in that repository). Plan first.` | R1 |
| B1.2 (ข-2) | `Then read docs/schema-design.md and docs/prompts/B1-foundation.md. Do Deliverable 1.2 steps 2b–3 only. Plan first.` | R1 |
| B1.3 | `Then read docs/prompts/B1-foundation.md. Do Deliverable 1.3 only. Plan first.` | R1 |
| B2.1–2.4 | `Then read docs/schema-design.md and docs/prompts/B2-property-lease.md. Do Deliverable 2.N only. Plan first.` | R1 |
| B3.1–3.4 | `Then read docs/contract/device-protocol.md, docs/schema-design.md and docs/prompts/B3-metering-iot.md. Do Deliverable 3.N only. Plan first.` | R1 |
| B4.1–4.5 | `Then read docs/schema-design.md and docs/prompts/B4-billing-payments.md. Do Deliverable 4.N only. Plan first.` | R1 |
| B6.1, 6.4, 6.5 | `Then read docs/prompts/B6-platform-launch.md. Do Deliverable 6.N only. Plan first.` | R1 |
| B5.1–5.4 | `Then read docs/schema-design.md and docs/prompts/B5-operations.md. Do Deliverable 5.N only. Plan first.` | R2 |
| B6.2, 6.3 | `Then read docs/prompts/B6-platform-launch.md. Do Deliverable 6.N only. Plan first.` | R2 |

ขนานได้: B3 และ B4.1 หลัง B2.1 · B4.2 ต้องรอ B3.3 · B6.1 หลัง B2.1 · B1.2 (ข-2) ต้องรอ `collective-asset-core` v0.1.0 · `getproperty-edge` E1 เริ่มได้ทันทีที่ B1.1 publish `contract/device-protocol.json` · `getproperty-liff` เริ่มได้เมื่อ B1.3 publish `/v1/resident/*`

## ก่อนเริ่ม B1.2 — ข้อมูลที่ต้องมีจากเจ้าของ pilot (O-001–O-004) และ O-005 ก่อน B3.2
ธนาคารที่รับเงิน · จำนวนตึก/ชั้น/ยูนิต/ผังมิเตอร์ · ไฟล์ Excel/โปรแกรมที่ใช้อยู่ (สำหรับ import) · บิลการไฟฟ้า/ประปาย้อนหลัง 6 เดือน · จดทะเบียน VAT หรือไม่ · อัตราค่าน้ำ/ไฟที่เก็บอยู่ปัจจุบัน — ใส่ใน `docs/decisions.md` (O-### → D-###) ก่อน schema review

## หลังทุก session
ตรวจ `docs/PROGRESS.md` · ถ้า session นั้นแก้ API ต้องมี `contract/openapi.json` ใหม่ใน commit → แจ้งฝั่ง `getproperty-web` และ `getproperty-liff` ให้รัน `pnpm gen:api` · ถ้าต้องแก้ตาราง `core.*` → PR ไปที่ `collective-asset-core` แล้ว bump version · ถ้าแก้ DTO ของ MQTT ต้องมี `contract/device-protocol.json` ใหม่ → แจ้ง `getproperty-edge` ให้รัน `pnpm gen:protocol` · tag release เมื่อ contract เปลี่ยน
