# getproperty Platform Blueprint — Collective Group

Oct 16, 2026 · @Superball · infrastructure alignment Oct 21, 2026 (see *Changelog* at the end)

## Executive summary

**getproperty** คือ Building Operations platform ของ Collective Group: ระบบเดียวสำหรับทุกคนที่ "บริหารอาคารที่มีคนอยู่" — เจ้าของอพาร์ตเม้นต์/หอพัก (ลูกค้ารายแรก), นิติบุคคลอาคารชุด, บริษัทบริหารอาคาร (PM company) และเจ้าของห้องรายย่อยที่ปล่อยเช่า (landlord) ขายเป็น SaaS ต่ออาคาร/ต่อยูนิต บวก IoT (smart meter, access control) ที่สร้างรายได้จาก hardware และข้อมูลที่ไหลเข้าบิลอัตโนมัติ

เอกสารนี้ขยาย scope จาก "ระบบบริหารอพาร์ตเม้นต์ + IoT" ที่เริ่มเขียนโค้ดเมื่อ 16 ต.ค. 2026 ให้เป็น platform เต็มรูปแบบ โดย**ไม่เปลี่ยนสิ่งที่ลูกค้ารายแรกจะได้** แต่ล็อก data model และชื่อตารางให้เป็นกลางตั้งแต่สัปดาห์แรก เพื่อให้เพิ่ม tenant type อื่นได้โดยไม่ migrate

ความสัมพันธ์ในตระกูล get\*: **getbuild** (Build & Deliver — ผู้รับเหมา, Developer) ส่งอาคารที่สร้างเสร็จ ยูนิต เจ้าของ defect history และทะเบียนทรัพย์สินเข้า getproperty ด้วย handover event; **getpack** รับใบขอซื้อวัสดุและอะไหล่ซ่อมบำรุงจาก getproperty; ทั้งสามใช้ `collective-shared` (auth, LINE, billing, UI) และ `collective-asset-core` (building → unit → party) ร่วมกัน โดย **getproperty เป็นเจ้าของ schema ของ asset core** เพราะเป็น platform ที่ถือข้อมูลอาคารยาวที่สุด

ข้อสรุปหลัก:

- 4 tenant types บน core เดียว ต่างกันที่ "ใครเป็นเจ้าของยูนิต" และ "ใครจ่ายบิล": apartment (เจ้าของเดียว ผู้เช่าจ่าย), condo juristic (เจ้าของร่วมหลายราย จ่ายค่าส่วนกลาง), PM company (บริหารแทนหลายอาคาร), landlord (เจ้าของรายย่อย ยูนิตกระจายหลายอาคาร)
- 12 modules ใน 4 กลุ่ม: A ฐานปฏิบัติการอาคาร (เช่า/ผู้อยู่อาศัย, บิล/บัญชี, smart meter, แจ้งซ่อม), B นิติบุคคล (AGM & e-Voting, AI Juristic Assistant, Asset & Sinking Fund & Inspection), C อาคารอัจฉริยะและ portfolio (access control, energy, PM back-office), D จุดเชื่อม (post-sale portal, landlord tier)
- Phase 1 (ตอนนี้–ก.พ. 2027) ส่งมอบกลุ่ม A ให้อพาร์ตเม้นต์รายแรก บน schema กลางที่ออกแบบไว้ในเอกสารนี้; Phase 2 เปิดคอนโดและ PM company; Phase 3 landlord และ access control; Phase 4 energy และ AI เต็มรูปแบบ
- รายได้: ต่อยูนิต 15–40 บาท/เดือนสำหรับอพาร์ตเม้นต์/คอนโด (ขั้นบันได), landlord freemium → 99–299 บาท/เดือน, hardware IoT ขาย/เช่า, PM company สัญญารายปี
- Stack เดียวกับ getpack/getbuild: Next.js + NestJS + PostgreSQL (+ TimescaleDB, pgvector), MQTT edge, LINE LIFF เป็นหน้าบ้านของผู้อยู่อาศัยและช่าง — รันบน **Collective shared platform** (AWS `ap-southeast-7`, EC2 + docker compose ต่อ environment; รายละเอียดใน `collective-infra/PLAN.md` และส่วน *Infrastructure & operations* ด้านล่าง)

## Module map

ทุก tenant type ใช้กลุ่ม A เป็นฐาน (เช่า/ผู้อยู่อาศัย, บิล, มิเตอร์, แจ้งซ่อม) แล้วเปิดกลุ่มที่เกี่ยวกับตน: อพาร์ตเม้นต์ใช้ A (+C1, C2), นิติบุคคลใช้ A + B (+C), PM company ใช้ทุกอย่างผ่าน C3, landlord ใช้ A1/A2/A4 ผ่านหน้าจอ D2

&#91;embedded content: module map · 4 tenant types, 12 modules in 4 groups, 1 core\]

กลุ่ม A คือสิ่งที่กำลังเขียนอยู่ใน session หลักของ getproperty ตอนนี้ สิ่งเดียวที่ต้องเปลี่ยนคือชื่อตารางและการเพิ่ม `tenant.type` ตามส่วน Data model ด้านล่าง กลุ่ม B ย้ายมาจาก blueprint getbuild โดยไม่เปลี่ยน scope

## Tenant types & personas

ความต่างระหว่าง 4 tenant types อยู่ที่สองคำถาม: ใครเป็นเจ้าของยูนิต และใครจ่ายบิลอะไร — data model เดียวตอบได้ทั้งหมดถ้า `unit` แยก "ownership" ออกจาก "occupancy" และ `invoice` ระบุ "ผู้ถูกเรียกเก็บ" เป็น party ไม่ใช่ user

| Tenant type | เจ้าของยูนิต | ผู้อยู่อาศัย | บิลหลัก | ขอบเขตอาคาร | Module |
| --- | --- | --- | --- | --- | --- |
| `apartment` (รวมหอพัก, บ้านเช่าหลายหลัง) | tenant เอง | ผู้เช่า (lease) | ค่าเช่า + น้ำ/ไฟตามมิเตอร์ + ค่าบริการ → ผู้เช่าจ่าย | 1–หลายอาคารของตัวเอง | A1–A4, C1, C2 |
| `condo_juristic` | เจ้าของร่วมหลายราย (ownership\_ratio) | เจ้าของหรือผู้เช่าของเจ้าของ | ค่าส่วนกลาง + กองทุน + น้ำ (ถ้านิติฯ ขาย) → เจ้าของร่วมจ่าย | 1 อาคารชุด (หรือ 1 โครงการหลายอาคาร) | A1–A4, B1–B3, C1–C2 |
| `pm_company` | ไม่ได้เป็นเจ้าของ บริหารแทน | ตาม tenant ที่บริหาร | ค่าบริการบริหารที่ตนเรียกเก็บจากนิติฯ/เจ้าของ | หลายสิบ–หลายร้อยอาคารของลูกค้า | C3 + สิทธิ์เข้าทุก module ของอาคารที่บริหาร |
| `landlord` | tenant เอง (1–20 ยูนิต) | ผู้เช่า (lease) | ค่าเช่า → ผู้เช่าจ่าย; ค่าส่วนกลาง → landlord จ่ายให้นิติฯ (ซึ่งอาจอยู่บน getproperty ด้วย) | ยูนิตกระจายหลายอาคารที่ตนไม่ได้บริหาร | A1, A2, A4 ผ่าน D2 |

**Personas**

| Persona | Tenant type | งานหลัก | ช่องทาง |
| --- | --- | --- | --- |
| เจ้าของ/ผู้จัดการอพาร์ตเม้นต์ | apartment | ห้องว่าง, สัญญา, ออกบิล, อ่านมิเตอร์, รับเงิน, แจ้งซ่อม, รายงาน | Web |
| ผู้จัดการนิติบุคคล | condo\_juristic | ค่าส่วนกลาง, ทวงหนี้, ประชุมใหญ่, หนังสือ, ซ่อมบำรุงส่วนกลาง | Web |
| กรรมการนิติบุคคล | condo\_juristic | อนุมัติ, ดูรายงาน, ลงนามรายงานประชุม | Web + LINE |
| ผู้บริหาร PM company | pm\_company | portfolio, พนักงานประจำอาคาร, สัญญา, KPI, ร้องเรียน | Web |
| เจ้าหน้าที่ประจำอาคาร (ธุรการ/ช่างอาคาร/รปภ.) | ทุกชนิด | รับพัสดุ, visitor, work order, อ่านมิเตอร์ (ถ้าไม่มี smart meter), เปิด-ปิดประตู | Mobile web / LIFF |
| Landlord รายย่อย | landlord | portfolio ห้องตน, สัญญา e-sign, ค่าเช่าเข้า, แจ้งซ่อม, ภาษี | LINE LIFF + Web เบา |
| ผู้เช่า | apartment, landlord | ดูบิล จ่าย PromptPay แจ้งซ่อม ดูสัญญา ขอย้ายออก | LINE LIFF |
| เจ้าของร่วม/ลูกบ้าน | condo\_juristic | ดูบิลค่าส่วนกลาง จ่าย แจ้งซ่อม จองส่วนกลาง รับพัสดุ โหวต AGM ถามบอท | LINE LIFF |
| ช่าง/ผู้รับเหมาซ่อมบำรุง (external) | ทุกชนิด | รับงาน work order ถ่ายรูปก่อน-หลัง ปิดงาน | LINE LIFF |
| ผู้ตรวจสอบอาคาร (external) | condo\_juristic | บันทึกผลตรวจประจำปี | Mobile web |
| Collective admin | — | onboarding tenant, แพ็กเกจ, อุปกรณ์ IoT, support, ดูต้นทุน AI | Admin back-office |

## Platform core & collective-asset-core

getproperty เป็นเจ้าของ `collective-asset-core` — package ที่นิยามลำดับชั้นสินทรัพย์, party และ event contract ซึ่ง getbuild ติดตั้งใช้ด้วย การแก้ schema ของตารางเหล่านี้ต้องผ่าน package (migration อยู่ใน package ไม่ใช่ใน repo ของ app)

**Tenancy model**

- `tenant` = องค์กรที่จ่ายเงิน มี `type` (`apartment` / `condo_juristic` / `pm_company` / `landlord`) และ `plan`; shared schema + `tenant_id` ทุกตาราง + PostgreSQL Row-Level Security ตั้งค่าที่ connection (`SET app.tenant_id`) แบบเดียวกับ getpack
- `building` มี **operator tenant** (ใครบริหารตอนนี้) และ **owner tenant** (ใครเป็นเจ้าของนิติบุคคล/อาคาร) แยกกัน: อพาร์ตเม้นต์ทั้งสองเป็น tenant เดียวกัน; คอนโดที่ PM company ดูแล owner = นิติฯ, operator = PM company; post-sale portal owner = (ยังไม่มี) operator = Developer
- `asset_access_grant` ให้ tenant อื่นเข้าถึง scope (building / unit) ตาม module: landlord เห็นเฉพาะยูนิตตน, ช่างเห็น work order ที่ได้รับ, Developer เห็น defect ช่วงรับประกัน
- **Operator change** (PM company เปลี่ยน, นิติฯ รับช่วงจาก Developer) = เปลี่ยน `operator_tenant_id` ของ building + ปิด/เปิด access grant ไม่ copy ข้อมูล ประวัติทั้งหมดอยู่ที่ building

**Asset hierarchy (ใน collective-asset-core)**

| ระดับ | ข้อมูลหลัก | ใช้โดย |
| --- | --- | --- |
| `property` | กลุ่มอาคารที่บริหารด้วยกัน (โครงการ/คอมเพล็กซ์/อพาร์ตเม้นต์ที่มี 2 ตึก) ชื่อ ที่ตั้ง | ทั้งสอง platform (getbuild เรียก project) |
| `building` | property\_id, ชื่อ/ตึก, ชั้น, ประเภท (apartment / condo / house\_cluster), owner\_tenant\_id, operator\_tenant\_id, registration\_no, handed\_over\_at | ทั้งสอง |
| `floor` | building\_id, level, plan\_image\_id | ทั้งสอง |
| `unit` | building\_id, floor\_id, unit\_no, type (room / condo\_unit / house / shop / parking), area\_sqm, ownership\_ratio, status | ทั้งสอง |
| `party` | person / company; ชื่อ, เลขบัตร/passport (encrypted), ติดต่อ, line\_user\_id | ทั้งสอง — เจ้าของ ผู้เช่า ช่าง ผู้ซื้อ |
| `unit_ownership` | unit\_id, party\_id, share\_pct, from/to | คอนโด, landlord (ตั้ง landlord เป็นเจ้าของ) |
| `occupancy` | unit\_id, party\_id, role (tenant / owner\_occupier / family / staff), from/to | ทุกชนิด — ใครอยู่จริง |
| `asset_item` | building\_id/floor\_id, ประเภทอุปกรณ์ (ลิฟต์ ปั๊ม มิเตอร์ กล้อง ประตู) serial, install\_date, expected\_life | B3, A3, C1 และ handover จาก getbuild |
| `document` | storage\_key, kind, scope, version\_of | ทั้งสอง |

**Shared services** (จาก `collective-shared` เว้นที่ระบุ)

| Service | หน้าที่ |
| --- | --- |
| Identity & RBAC | Email/password + OTP สำหรับ staff, LINE Login สำหรับผู้อยู่อาศัย/ช่าง/landlord, role per tenant per module |
| Billing engine (getproperty-specific แต่ reuse invoice/e-Tax จาก getpack) | line item ตามแหล่ง (เช่า / มิเตอร์ / ค่าส่วนกลางตาม ratio / ค่าปรับ), รอบบิล, เงินเพิ่ม, รับชำระ PromptPay QR ต่อบิล, กระทบยอดอัตโนมัติ, ใบเสร็จ/ใบกำกับ |
| Document store | รูป สัญญา PDF; signed URL; retention |
| Notification | LINE Flex (บิล, แจ้งเตือน, สถานะซ่อม), email, SMS fallback |
| Workflow engine | state machine สำหรับ work order, ทวงหนี้, AGM, inspection (ย้ายเป็น shared กับ getbuild) |
| IoT ingestion (`getproperty-edge` + ingest ของ `getproperty-api`) | gateway → MQTT (EMQX กลางของ platform) → device registry → TimescaleDB (PostgreSQL กลางบน box); ใช้กับมิเตอร์ ประตู พลังงาน และกล้องหน้างานของ getbuild |
| AI gateway | model router, prompt versioning, metering ต่อ tenant (ใช้ร่วม getbuild) |
| Audit log | immutable 10 ปี |
| Reporting | export PDF/Excel, dashboard per tenant และ portfolio (PM company) |

## Data model & naming guideline (for the current getproperty codebase)

ส่วนนี้เขียนเพื่อวางลงใน Claude Code session ของ getproperty ได้ทันที หลักการเดียว: **ตั้งชื่อเป็นกลางวันนี้ แล้วค่อยเพิ่ม tenant type ทีหลังโดยไม่ migrate** — ไม่ต้องสร้างตารางของกลุ่ม B/C/D ตอนนี้ แค่อย่าปิดประตู

**กฎการตั้งชื่อ**

| ห้ามใช้ | ใช้แทน | เหตุผล |
| --- | --- | --- |
| `apartment`, `dorm` (เป็นชื่อตาราง) | `property` (กลุ่มอาคาร) + `building` | คอนโด/บ้านเช่าใช้คำเดียวกันได้ |
| `room` | `unit` (+ `unit.type` = room / condo\_unit / house / shop / parking) | ห้องเช่า ห้องชุด บ้าน ที่จอดรถ เป็น unit ทั้งหมด |
| `tenant` ในความหมาย "ผู้เช่า" | `tenant` = องค์กรลูกค้า SaaS เท่านั้น; ผู้เช่า = `party` + `occupancy.role = tenant` / `lease.lessee_party_id` | ชนกับ multi-tenancy เป็นบั๊กที่แก้ยากที่สุด |
| `customer`, `resident`, `owner` เป็นตาราง | `party` ตารางเดียว + ความสัมพันธ์ (`occupancy`, `unit_ownership`, `lease`) | คนเดียวเป็นได้ทั้งเจ้าของและผู้เช่าและช่าง |
| `rent_invoice`, `water_bill` | `invoice` + `invoice_line` (`source_type`: rent / meter / common\_fee / fund / penalty / service / deposit) | บิลหนึ่งใบมีหลายแหล่ง และคอนโดไม่มีค่าเช่า |
| `meter` ผูกกับ room โดยตรง | `meter` เป็น `asset_item` ชนิด meter + `meter_assignment` (unit\_id, from/to) | มิเตอร์ย้ายห้อง/เปลี่ยนตัวได้ ประวัติต้องอยู่ |
| `landlord_id` บน unit | `unit_ownership` (party\_id, share\_pct) | รองรับเจ้าของร่วมหลายคนและเปลี่ยนมือ |
| `status` เป็น string อิสระ | enum ต่อ entity + `workflow_instance` สำหรับสิ่งที่มี SLA | ให้ workflow engine จัดการ |

**ตารางที่ต้องมีใน Phase 1 (กลุ่ม A) และคอลัมน์ที่ห้ามลืม**

| ตาราง | คอลัมน์สำคัญ | หมายเหตุสำหรับอนาคต |
| --- | --- | --- |
| `tenant` | id, name, **type** (enum: apartment / condo\_juristic / pm\_company / landlord), tax\_id, plan, settings (jsonb) | ใส่ type ตั้งแต่วันแรก ค่า default = apartment |
| `membership` | tenant\_id, user\_id, role, module\_scopes (jsonb) | role per module |
| `user` | id, email, phone, line\_user\_id, status | user ≠ party; staff เป็น user, ผู้เช่าเป็น party ที่อาจมี user ผูก |
| `property` | tenant\_id (operator), name, address, geo |  |
| `building` | property\_id, name, type, floors, **owner\_tenant\_id**, **operator\_tenant\_id**, registration\_no, handed\_over\_at, source\_ref (จาก getbuild) | สองคอลัมน์ tenant นี้คือสิ่งที่ทำให้ PM company และ post-sale portal เป็นไปได้ |
| `floor` | building\_id, level, plan\_image\_id |  |
| `unit` | building\_id, floor\_id, unit\_no, **type**, area\_sqm, **ownership\_ratio** (nullable), status (vacant / occupied / reserved / maintenance), base\_rent (nullable) | ownership\_ratio ไม่ใช้กับอพาร์ตเม้นต์ แต่ต้องมีคอลัมน์ |
| `party` | tenant\_id, type (person / company), name, id\_number\_enc, phone, email, line\_user\_id, address | เข้ารหัสเลขบัตรตั้งแต่แรก |
| `unit_ownership` | unit\_id, party\_id, share\_pct, from\_date, to\_date | อพาร์ตเม้นต์: 1 แถว = เจ้าของคือ tenant เอง (party ของบริษัท) |
| `occupancy` | unit\_id, party\_id, role, from\_date, to\_date | ใครอยู่จริง แยกจากสัญญา |
| `lease` | unit\_id, lessee\_party\_id, start/end, rent, deposit, billing\_day, terms (jsonb), signed\_doc\_id, status | สัญญาเช่า; คอนโดนิติฯ ไม่ใช้ landlord ใช้ |
| `deposit` | lease\_id, amount, held\_at, returned\_at, deductions (jsonb) |  |
| `asset_item` | building\_id, floor\_id, unit\_id (nullable), category, model, serial, install\_date, expected\_life\_years, meta | มิเตอร์ ปั๊ม ลิฟต์ ประตู กล้อง ใช้ตารางนี้ |
| `meter_assignment` | asset\_item\_id, unit\_id, from, to, multiplier, initial\_reading |  |
| `meter_reading` | asset\_item\_id, read\_at, value, source (iot / manual / estimate), reading\_batch\_id | TimescaleDB hypertable เมื่อมี IoT; เริ่มเป็นตารางปกติได้ |
| `rate_plan` | tenant\_id, kind (water / power / common\_fee / rent), tiers (jsonb), effective\_from | อัตราค่าน้ำ-ไฟที่เจ้าของตั้งเองหรือตามการไฟฟ้า |
| `billing_cycle` | tenant\_id, period, status, generated\_at | ออกบิลเป็นรอบ |
| `invoice` | tenant\_id, **billed\_party\_id**, unit\_id, cycle\_id, due\_date, total, status, promptpay\_ref | ผู้ถูกเรียกเก็บเป็น party |
| `invoice_line` | invoice\_id, **source\_type**, source\_id, description, qty, unit\_price, amount, period\_from/to | source\_id ชี้ lease / meter\_reading / fund ฯลฯ |
| `payment` | invoice\_id, amount, method, paid\_at, ref, slip\_doc\_id, reconciled\_at |  |
| `receipt` / `tax_invoice` | payment\_id, number, issued\_at, e\_tax\_ref | reuse จาก getpack |
| `service_request` | unit\_id / building\_id, requester\_party\_id, category, description, photos, priority, status, workflow\_instance\_id | แจ้งซ่อม = ฐานของ work order และ defect ช่วงรับประกัน |
| `work_order` | service\_request\_id (nullable), asset\_item\_id (nullable), assignee\_party\_id, scheduled\_at, cost, before/after photos, status | ช่าง external เป็น party |
| `announcement`, `parcel`, `facility_booking` | ตามเดิม ผูก building\_id/unit\_id | feature ลูกบ้านมาตรฐาน |
| `document`, `notification`, `audit_log`, `workflow_instance`, `workflow_event` | shared |  |
| `integration_event` | direction, platform (getbuild / getpack), event\_type, payload, status | สร้างตารางไว้เลย ยังไม่ต้องมี consumer |

**กฎทางเทคนิคสำหรับ prompt pack**

1. ทุกตารางมี `id uuid`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `deleted_at`; RLS policy ต่อตารางใช้ `current_setting('app.tenant_id')`
2. ตารางใน asset core (`property`, `building`, `floor`, `unit`, `party`, `unit_ownership`, `occupancy`, `asset_item`, `document`) อยู่ใน schema `core`; ตารางของ module อยู่ใน schema ตามกลุ่ม (`ops`, `juristic`, `smart`, `bridge`) เพื่อแยกเป็น package ภายหลัง
3. Enum เป็น PostgreSQL enum หรือ lookup table ที่ seed ได้ ไม่ใช่ string literal ในโค้ด; `tenant.type`, `unit.type`, `invoice_line.source_type` ต้องเป็น enum
4. เงินเป็น `numeric(14,2)` สกุล THB เท่านั้นใน Phase 1; ปริมาณมิเตอร์เป็น `numeric(12,3)`
5. PII (เลขบัตร, passport, เลขบัญชี) เข้ารหัสระดับคอลัมน์ด้วย key ต่อ tenant; log การเข้าถึง
6. ทุก feature ที่คุยกับผู้อยู่อาศัยออกแบบเป็น LIFF-first; web ของผู้เช่าเป็น fallback
7. Billing ไม่ hardcode สูตร: `rate_plan.tiers` เป็น jsonb ที่ engine ตีความ ทำให้ค่าส่วนกลางตาม ratio ของคอนโดใช้ engine เดียวกับค่าเช่า

**Checklist สำหรับโค้ดที่เขียนไปแล้ววันนี้**

- [ ] rename ตาราง/entity ที่ชื่อ room → unit, apartment → property/building, tenant (ผู้เช่า) → party/lease
- [ ] เพิ่ม `tenant.type` enum ค่า default `apartment`
- [ ] เพิ่ม `building.owner_tenant_id` และ `operator_tenant_id` (ตอนนี้ค่าเดียวกัน)
- [ ] เพิ่ม `unit.type` และ `unit.ownership_ratio` (nullable)
- [ ] แยก `party` ออกจาก `user`
- [ ] ย้ายมิเตอร์ไปเป็น `asset_item` + `meter_assignment`
- [ ] เปลี่ยนบิลเป็น `invoice` + `invoice_line.source_type`
- [ ] สร้าง schema `core` และย้ายตาราง asset core เข้าไป
- [ ] สร้างตาราง `integration_event` เปล่า

## Group A: Operations base (Phase 1)

สี่ module นี้คือสิ่งที่ลูกค้าอพาร์ตเม้นต์รายแรกจะได้ และเป็นฐานที่ tenant type อื่นใช้ร่วม เป้าหมายคือให้เจ้าของอพาร์ตเม้นต์ปิดรอบบิลรายเดือนได้ภายใน 1 ชั่วโมงแทน 2–3 วัน และผู้เช่าจ่ายผ่าน LINE โดยไม่ต้องส่งสลิป

**A1 Lease & Occupant**

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Unit board | ผังห้องทุกตึก/ชั้น สถานะว่าง/มีผู้เช่า/จอง/ซ่อม, ค้นหา, filter |
| 2 | Lead & reservation | ผู้สนใจจาก LINE/เว็บ, นัดดูห้อง, จองพร้อมมัดจำ, แปลงเป็นสัญญา |
| 3 | Lease | สัญญาเช่าจากเทมเพลต (ไทย/อังกฤษ), ค่าเช่า, มัดจำ, วันครบกำหนด, เงื่อนไข; e-sign ผ่าน LIFF; ต่ออายุ/แจ้งย้ายออก |
| 4 | Occupant registry | ผู้อยู่อาศัยทุกคนต่อยูนิต (ผู้เช่า ผู้ร่วมพัก), เอกสารยืนยันตัวตน (เข้ารหัส), ยานพาหนะ, สัตว์เลี้ยง; ใช้โดย access control และกฎหมายแจ้งที่พักคนต่างด้าว (ตม.30) |
| 5 | Move-in / move-out | checklist สภาพห้อง + รูป, อ่านมิเตอร์ตอนเข้า-ออก, คำนวณคืนมัดจำพร้อมรายการหัก |
| 6 | Resident LIFF | ดูสัญญา บิล แจ้งซ่อม ประกาศ พัสดุ จองส่วนกลาง (ถ้ามี) |

**A2 Billing & Accounting**

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Billing cycle | สร้างบิลทั้งอาคารต่อรอบ: ค่าเช่า + น้ำ/ไฟจากมิเตอร์ (A3) + ค่าบริการ + ค่าปรับ; ตรวจก่อนออก; ออกเป็น batch |
| 2 | Rate plans | อัตราน้ำ/ไฟแบบขั้นบันไดหรือคงที่ + ค่าบริการขั้นต่ำ; สำหรับคอนโด: ค่าส่วนกลางตาม ratio × อัตราต่อ ตร.ม. + กองทุน |
| 3 | Delivery & payment | ส่งบิลทาง LINE Flex พร้อม PromptPay QR เฉพาะบิล (เลขอ้างอิง), บัตร, โอนแนบสลิป; กระทบยอดอัตโนมัติจาก bank statement/API |
| 4 | Receipt & tax invoice | ใบเสร็จอัตโนมัติ, ใบกำกับภาษี (e-Tax) สำหรับผู้เช่านิติบุคคล, ใบแจ้งหนี้ย้อนหลัง |
| 5 | Dunning (เบา) | เตือนก่อนครบกำหนด/เกินกำหนด 3 ระดับ, ค่าปรับอัตโนมัติตามสัญญา; เวอร์ชันเต็มตามกฎหมายอาคารชุดอยู่ใน B2 |
| 6 | Ledger & reports | รายรับ-รายจ่ายต่ออาคาร, ลูกหนี้คงค้าง, aging, งบกระแสเงินสดอย่างง่าย, export Excel/สำหรับผู้ทำบัญชี; รายจ่ายจาก work order (A4) เข้าบัญชีอัตโนมัติ |
| 7 | Owner payout (landlord/PM) | สรุปยอดสุทธิต่อเจ้าของหลังหักค่าบริหาร สำหรับ PM company และ landlord ที่ให้คนอื่นบริหาร |

**A3 Smart Meter & Utility Billing**

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Device registry | มิเตอร์น้ำ/ไฟ (LoRaWAN / NB-IoT / Modbus gateway / pulse), ผูกกับยูนิตผ่าน `meter_assignment`, ค่าเริ่มต้น, multiplier |
| 2 | Ingestion (`getproperty-edge`) | MQTT → validate → TimescaleDB; ตรวจค่าถอยหลัง/กระโดด/ขาดหาย; สถานะอุปกรณ์ออนไลน์ |
| 3 | Manual & photo reading | สำหรับอาคารที่ยังไม่ติด smart meter: เจ้าหน้าที่ถ่ายรูปมิเตอร์ใน LIFF, AI อ่านตัวเลข (OCR) ให้ยืนยัน |
| 4 | Reading-to-bill | ปิดรอบอ่านค่า → คำนวณหน่วยใช้ → invoice\_line อัตโนมัติ; รองรับ estimate เมื่อขาดค่า |
| 5 | Consumption dashboard | ต่อยูนิต/ต่อตึก, เทียบเดือนก่อน, แจ้งน้ำรั่ว (ใช้ต่อเนื่องกลางคืน), ผู้เช่าเห็นการใช้ของตนใน LIFF |
| 6 | Prepaid / cut-off (optional) | สั่งตัด/เปิดไฟฟ้าผ่าน smart breaker สำหรับหอพักที่ใช้ระบบเติมเงิน |

**A4 Service Request & Maintenance**

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Request intake | ผู้เช่า/ลูกบ้านแจ้งผ่าน LIFF พร้อมรูป หมวด ความเร่งด่วน; เจ้าหน้าที่แจ้งแทนได้ |
| 2 | Triage & work order | มอบหมายช่างใน/นอก (party), นัดเวลา, SLA ตามหมวด, แจ้งผู้เช่า |
| 3 | Technician LIFF | รับงาน เช็คอิน ถ่ายรูปก่อน-หลัง บันทึกอะไหล่/ค่าใช้จ่าย ปิดงาน ผู้เช่าให้คะแนน |
| 4 | Preventive maintenance | ตารางบำรุงรักษาต่อ `asset_item` (ปั๊ม ถังน้ำ แอร์ส่วนกลาง), เตือนล่วงหน้า |
| 5 | Parts & vendor | อะไหล่ที่ใช้บ่อย, ผู้ขาย/ช่างประจำ, RFQ ส่งเข้า getpack เมื่อเปิด |
| 6 | Warranty link | ยูนิต/อุปกรณ์ที่มาจาก getbuild มีช่วงรับประกัน: request ในช่วงนั้นถูกส่งกลับไปที่ Developer/ผู้รับเหมาผ่าน integration\_event แทนช่างของอาคาร |

**Phase 1 acceptance (ลูกค้าอพาร์ตเม้นต์รายแรก)**: ย้ายข้อมูลห้อง/ผู้เช่า/มิเตอร์จาก Excel, ออกบิลรอบแรกครบทุกห้องภายใน 1 ชม., ผู้เช่า ≥60% จ่ายผ่าน QR ในระบบ, แจ้งซ่อมผ่าน LINE ทั้งหมด, smart meter อย่างน้อย 1 ตึกส่งค่าเข้าบิลอัตโนมัติ

## Group B: Condo juristic

สาม module ที่ย้ายมาจาก blueprint getbuild โดยไม่เปลี่ยน scope ขายผ่านสมาคมอาคารชุดไทยและ PM company ซึ่งปิดครั้งเดียวได้หลายอาคาร ต่างจากฉบับเดิมตรงที่ตอนนี้นั่งอยู่บน A1–A4 (ทะเบียนเจ้าของร่วม, บิลค่าส่วนกลาง, แจ้งซ่อม) จึงไม่ต้องสร้างทะเบียนและบิลซ้ำ

**B1 AGM & e-Voting** — จัดประชุมใหญ่ให้ครบองค์ประชุมและถูกต้องตาม พ.ร.บ.อาคารชุด

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Meeting setup | วาระ, เอกสาร, ประเภทมติและสัดส่วนคะแนนต่อวาระ (เสียงข้างมาก / ≥1/4 / ≥1/2 ของคะแนนเสียงทั้งหมด) ตามมาตรา 48–49 — ตารางเกณฑ์เป็น config ให้ทนายทบทวน |
| 2 | Notice & delivery | หนังสือเชิญผ่าน LINE/email/พิมพ์ส่งไปรษณีย์ลงทะเบียน; หลักฐานการส่งต่อยูนิตล่วงหน้าตามจำนวนวันที่กฎหมายกำหนด |
| 3 | Proxy | มอบฉันทะใน LIFF (แนบบัตร ลายเซ็น) หรือสแกนกระดาษแล้ว AI อ่าน; ตรวจเพดานผู้มอบต่อผู้รับมอบ |
| 4 | Check-in & quorum | QR/บัตรประชาชน หรือเข้าร่วมออนไลน์ (hybrid); องค์ประชุมสะสม real-time เป็น % คะแนนเสียง; ตัดสิทธิ์ผู้ค้างชำระจาก A2 อัตโนมัติ |
| 5 | e-Voting | ลงคะแนนจากมือถือหรือเจ้าหน้าที่คีย์แทน; น้ำหนักตาม `unit.ownership_ratio`; ผลทันที; audit trail ต่อยูนิต |
| 6 | Hybrid meeting | Zoom/Meet, บันทึกเสียง/ภาพ, ข้อกำหนด e-Meeting |
| 7 | AI minutes | ถอดเสียง → ร่างรายงานการประชุม; กรรมการแก้และลงนามอิเล็กทรอนิกส์ |
| 8 | Filing pack | ชุดเอกสารยื่นกรมที่ดินเป็น PDF |

**B2 AI Juristic Assistant** — ผู้ช่วยผู้จัดการนิติฯ ตอบจากกฎหมาย + ข้อบังคับ + มติของอาคารนั้น ทุกคำตอบมี citation

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Knowledge base per building | ข้อบังคับ, มติ (จาก B1 อัตโนมัติ), ระเบียบ, สัญญาบริการ → chunk + embed ต่อ tenant (pgvector) |
| 2 | Legal Q&A | อ้างมาตราใน พ.ร.บ.อาคารชุด 2522 และที่แก้ไข, กฎกระทรวง, ข้อบังคับ; abstain เมื่อไม่มีแหล่ง; guardrail "ไม่ใช่คำแนะนำทางกฎหมาย" |
| 3 | Resident bot (LINE) | ตอบกฎการใช้ส่วนกลาง ค่าธรรมเนียม ขั้นตอน; ส่งต่อเจ้าหน้าที่เมื่อเป็นข้อร้องเรียน |
| 4 | Letter generator | เทมเพลต 20+ แบบ เติมข้อมูลจากยูนิต/เจ้าของ ออก PDF เลขที่หนังสือ |
| 5 | Dunning workflow (เต็ม) | ลำดับทวงหนี้ตามข้อบังคับ: แจ้งเตือน → ทวง → เงินเพิ่มตามกฎหมาย → ระงับสิทธิ์ (โหวต/ส่วนกลาง) → ส่งทนาย; ต่อยอดจาก dunning เบาใน A2 |
| 6 | Complaint & case log | เคสข้อร้องเรียน/ข้อพิพาท, AI สรุปไทม์ไลน์ |
| 7 | Regulatory watch | แจ้งกฎหมาย/ประกาศใหม่พร้อมสรุปผลกระทบ (ทีมเนื้อหากลางดูแล corpus) |
| 8 | Audit of advice | เก็บทุกคำถาม-คำตอบ-แหล่งอ้างอิง |

**B3 Asset, Sinking Fund & Inspection** — รู้ล่วงหน้า 10 ปีว่าต้องเปลี่ยนอะไร ใช้เงินเท่าไร และกองทุนพอไหม

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Asset registry | ขยาย `asset_item` ให้ครบอุปกรณ์ส่วนกลาง (ลิฟต์ ปั๊ม generator chiller ดับเพลิง สระ กล้อง) + QR + สัญญาบำรุงรักษา; เริ่มจาก asset list ที่ getbuild ส่งมาตอน handover |
| 2 | Maintenance plan | PM schedule ตามคู่มือ/กฎหมาย (ตรวจลิฟต์รายปี, ดับเพลิง); ช่างสแกน QR บันทึก (reuse A4 work order) |
| 3 | Lifecycle & cost forecast | คาดการณ์ปีเปลี่ยน/ซ่อมใหญ่จากอายุ ประวัติ เงินเฟ้อ → แผน 10–30 ปี |
| 4 | Sinking fund planner | เงินกองทุน + เงินสมทบ vs แผนค่าใช้จ่าย; จำลองสถานการณ์; สร้างเอกสารเสนอที่ประชุม (→ B1) |
| 5 | Annual building inspection | แบบตรวจตามกฎกระทรวง 4 ด้าน; ผู้ตรวจสอบอาคารกรอกบนมือถือ + รูป; รายงานตามรูปแบบท้องถิ่น; ติดตามรายการแก้ |
| 6 | Compliance calendar | รายงานตรวจสอบอาคาร, ตรวจลิฟต์, หม้อแปลง, ประกันภัยอาคาร; เตือนกรรมการ |
| 7 | Benchmark | ค่าซ่อมบำรุงต่อ ตร.ม. เทียบอาคารใกล้เคียง (anonymized, opt-in) |

**AI ของกลุ่ม B**: RAG สองชั้น (corpus กลางที่ Collective ดูแล + corpus ต่อ tenant), citation บังคับ, eval set 200+ คำถามที่ทนายตรวจก่อนปล่อยทุก prompt version; STT + diarization สำหรับ AGM; forecasting ของ B3 ไม่ใช่ LLM (survival/regression บน asset history)

**Success metrics**: ครบองค์ประชุมครั้งแรก 70%, รายงานการประชุมร่างใน 24 ชม., 60% คำถามลูกบ้านปิดโดย bot, ยอดค้างชำระ >90 วันลด 25% ใน 12 เดือน, อาคารมีแผนกองทุน 10 ปี 100%, รายงานตรวจสอบอาคารส่งทันกำหนด 100%

## Group C: Smart building & portfolio

สาม module ที่ไม่ใช้ AI แต่มี moat จากการผูก hardware เข้ากับทะเบียนเจ้าของ/ผู้อยู่อาศัยกลาง (สิ่งที่ vendor ประตู-กล้อง-มิเตอร์แยกกันทำไม่ได้) และจาก PM company ที่ซื้อครั้งเดียวได้หลายสิบอาคาร

**C1 Access Control, Visitor & Parking**

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Credential from registry | สิทธิ์เข้าออกออกจาก `occupancy` และ `unit_ownership` อัตโนมัติ: ย้ายออก/ขายห้อง = สิทธิ์หมดวันนั้น; ค้างชำระเกินกำหนด = จำกัดสิทธิ์ส่วนกลางตามข้อบังคับ |
| 2 | Gate & door integration | face terminal, QR, บัตร, ไม้กั้นรถอ่านป้ายทะเบียน (LPR) ผ่าน adapter ต่อยี่ห้อ (Hikvision/ZKTeco/Dahua เป็นต้น); สถานะอุปกรณ์ใน device registry |
| 3 | Visitor pass | ลูกบ้านออก QR ชั่วคราวให้ผู้มาเยือน/ไรเดอร์ใน LIFF, รปภ.ยืนยัน, บันทึกเข้า-ออก, แจ้งลูกบ้าน |
| 4 | Parking | สติ๊กเกอร์/ทะเบียนรถต่อยูนิต, โควตา, ที่จอดผู้มาเยือนและค่าจอดเกินเวลา (→ invoice\_line) |
| 5 | Parcel | รับพัสดุสแกน แจ้ง LINE ลูกบ้านมารับ (ย้ายจาก A ถ้ามีอยู่แล้ว) |
| 6 | Logs & compliance | ประวัติเข้าออก retention ตาม PDPA, export ให้ตำรวจเมื่อมีคำขอตามขั้นตอน |

**C2 Energy Management**

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Common-area metering | มิเตอร์ย่อยส่วนกลาง (ลิฟต์ ปั๊ม แอร์ล็อบบี้ ไฟทางเดิน สระ) เข้า `getproperty-edge` เดียวกับ A3 |
| 2 | Baseline & anomaly | ค่าฐานต่ออุปกรณ์/ช่วงเวลา, แจ้งเมื่อผิดปกติ (ปั๊มทำงานต่อเนื่อง = น้ำรั่ว) |
| 3 | Scheduling & control | ตั้งเวลาเปิด-ปิดผ่าน smart relay/BMS gateway; โหมดประหยัดช่วงกลางคืน |
| 4 | Allocation | แบ่งค่าไฟส่วนกลางเข้าค่าส่วนกลาง/ค่าบริการอย่างโปร่งใส แสดงให้ลูกบ้านเห็น |
| 5 | Saving report | ก่อน-หลังเป็นบาท; รองรับโมเดล saving-sharing กับนิติฯ |
| 6 | Solar/EV (later) | ผลิตไฟจาก solar ส่วนกลาง, EV charger คิดเงินต่อยูนิต |

**C3 PM Company Back-office**

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Portfolio dashboard | ทุกอาคารที่บริหาร: ยอดเก็บ, ค้างชำระ, งานซ่อมค้าง, ร้องเรียน, SLA, สัญญาบริการใกล้หมด |
| 2 | Staffing | พนักงานประจำอาคาร (ผู้จัดการ ธุรการ ช่าง รปภ.) มอบหมาย/หมุนเวียน, ตารางเวร, เช็คอินหน้างาน |
| 3 | Service contract | สัญญากับนิติฯ แต่ละแห่ง: ขอบเขต ค่าบริการ KPI วันต่ออายุ; ออกใบแจ้งหนี้ค่าบริหาร (A2) |
| 4 | Standard operating templates | เทมเพลตข้อบังคับ หนังสือ checklist งบประมาณ ใช้ซ้ำทุกอาคาร |
| 5 | Multi-building AGM calendar | จัดประชุม B1 หลายอาคารในปฏิทินเดียว |
| 6 | Owner/board reporting | รายงานประจำเดือนต่อกรรมการแต่ละอาคาร สร้างอัตโนมัติ |
| 7 | Onboarding wizard | รับอาคารใหม่: import ทะเบียน, มิเตอร์, สัญญาเดิม; เปลี่ยน operator ของ building |

**Success metrics**: สิทธิ์เข้าออกที่ค้างหลังย้ายออก 0 กรณี, ค่าไฟส่วนกลางลด 10–15% ในอาคารที่ใช้ C2, PM company 1 รายนำอาคารขึ้นระบบ ≥10 อาคารใน 90 วัน

## Group D: Bridges — Post-sale Portal & Landlord Tier

สอง module ที่ทำให้ลูกค้าไหลจาก getbuild เข้า getproperty โดยอัตโนมัติ ไม่ใช่ feature ใหญ่ แต่เป็นท่อน้ำเลี้ยงของ platform: ทุกยูนิตที่ Developer โอนผ่าน getbuild M7 จะกลายเป็นผู้ใช้ getproperty ตั้งแต่วันโอน

**D1 Post-sale Portal** (Developer เป็น operator ชั่วคราว 6–18 เดือนก่อนจดทะเบียนนิติบุคคล)

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Auto-provision | handover event จาก getbuild สร้าง building (operator = Developer tenant, owner = null), unit, party, ownership, defect/warranty, as-built, asset list |
| 2 | Interim operations | ใช้ A2 (ค่าส่วนกลางชั่วคราวตาม ratio), A4 (แจ้งซ่อม — ช่วงรับประกันส่งกลับ getbuild), ประกาศ, พัสดุ, จองส่วนกลาง, C1 ถ้ามี |
| 3 | Resident onboarding | ผู้ซื้อที่มี LINE อยู่แล้วจาก getbuild LIFF เข้าใช้ได้ทันที (identity เดียวกัน) |
| 4 | Juristic formation | เตรียมจดทะเบียน: ทะเบียนเจ้าของร่วมครบ, ร่างข้อบังคับ (เทมเพลตจาก B2), ประชุมเลือกกรรมการครั้งแรก (B1) |
| 5 | Operator transfer | เมื่อจดทะเบียน: สร้าง tenant `condo_juristic` (หรือมอบ PM company), ตั้ง owner/operator ใหม่, ปิด access grant ของ Developer ยกเว้น warranty; ประวัติทั้งหมดอยู่ที่ building |
| 6 | Developer dashboard | หลายโครงการที่อยู่ช่วง post-sale: ยอดเก็บค่าส่วนกลางชั่วคราว, defect ค้าง, ความพร้อมจดทะเบียน |

**D2 Landlord Tier** (เจ้าของห้องรายย่อย 1–20 ยูนิตกระจายหลายอาคาร)

| # | Feature | รายละเอียด |
| --- | --- | --- |
| 1 | Portfolio-first UI | หน้าแรกคือรายการยูนิตของตน (ไม่ใช่อาคาร): สถานะว่าง/เช่า, ค่าเช่าเข้าเดือนนี้, สัญญาใกล้หมด, งานซ่อม |
| 2 | Unit intake | รับยูนิตจาก getbuild M7 (ผู้ซื้อติดธงปล่อยเช่า) พร้อม warranty; หรือเพิ่มเอง (บ้าน/คอนโดที่ซื้อจากที่อื่น) |
| 3 | Listing | ประกาศหาผู้เช่า: รูป ราคา เงื่อนไข; ส่งต่อไปเว็บประกาศ/LINE; รับ lead เข้า A1 |
| 4 | Lease & e-sign | สัญญาเช่ามาตรฐาน (ไทย/อังกฤษ) จาก A1, e-sign ทั้งสองฝ่ายใน LIFF, มัดจำ |
| 5 | Rent collection | บิลอัตโนมัติ + PromptPay QR ต่อสัญญา (A2), เตือนผู้เช่า, กระทบยอด, สรุปรายได้ |
| 6 | Service request | ผู้เช่าแจ้งซ่อมผ่าน LIFF (A4); landlord เลือกช่างเอง, ช่างในระบบ, หรือส่งต่อนิติฯ ของอาคารนั้นถ้าอยู่บน getproperty |
| 7 | Tax helper | สรุปรายได้ค่าเช่าและค่าใช้จ่ายรายปีสำหรับ ภ.ง.ด.90/94 (เงินได้ 40(5)); ภาษีที่ดินและสิ่งปลูกสร้างต่อยูนิต |
| 8 | Common fee pass-through | ถ้านิติฯ ของอาคารอยู่บน getproperty: บิลค่าส่วนกลางของ landlord แสดงใน portfolio และจ่ายได้ที่เดียว |

**โมเดลธุรกิจของ D2**: freemium 1–3 ยูนิต, 99–299 บาท/เดือนเมื่อเกิน; มูลค่าจริงคือ (1) ฐานผู้ใช้ที่โตเป็นอพาร์ตเม้นต์, (2) ข้อมูลค่าเช่าตลาดจริงต่อโครงการที่ขายกลับให้ Developer ใน getbuild, (3) ทำให้นิติฯ ของอาคารนั้นมีเหตุผลย้ายมา getproperty เพราะเจ้าของร่วมอยู่บนระบบแล้ว

**Success metrics**: ≥70% ของยูนิตที่ getbuild โอนเปิดใช้ getproperty ภายใน 30 วัน, นิติฯ ที่เกิดจาก post-sale portal อยู่ต่อบน getproperty ≥80%, landlord freemium → paid 15%

## Integration contracts with getbuild & getpack

ทุกการสื่อสารข้าม platform เป็น event จาก **outbox → HTTP webhook** (product ที่อยู่บน box เดียวกัน — getpack และ getbuild ซึ่งตอนนี้เป็น Build modules ของ getpop) หรือ **SNS/SQS** (เมื่ออยู่คนละ box) ตาม locked decision ข้อ 4 ของ collective-infra (D-238; ไม่มี Pub/Sub ไม่มี Kafka) + REST callback ที่นิยามใน `collective-asset-core` (`packages/contracts`) ทั้งสองฝั่ง deserialize ด้วย schema เดียวกัน (zod) และบันทึกลง `integration_event` เพื่อ replay ได้ — การออกแบบ `integration_event` / `idempotency_key` ด้านล่างไม่เปลี่ยน; webhook ลงนาม HMAC ด้วย key ใน secret ของแต่ละ product

| Event | ทิศทาง | Payload หลัก | Trigger / ผลที่ getproperty |
| --- | --- | --- | --- |
| `building.handover.requested` | getbuild → getproperty | property, building, floors, units (ownership\_ratio), parties, unit\_ownership, defect history + warranty terms, as-built document refs, asset\_item list, developer tenant | Common-area handover ใน getbuild M1 → สร้าง building ใน post-sale portal (D1) |
| `unit.transferred` | getbuild → getproperty | unit, buyer party, transfer date, rental\_intent, warranty start | getbuild M7 ปิดเคสโอน → เพิ่ม ownership/occupancy; ถ้า rental\_intent เชิญเปิด landlord tier (D2) |
| `warranty.defect.reported` | getproperty → getbuild | service\_request, unit, photos, category | A4 รับแจ้งซ่อมในช่วงรับประกัน → เปิด defect ใน getbuild M1 ให้ Developer/ผู้รับเหมา |
| `warranty.defect.closed` | getbuild → getproperty | defect id, resolution, after photos | ปิด service\_request และแจ้งลูกบ้าน |
| `juristic.formed` | getproperty → getbuild | building, juristic tenant, date | D1 operator transfer → getbuild ปิด post-sale และคงเฉพาะ warranty grant |
| `procurement.rfq.requested` | getproperty → getpack | items (อะไหล่/วัสดุ), qty, spec, deliver-to building, needed-by | A4 parts หรือ B3 maintenance → getpack เปิด RFQ |
| `procurement.order.updated` | getpack → getproperty | RFQ/PO id, price, status, POD | บันทึกต้นทุนเข้า work order / asset\_item |
| `identity.party.linked` | ทั้งสองทาง | party id, line\_user\_id | ผู้ซื้อที่ login LINE ใน getbuild LIFF ใช้ identity เดียวใน getproperty |

**กติกา**: schema เปลี่ยนได้แบบ additive เท่านั้นภายใน major version; ทุก event มี `idempotency_key`; consumer ต้อง ack ภายใน 24 ชม. ไม่เช่นนั้น Collective admin เห็นใน admin back-office; ข้อมูล PII ใน payload เข้ารหัสด้วย key ร่วมของ Collective

## Technical architecture

สถาปัตยกรรมเดียวกับ getpack/getbuild (Next.js + NestJS modular monolith + PostgreSQL) บวกชั้น IoT ที่ getproperty เป็นเจ้าของ: MQTT edge → TimescaleDB → event เข้า workflow/billing ชั้น external ต่อผ่าน adapter ใน core เท่านั้น

| ชั้น | องค์ประกอบ | หมายเหตุ |
| --- | --- | --- |
| Clients | `getproperty-web` (Next.js: customer web + admin back-office), `getproperty-liff` (ผู้เช่า/ลูกบ้าน/ช่าง/landlord), Public API (getbuild, getpack, ระบบบัญชีลูกค้า) | LIFF แยก repo เพื่อ bundle เบา |
| API | `getproperty-api` NestJS: `core/*` (asset core, identity, billing engine, workflow, documents, notification), `modules/ops-*` (A), `modules/juristic-*` (B), `modules/smart-*` (C), `modules/bridge-*` (D), `ai/gateway`, `integrations/*` | Nest module boundary ชัดเพื่อแยกเป็น service ภายหลัง |
| Workers | BullMQ (บน Valkey ของ platform): billing run, notification, reading-to-bill, dunning timers, telemetry rollups; PDF ผ่าน queue `pdf-render` กลาง (D-236); Python (`getproperty-ai-workers`, **Phase 2**, รันบน EC2 "worker box" ของ platform ตั้งแต่ ~มี.ค. 2027): OCR มิเตอร์, STT, forecast, RAG indexing — Phase 1 OCR = vision-model API adapter ใน NestJS เท่านั้น (D-237) | ใช้ AI gateway ร่วม getbuild; inference ผ่าน external API (Claude / Gemini / Typhoon OCR) |
| IoT edge | `getproperty-edge`: gateway agent บน on-prem mini PC / industrial gateway ต่ออาคาร (Docker Compose หรือ systemd), protocol adapters (LoRaWAN NS, Modbus/TCP gateway, vendor cloud API สำหรับประตู/กล้อง), store & forward 30 วัน → MQTT over mTLS ไปที่ **EMQX กลางของ platform**; device registry และ TimescaleDB writer อยู่ใน ingest ของ `getproperty-api` | ทำงานได้เมื่อเน็ตล่ม (store & forward); ไม่ใช่ cloud infrastructure |
| Data | PostgreSQL 18 กลางบน box (`timescale/timescaledb-ha:pg18`: TimescaleDB + pgvector + pgBackRest) — database `getproperty` + role ของตัวเอง (D-233, D-234); pgvector (B2); S3 bucket ของ product สำหรับรูป/สัญญา/OTA; Valkey 8 (BullMQ/cache, logical DB ของ product) | ฐานเดียว แยก schema `core / ops / juristic / smart / bridge`; ไม่มี query ข้าม database |
| External | LINE Messaging/Login/LIFF, PromptPay (Bill Payment API ธนาคาร) + card gateway, e-Tax provider, LLM providers (Claude/Gemini), vendor APIs ของอุปกรณ์, Zoom/Meet (B1) | adapter pattern ทุกตัว |
| Shared packages | `collective-shared` (UI, auth, LINE, notification, billing types), `collective-asset-core` (schema + migrations + contracts — owned โดย repo นี้) | publish เป็น private npm package, version ตาม semver |

**Repos**

| Repo | สถานะ | หมายเหตุ |
| --- | --- | --- |
| `getproperty-web` | มีแล้ว (เริ่ม 16 ต.ค.) | เพิ่ม route group `(admin)` และ portfolio view สำหรับ PM/landlord ภายหลัง |
| `getproperty-api` | มีแล้ว | จัดโครง `core/` + `modules/ops-*` ตาม data model guideline |
| `getproperty-edge` | มีแล้ว | ขยาย device type: meter → door/camera/energy |
| `getproperty-liff` | ใหม่ | เริ่ม Phase 1 ด้วยหน้าบิล/จ่าย/แจ้งซ่อม |
| `getproperty-ai-workers` | ใหม่ (Phase 2) | Python; deploy บน EC2 worker box ของ platform (compose + SSM) ตั้งแต่ ~มี.ค. 2027 (D-237) |
| `collective-shared` | แยกจาก getpack | ทำครั้งเดียวใช้สามโปรเจกต์ |
| `collective-asset-core` | ใหม่ owned ที่นี่ | migrations อยู่ที่นี่ getbuild ติดตั้งเป็น dependency |

**Multi-tenancy & security**: `tenant_id` ทุกตาราง + RLS; `operator_tenant_id`/`owner_tenant_id` บน building + `asset_access_grant` สำหรับสิทธิ์ข้าม tenant; PII เข้ารหัสระดับคอลัมน์; signed URL อายุสั้น; audit log append-only 10 ปี; อุปกรณ์ IoT ใช้ per-device certificate (mTLS) + device JWT และ topic authorization ต่อ gateway ที่ getproperty-api ตัดสินผ่าน EMQX HTTP authz (D-235)

**Deployment, observability, backup**: ย้ายไปที่ส่วน *Infrastructure & operations (Collective platform)* ด้านล่าง — สรุปสั้น: getproperty รันบน shared Collective box (AWS `ap-southeast-7`, EC2 Graviton + docker compose ต่อ environment); edge box ต่ออาคารเป็น optional (Docker Compose บน mini PC, ไม่ใช่ cloud infrastructure); CI เรียก reusable workflows ของ collective-infra; environment `uat` / `prod`; device health dashboard (ออนไลน์/ค่าล่าสุด/แบตเตอรี่), AI cost ต่อ tenant และ billing run audit อยู่ใน product ตามเดิม

## Infrastructure & operations (Collective platform)

ทุกเรื่อง infrastructure, deployment และ operations ของ getproperty อยู่ใต้ **locked infrastructure decisions ของ Collective (2026-10-21)** ซึ่ง source of truth คือ repo `collective-infra` (`PLAN.md`, `README.md`, `platform/*`) — ส่วนนี้สรุปเท่าที่ getproperty ต้องรู้ แล้วบอกว่า getproperty ต้องการอะไรเพิ่มจาก platform (decision rows D-233–D-238 ใน `docs/decisions.md`; รายละเอียดการ deploy ใน `docs/deployment.md`)

### Locked decisions as they apply to getproperty (do not re-open)

| # | Decision (collective-infra, 2026-10-21) | getproperty |
| --- | --- | --- |
| 1 | AWS only, `ap-southeast-7` (Thailand); no GCP, Firebase or Singapore | ทุก environment ของ getproperty อยู่ใน `ap-southeast-7` |
| 2 | EC2 only, forever: one Graviton (arm64) box per environment running docker compose; scale = resize, then add boxes (worker box, DB box, GPU box); never RDS, ElastiCache, ECS/Fargate, EKS/Kubernetes, Cloud Run, Lambda for app logic, ArgoCD | compose project `getproperty` บน box ร่วมกับ getpack / getpop; trigger ที่ต้องแยก box อยู่ใน asks ด้านล่าง |
| 3 | Shared platform per box (compose project `platform`): Caddy, PostgreSQL 18 `timescale/timescaledb-ha:pg18` (TimescaleDB + pgvector + pgBackRest), Valkey 8, EMQX 5.8 (MQTT, mTLS per device), Grafana Alloy | ใช้ทั้งหมด; EMQX เป็น broker กลางของ platform (ไม่ใช่ broker ของ getproperty) |
| 4 | One database + one role per product; one S3 assets bucket, one Secrets Manager secret, one SES identity, one ECR repo per image, per product and per environment; no cross-database queries; cross-product = outbox → HTTP webhook (same box) or SNS/SQS (separate boxes); no Pub/Sub, no Kafka | database `getproperty`; bucket `collective-<env>-getproperty-assets`; secret `collective/<env>/getproperty/app`; ECR `getproperty/{api,web,liff}`; integration = outbox → webhook (D-238) |
| 5 | Environments `uat` (`t4g.large`, 08:00–20:00 Mon–Fri Asia/Bangkok) and `prod` (`t4g.xlarge` 24×7); no `dev` cloud environment (dev = local docker compose) | `pnpm dev` / `docker compose up -d` ในเครื่อง; UAT ปิดกลางคืน (งาน BullMQ ทุกตัว idempotent จึง catch up ตอนเปิด) |
| 6 | pgBackRest full (Sun) + diff (daily) + WAL archive (`archive_timeout` 300 s → RPO ≤ 5 min) to S3; daily EBS snapshot (DLM) with cross-region copy; monthly restore drill; RTO target 30 min; no managed failover (HA = streaming replica on a DB box if ever needed) | mapping ของ RPO/RTO/retention/PDPA อยู่ในตาราง *Data safety* ด้านล่าง |
| 7 | No SSH; SSM Session Manager / Run Command only; no long-lived IAM keys | instance role สำหรับ S3/SES/Secrets; gateways ไม่มี AWS credential ใด ๆ |
| 8 | GitHub Actions + OIDC → ECR (arm64) → SSM `platform/bin/deploy-product.sh <product> <tag>` (pull, migrate, up, healthcheck, auto-rollback); `main` → UAT; tag `v*.*.*` / manual promote → prod with approval; reusable workflows; no Terraform in product repos | api / web / liff deploy ด้วย `component`; migrate = service `migrate` ของ product compose (T-3) |
| 9 | OpenTelemetry + Prometheus `/metrics` + pino JSON logs → Alloy → Grafana Cloud Free; Sentry; CloudWatch only for host alarms and EC2 auto-recovery | ทุก process ของ getproperty ทำแล้ว (`docs/deployment.md` §2) |
| 10 | Secrets Manager `collective/<env>/<product>/app` (flat JSON), rendered at deploy time into the container env | ปัจจุบันใช้หลาย secret → T-4, T-6, O-013 |
| 11 | Image contract (arm64; API `/health` :3000 + `/metrics`; web `/api/healthz` :3000; worker health :3001; `npx prisma migrate deploy`; OTLP; S3 via instance role; DB pool ≤ 15 api / ≤ 10 worker) | ตาราง *Image contract* ด้านล่าง |
| 12 | One Chromium per box (getpack worker); others use the shared `pdf-render` BullMQ queue (HTML in → S3 key out) or an ADR + 1.5 GB | getproperty ใช้ `pdf-render` (D-236, T-1) |
| 13 | AI: external API inference only; Python workers on a separate EC2 worker box (from ~Mar 2027); self-hosted models only on a GPU box for batch jobs, not before 2028 and only with an ADR | `getproperty-ai-workers` = Phase 2 บน worker box; Phase 1 OCR = vision-model API adapter (D-237) |
| 14 | Memory budget on the 16 GB prod box: platform ≈ 6 GB, getpack 3.2 GB, getproperty ≈ 1.8 GB, getpop ≈ 1.5 GB (hard limits in compose) | budget line ด้านล่าง; ใช้เกินต้องบอก trigger ที่จะย้าย box |

Mapping ของ managed services เดิมใน blueprint: Cloud Run / GKE Autopilot → containers ใน compose บน EC2 box; Cloud SQL → PostgreSQL กลางบน box (database `getproperty`); GCS → S3 bucket ของ product; Memorystore / Redis → Valkey 8 (logical DB ของ product, `noeviction`); Pub/Sub → outbox → HTTP webhook หรือ SNS/SQS; GKE (EMQX) / Cloud IoT → EMQX กลางของ platform; Cloud Trace / Logging → OpenTelemetry + pino → Alloy → Grafana Cloud; Secret Manager → AWS Secrets Manager; "Terraform/CI" → reusable workflows ของ collective-infra (product repo ไม่มี Terraform)

### getproperty on the box — memory budget and image contract

**Memory budget line (prod, hard limits in `platform/products/getproperty/docker-compose.yml`)**: getproperty ≈ **1.8 GB** = `api` 512 MB · `worker` 512 MB (ไม่มี Chromium; PDF ผ่าน `pdf-render`) · `ingest` 192 MB · `web` 384 MB · `liff` 192 MB = **1,792 MB**. `migrate` (512 MB) เป็น one-shot ก่อน `up` จึงไม่นับใน steady state. สิ่งที่ branch `getproperty/r1-platform` ขอไว้วันนี้คือ ≈ **3.75 GB** (web 384 · liff 256 · api 640 · worker 1 G เพราะ Chromium · ingest 256 · ClamAV 1,280 · migrate 512) — ส่วนต่างปิดด้วย T-1 (Chromium → `pdf-render`), T-2 (ClamAV → shared platform service) และ T-11 (ลด limit + load test ใหม่). ถ้า T-1 ยังไม่เสร็จก่อน pilot go-live: worker 1.5 GB ตาม item 12 (getproperty รวม ≈ 2.8 GB) ต้องมี ADR และ trigger = เมื่อ `pdf-render` ใช้ได้ (O-015). Trigger ที่ getproperty ต้องย้ายออกจาก shared box: telemetry ตาม asks ด้านล่าง (O-014)

**Image contract (item 11)**

| Contract | getproperty วันนี้ | Status |
| --- | --- | --- |
| arm64 image | `getproperty/api` (คำสั่ง `main`, `worker`, `ingest`, `migrate`), `getproperty/web`, `getproperty/liff` — build ด้วย `reusable-build-push.yml` | ✓ |
| API `/health` :3000 + `/metrics` | `node dist/src/main.js`; `/metrics` ตอบเฉพาะ docker network | ✓ |
| web `/api/healthz` :3000 | web ✓, liff ✓ (ทั้งคู่มี `/api/metrics`) | ✓ |
| worker health :3001 | `worker.js` `/health` + `/metrics` :3001 | ✓ |
| (ingest — ไม่อยู่ใน contract) | `ingest.js` :3001 ใน container ของตัวเอง (`INGEST_HEALTH_PORT=3001`) | ✓ (T-10) |
| migrations = `npx prisma migrate deploy` | `node dist/src/migrate.js` (asset-core `core` ก่อน, แล้ว `prisma/migrations` บันทึกใน `_prisma_migrations` แบบเดียวกับ Prisma, แล้ว TimescaleDB step, แล้ว reference seed); image ไม่มี Prisma CLI | gap → T-3 |
| OTLP to `$OTEL_EXPORTER_OTLP_ENDPOINT` | ทุก process | ✓ |
| S3 via instance role (no keys) | ✓ (`AWS_SECRETS_ID` ว่าง); แต่ provider credentials ต่อ merchant อ่านจาก Secrets Manager ตอน run time | ✓ (provider credentials ใน PostgreSQL — D-240) |
| `DATABASE_URL`, pool ≤ 15 (api) / ≤ 10 (worker) | pg adapter `max: 10` ต่อ process (api, worker, ingest) → `DATABASE_POOL_MAX` ต่อ process (api 10 ≤ 15, worker 10 ≤ 10, ingest 5) | ✓ (T-5) |

### Data safety — requirements mapped onto the platform (no downgrade)

| Requirement ของ getproperty | เดิม | กลไกบน platform | ผล |
| --- | --- | --- | --- |
| RPO | backup รายวัน + PITR 7 วัน (blueprint เดิม) | pgBackRest WAL archive (`archive_timeout` 300 s) → S3 + full (Sun) / diff (daily) | **RPO ≤ 5 นาที**; PITR window 35 วัน (≥ 7 วันเดิม) |
| ค่ามิเตอร์ใน ≤ 5 นาทีที่อาจหาย | — | บิลมาจาก cumulative register เท่านั้น (D-030): reading ถัดไปคืนยอดสะสมครบ; ขณะ broker/API ล่ม gateway เก็บ store-and-forward 30 วัน | ไม่กระทบบิล |
| RTO | 4 ชม. (RUNBOOK §9 เดิม) | pgBackRest restore (หรือ EBS snapshot) + EC2 auto-recovery; **restore drill รายเดือน** พร้อม smoke test ของ getproperty และจับเวลา | **target 30 นาที** (platform); 4 ชม. คงเป็นเพดานที่ยอมรับได้ |
| HA | — | ไม่มี managed failover; streaming replica บน DB box ถ้าจำเป็นในอนาคต | ยอมรับตาม locked decision 6 |
| Audit log immutable 10 ปี | `platform.audit_log` append-only | อยู่ใน PostgreSQL ตามเดิม; backup (35 วัน) เป็นสำเนากู้คืน ไม่ใช่ที่เก็บ 10 ปี | ไม่เปลี่ยน |
| Retention เอกสาร / ข้อมูล | `platform.retention_policy` ต่อ class | app retention job ลบตาม class; S3 versioning (noncurrent 30 วัน) | ไม่เปลี่ยน |
| Retention telemetry | raw 24 เดือน, health 6 เดือน, rollups 5 ปี, dedup 90 วัน | TimescaleDB retention policy (hypertable, prod) / partition drop (baseline) — D-234 | ไม่เปลี่ยน |
| PDPA: ลบ/ทำให้ไม่ระบุตัวตน (DSR) | anonymise + crypto-shred tenant key | DB anonymise + destroy tenant DEK; สำเนาใน pgBackRest (≤ 35 วัน) และ EBS snapshot (7 วัน + cross-region copy) หมดอายุเอง; หลัง restore ใด ๆ ต้อง re-apply DSR ที่ทำหลังจุด restore (RUNBOOK §9) | ลบครบทุกสำเนาภายใน ≤ 35 วัน |
| PDPA: ที่ตั้งข้อมูล | ประเทศไทย | primary ใน `ap-southeast-7`; DLM cross-region copy ไป `ap-northeast-1` (Tokyo) 7 วัน, encrypted | ฐาน ม.28 (+ ม.29) — D-243, `docs/compliance/cross-border-backups.md` ⚖ |
| Access | — | ไม่มี SSH; SSM เท่านั้น; ไม่มี long-lived key | ไม่เปลี่ยน |

### IoT on the shared broker — the contract the platform needs from getproperty-api

EMQX เป็น broker กลางของ platform; getproperty-api เป็นผู้ออกและต่ออายุ certificate ของ gateway (D-130, D-165, edge CR-003) และเป็นผู้ตัดสิน authn/authz ของ gateway ผ่าน HTTP (D-235):

- **Ports**: **8883** public, MQTT 5 over TLS 1.2+ with mutual TLS (`verify_peer`, `fail_if_no_peer_cert`) against the device CA chain; **1883** internal only (docker network: getproperty api / worker / ingest with a password user); **8083** ws behind Caddy only (browser MQTT of the platform host — getproperty R1 does not use it; the gateways' WSS fallback stays O-012). Gateways need exactly two egress destinations: `DEVICE_HOST:443` (HTTPS, Caddy `client_auth`) and `MQTT_HOST:8883`.
- **Device CA**: Secrets Manager **`collective/<env>/platform/device-ca`** (platform-owned): CA chain for EMQX's 8883 listener and Caddy's `DEVICE_HOST`; the issuing certificate + key that getproperty-api uses to sign gateway CSRs (`POST /v1/device/bootstrap`, `/v1/device/certificate/renew`); the broker server certificate for `MQTT_HOST` issued from the same CA (gateways trust only the `caChainPem` of their bootstrap). Renewal: broker certificate 397 days, gateway certificates 12 months (agent renews at 11 months).
- **HTTP authentication** (EMQX `authentication` = HTTP, on the device listener): `POST http://getproperty-api:3000/internal/emqx/authn` (docker network only, never routed by Caddy, shared header secret) with `${clientid}`, `${username}`, `${password}`, `${cert_common_name}`, `${cert_subject}`, `${peerhost}` → `{"result":"allow","is_superuser":false}` only when the certificate CN is `gw-<gatewayId>` of a provisioned, non-retired gateway, `username` = CN (= `clientid`), and `password` is a valid **device JWT** of that gateway (`aud=device`, `sub=<gatewayId>`, unexpired, ≤ 1 h — `DEVICE_ACCESS_TOKEN_TTL_SECONDS`; issued by `POST /v1/device/token` over mTLS only to a non-retired gateway, so a retired gateway cannot reconnect with a still-valid certificate even though EMQX does not pass the certificate fingerprint); `deny` for any other `gw-*`; `ignore` for usernames that are not `gw-*` (other products' clients fall through to their own authenticator).
- **HTTP authorization**: `POST http://getproperty-api:3000/internal/emqx/authz` with `${username}`, `${clientid}`, `${topic}`, `${action}`, `${qos}`, `${retain}` → for `gw-<id>`: **publish** `gp/v1/<id>/telemetry`, `gp/v1/<id>/health` (also the LWT), `gp/v1/<id>/events`, `gp/v1/<id>/cmd/ack` (QoS ≤ 1, retain false); **subscribe** `gp/v1/<id>/config` (retained) and `gp/v1/<id>/cmd`; everything else under `gp/v1/#` = `deny`; for the internal service user (`MQTT_USERNAME`, 1883): `gp/v1/+/#` and `$share/ingest/gp/v1/+/#`; `ignore` for other users/topics; platform `no_match = deny`, `deny_action = disconnect`; authz cache TTL ≤ 1 min (a retired gateway loses its topics within a minute and its session at once through the API's kick).
- **Namespace**: `gp/v1/#` is reserved for getproperty on the shared broker.

**Topics in `docs/contract/device-protocol.md` vs. the contract vs. branch `getproperty/r1-platform`**

| | device-protocol.md (D-130, protocol 1.1) | Contract above | Branch today | Difference → task |
| --- | --- | --- | --- | --- |
| Topics | `telemetry`, `health` (+LWT), `events`, `config` (retained, cloud → gw), `cmd`, `cmd/ack` under `gp/v1/<gatewayId>/` | same set | same set | none |
| Authentication | client certificate only ("broker credentials are the certificate") | CN `gw-<gatewayId>` **+ device JWT as password** via HTTP authn | `enable_authn = false`, `peer_cert_as_username = cn` | protocol 1.2 (additive: JWT as MQTT password) → T-8; HTTP authn endpoint → T-7 |
| Authorization source | `smart.mqtt_acl` read by EMQX | HTTP authz endpoint in getproperty-api | EMQX PostgreSQL source on `smart.mqtt_acl` (login `getproperty_mqtt`, role `gp_mqtt`) + file ACL for `getproperty-api` | replace PostgreSQL source → T-7 |
| Publish scope | `gp/v1/<id>/+` and `…/cmd/ack` (`+` also matches `config` / `cmd`) | 4 explicit topics | as protocol | tighten → T-9 |
| Device CA | `caChainPem` at bootstrap | `collective/<env>/platform/device-ca` | `collective/<env>/getproperty/mqtt-tls` + `DEVICE_CA_CERT` / `DEVICE_CA_KEY` in the app secret | move → T-6 |
| Listener ownership | — | shared broker; getproperty zone `devices` on 8883 | the platform's only 8883 listener rewritten for getproperty | document as shared listener + namespace → T-7 |
| WSS 443 fallback | offered "when the platform enables it" | 8083 ws behind Caddy (no client certificate) | per gateway, device JWT only (D-239) | done |

### Infrastructure asks from collective-infra (quantified)

**Assumptions** (state, do not hide): 15-min polling (D-131) = 96 readings/meter/day; ≤ 300 meters per RS485 bus = per gateway (device protocol §4, the pilot building = one full bus, D-207 load target 300 meters / 300 units); health every 60 s per gateway = 1,440 samples/day; IoT promotion 1 billing reading per meter per 60 min (`readings.iot_promotion_minutes`); KPI targets from *Roadmap & release plan*: IoT devices 1 building → 500 (end Phase 2) → 10,000 (end Phase 4), buildings 1 → 20 → 300, units 80–300 → 3,000 → 60,000. Bytes are estimates from the real DDL (`prisma/migrations/0016`, `0017`, `0036`), ±30%: `smart.telemetry_point` ≈ 400 B/row incl. its 4 indexes (heap ≈ 230 B with a 3-field `extra`); `smart.telemetry_15m` ≈ 280 B/row (one row per raw point at 15-min polling), `_1h` ≈ 70 B and `_1d` ≈ 3 B per raw point; `smart.meter_reading` ≈ 500 B/row; `smart.ingest_seq_mark` ≈ 270 B/row (90 days); `smart.device_health_sample` ≈ 150 B + ≈ 60 B per meter in the stored `meters[]` array. **Compression ratio 10:1** for TimescaleDB native compression of `smart.telemetry_point` after 30 days (segment by `asset_item_id`, order by `time DESC`: the five uuids become one value per segment, `time`/`seq` delta-encoded; vendor-typical is 10–20:1 — 10:1 is the conservative planning value, UNVERIFIED until measured on UAT). Phase dates: Phase 1 now–Feb 2027 (blueprint); the roadmap graphic is not in the text, so for dates below Phase 2 = Mar–Aug 2027, Phase 3 = Sep–Dec 2027, Phase 4 = Jan–Apr 2028 (assumption).

| KPI | Pilot (Phase 1, ≤ Feb 2027) | End Phase 2 (≈ Aug 2027) | End Phase 4 (≈ Apr 2028) | Bus ceiling (information only) |
| --- | --- | --- | --- | --- |
| Buildings / meters / gateways | 1 / 300 / 1 | 20 / ≈ 480 / 20 (500 devices) | 300 / ≈ 9,700 / 300 (10,000 devices) | 500 / 150,000 / 500 (every building a full bus) |
| Telemetry rows/day (`telemetry_point`) | 28,800 | 46,080 | 931,200 | 14,400,000 |
| Health samples/day | 1,440 | 28,800 | 432,000 | 720,000 |
| Billing readings/day (`meter_reading`) | 7,200 | 11,520 | 232,800 | 3,600,000 |
| Raw telemetry GB/year, uncompressed | 4.2 | 6.7 | 136 | 2,102 |
| Raw telemetry GB/year, compressed after 30 days | 0.7 | 1.2 | 24 | 366 |
| All IoT tables on disk after 1 year — as built today | 14.7 GB | 24.2 GB | 485 GB | 7.3 TB |
| — after T-12, T-13, T-14 | 4.1 GB | 7.2 GB | 142 GB | 2.0 TB |
| — after 2 years (as built / after tasks) | 23.9 / 6.9 GB | 39.0 / 11.7 GB | 784 / 232 GB | — |
| WAL/day → backups bucket (≈ 2× written bytes) | ≈ 0.1 GB | ≈ 0.2 GB | ≈ 2.5 GB | — |
| MQTT msgs/s, average (health + telemetry batches ≤ 200 readings) | 0.02 | 0.36 | 5.3 | 9.4 |
| MQTT msgs/s, burst (fleet reconnect + 1 h store-and-forward replay within ~60 s) | ≈ 1 | ≈ 5 | ≈ 50 | — |
| MQTT connections (gateways + 3 internal) | 4 | 23 | 303 | 503 |
| Largest MQTT message | 200 readings ≈ 50 KB | same | same | same |
| API requests/min, average / bill-day peak | ≈ 20 / 100 | ≈ 100 / 400 | ≈ 1,000 / 3,000 | — |
| S3 growth (≈ 1 MB per unit-month: PDFs, slips, photos) | ≈ 0.3 GB/month | ≈ 3 GB/month | ≈ 60 GB/month | — |

How the asks follow from it (phase/date when each is needed):

| # | Ask | Quantity | Needed by |
| --- | --- | --- | --- |
| A-1 | Database `getproperty` + roles in the shared PostgreSQL; extensions `timescaledb`, `pgcrypto`, `citext`, `btree_gist`, `pg_trgm` (+ `vector` for B2); TimescaleDB background workers on (retention + compression policies) | ≤ 35 connections (api 10, worker 10, ingest 10, migrate, + Python workers 5 from Phase 2) | first UAT deploy (Phase 1) |
| A-2 | Data volume `/data` growth **120 → 250 GB** on prod | getproperty IoT ≈ 7–24 GB/year at the end of Phase 2, ≈ 100 GB/year at ~2,000 devices (as built) | **2027-09-01** (start of Phase 3 under the date assumption) or when `/data` > 70 %, whichever first |
| A-3 | Trigger for a separate **DB box** (or getproperty's own box) — locked decision 2 | 10,000 devices ≈ 142 GB in year 1 and ≈ 232 GB in year 2 even after T-12–T-14 > getproperty's share of 250 GB | decide at gate 3 (≈ Dec 2027) — O-014 |
| A-4 | EMQX on the shared broker: 8883 mTLS public with the device CA, 1883 internal, 8083 ws behind Caddy; HTTP authn + authz to getproperty-api (contract above); namespace `gp/v1/#`; max packet ≥ 256 KB; sustain 10 msgs/s, burst 50 msgs/s; ≥ 500 connections; connect-rate burst 300/min; retained messages ≤ 1 per gateway | see table | authn/authz endpoints: before pilot go-live (T-7); capacity: Phase 4 |
| A-5 | Secret `collective/<env>/platform/device-ca` (+ read for getproperty's api, rendered into its env) | 1 secret | before pilot go-live (T-6) |
| A-6 | S3: the product bucket with prefixes `t/<tenantId>/<kind>/<yyyy-mm>/<id>` (tenant files), `p/<kind>/<yyyy>/<mm>/<id>` (platform documents), `releases/edge/<version>/<file>` (OTA — instance role read-only, `…-release-publisher` policy for the release engineer, D-231); versioning + noncurrent 30 days; CORS for presigned PUT from the owner / staff / admin / LIFF hosts. No extra bucket in R1 | S3 growth row above; OTA ≈ 50 MB per version × arch | Pilot (already on the branch) |
| A-7 | Caddy hosts: `OWNER_HOST`, `STAFF_HOST`, `ADMIN_HOST`, `LIFF_HOST`, `API_HOST`, `DEVICE_HOST` (`client_auth verify_if_given` with the device CA, forwards only the certificate SHA-256, OTA route `read_timeout 10m`), `MQTT_HOST` (DNS for 8883 + health) | 7 hosts per env | Pilot |
| A-8 | Shared `pdf-render` BullMQ queue (getpack worker) usable by getproperty: Thai fonts, A4 and 80 mm thermal paper, title/footer, output to getproperty's bucket key or bytes back | pilot ≈ 600 PDFs/month (300 invoices + 300 receipts), Phase 4 ≈ 120,000/month, peak at cut-off ≈ 300 in 60 s | before pilot go-live (T-1, O-015) |
| A-9 | ClamAV as a **shared platform service** (counts in the platform ≈ 6 GB) instead of getproperty's 1.25 GB container | ≈ 1 scan per upload (slips, photos, ID documents): pilot ≈ 1,000/month | before pilot go-live (T-2) |
| A-10 | Valkey: logical DB for getproperty, `noeviction`, persistence on (BullMQ repeatables) | ≤ 128 MB pilot, ≤ 256 MB Phase 4 | Pilot |
| A-11 | Cron / scheduled jobs: **none on the host** — every recurring job is a BullMQ repeatable in the `worker` container (`outbox-relay` 1 s, `billing-cycles` 15 min, `telemetry-rollup` 1 min, `telemetry-partitions` 1 d, `gateway-health` / `meter-health` / `config-drift` / `device-commands` 1–5 min, `receivables` 1 h, `platform-subscriptions` 1 h, `payment-settlement` 1 d, `etax-submissions` 1 min, `etax-monthly` 1 h, `tm30-sweep` 1 h, `analytics-rollup` 1 h, `analytics-benchmarks` 1 d, `retention`, `support-grants-expire`, `lease-lifecycle`, `notifications-release`, `workflow-timer-sweep`, `compliance-score`; RUNBOOK §5). Platform asks: the monthly restore drill runs getproperty's smoke tests (T-15) | — | Pilot |
| A-12 | Worker box (locked decision 13) for `getproperty-ai-workers` (meter-photo OCR at scale, STT for B1 AGM, B3 forecasting, B2 RAG indexing): Python containers, compose + SSM like the main box, reach the main box's PostgreSQL / Valkey over the private subnet | ≈ 1.5 GB RAM, ≤ 1 vCPU average, PostgreSQL pool ≤ 5, no GPU | Phase 2 (from ~Mar 2027; RAG/STT with group B in Phase 3) |
| A-13 | pgvector for B2 (in the shared PostgreSQL) | ≈ 15–35 MB per condo building (≈ 2,000 chunks × 1,536-dim + HNSW) → ≤ 4 GB at 120 condos | Phase 3 |
| A-14 | GPU box | none — STT / OCR / LLM via external APIs; any self-hosted model needs an ADR and is not before 2028 | — |
| A-15 | SES identity for the product domain | pilot < 1,000 emails/month (OTP is SMS) | Pilot |
| A-16 | Cross-product events: webhooks between products on the same box (internal docker network, HMAC); SNS/SQS only when a partner product runs on another box | getbuild/getpop and getpack integrations ≈ tens of events/day per building | Phase 2 (D1 handover) |

### Gap tasks (owner repo)

| # | Gap | Task | Owner | When | Status (2026-10-22) |
| --- | --- | --- | --- | --- | --- |
| T-1 | Worker runs its own Chromium (item 12) | `PDF_RENDERER_MODE=queue` adapter on the shared `pdf-render` queue (D-236); then remove Chromium from the api image and `shm_size` from the worker; if the queue is not ready for go-live: ADR-0012 + worker 1.5 GB until it is | getproperty-api + collective-infra/getpack-api (queue contract) | before pilot go-live | **Partly done** — getproperty-api: contract `docs/pdf-render-queue.md`, producer `PDF_RENDERER_MODE=queue`, ADR-0012 interim (own Chromium, worker 1.5 GB, D-242); open: getpack's consumer, then switch + remove Chromium |
| T-2 | ClamAV 1.25 GB in getproperty's compose, over budget | shared platform `clamav` service on the `collective` network; getproperty keeps `CLAMAV_HOST` | collective-infra | before pilot go-live | Done in collective-infra (shared `platform-clamav-1`) |
| T-3 | Contract says `npx prisma migrate deploy`; getproperty must run `node dist/src/migrate.js` (asset-core `core` first, no Prisma CLI in the image) | ADR in getproperty-api justifying the command (equivalent records in `_prisma_migrations`); collective-infra README wording: "the product compose's `migrate` service" (what `deploy-product.sh` already runs); asset-core release with `GRANT CREATE ON SCHEMA core TO gp_platform` for non-superuser runners | getproperty-api (ADR) · collective-infra (wording) · collective-asset-core | before pilot go-live | **Done** — ADR-0013; asset-core 0.4.0 runner grants/revokes itself, workaround removed; collective-infra wording updated |
| T-4 | Several secrets (`app`, `web`, `liff`, `mqtt-tls`) vs "one secret per product per env" | one `collective/<env>/getproperty/app`: component keys prefixed `WEB__…` / `LIFF__…`, split by `fetch-secrets.sh` into the front ends' env files so a front end still never receives the API's secrets; `mqtt-tls` → T-6; `getproperty_mqtt_password` in `platform/postgres` retired by T-7 | collective-infra (branch) + getproperty-api `docs/deployment.md` | before pilot go-live | Done in collective-infra (`WEB__` / `LIFF__` / `MQTT_TLS__` prefixes); `docs/deployment.md` §3 updated |
| T-5 | Pool sizes not configurable; URL carries an ignored `connection_limit` | env `DATABASE_POOL_MAX` (api ≤ 15, worker ≤ 10, ingest 5); drop `?connection_limit` from the documented URL | getproperty-api | Phase 1 | **Done** — `DATABASE_POOL_MAX` per process (api 10 ≤ 15, worker 10 ≤ 10, ingest 5 ≤ 5) |
| T-6 | Device CA in the product secret | read the CA chain / issuing key / broker certificate from `collective/<env>/platform/device-ca`; `pnpm device:broker-cert` writes there; EMQX and Caddy read it from there | collective-infra + getproperty-api | before pilot go-live | **Done** — `DEVICE_CA_CHAIN`/`_CERT`/`_KEY` from `platform/device-ca` (D-245); `pnpm device:broker-cert` writes the secret JSON |
| T-7 | EMQX authorises gateways from PostgreSQL (`smart.mqtt_acl`, `gp_mqtt`) | `POST /internal/emqx/authn` + `/internal/emqx/authz` in getproperty-api (internal only, header secret, `smart.mqtt_acl` stays the API's source of truth); EMQX HTTP authn/authz config; remove the PostgreSQL source, `getproperty_mqtt` login and the file ACL entry | getproperty-api + collective-infra | before pilot go-live | **Done** — `/internal/emqx/authn|authz` (D-244), migration 0037 retires the PostgreSQL ACL path; EMQX config in collective-infra |
| T-8 | Device JWT not sent on MQTT | device protocol 1.2 (additive): agent fetches a token before every (re)connect and sends it as the MQTT password; platform setting `mqtt.authn.require_device_jwt` off until the fleet runs 1.2, then on | getproperty-api (contract) + getproperty-edge | before pilot go-live | **API done** — protocol 1.2, `mqtt.authn.require_device_jwt` on by default; open: getproperty-edge (CR in F11) |
| T-9 | Publish ACL `gp/v1/<id>/+` also covers `config` / `cmd` | authz endpoint allows only the 4 publish topics; device-protocol §1 updated | getproperty-api | with T-7 | **Done** — four explicit publish topics (0037 + bootstrap) |
| T-10 | Ingest health on :3002 is outside the contract | ingest listens on :3001 in its own container (`INGEST_HEALTH_PORT=3001`, compose only) or the contract lists `ingest` :3002 | collective-infra (branch compose) + getproperty-api docs | before pilot go-live | Done (collective-infra: `INGEST_HEALTH_PORT=3001`; image default stays 3002 for local dev, D-246) |
| T-11 | Branch compose limits ≈ 3.75 GB | limits of the budget line (1,792 MB) after T-1/T-2; re-run the 300-meter / 300-unit load test under them | collective-infra (branch) + getproperty-api | before pilot go-live | Limits set in collective-infra; open: load test under the limits on UAT |
| T-12 | Compression after 30 days is blocked: `smart.telemetry_point` carries row-level security, which TimescaleDB compression does not support together (as noted in `prisma/optional/timescale/001_telemetry_hypertables.sql`; UNVERIFIED on a live TimescaleDB) | optional migration step 2: `smart.telemetry_point` becomes platform-only (no RLS; `gp_app` gets no grant — the API never reads raw points, D-184; ingest and the rollup worker run as `gp_platform`), compression `segmentby asset_item_id`, `orderby time DESC`, policy 30 days; `TIMESCALEDB_MIGRATION=on` in prod (UNVERIFIED until UAT) | getproperty-api | before 500 devices (Phase 2) | **Done (UNVERIFIED on live TimescaleDB)** — optional step 2 `002_telemetry_compression.sql`, raw platform-only (ADR-0014) |
| T-13 | Health samples store the full `meters[]` every 60 s (≈ 18 KB per sample at 300 meters ≈ 26 MB/day per gateway) | keep `meters[]` only in `smart.device_health_latest` / meter status, store per-meter changes as events; sample row ≈ 150 B | getproperty-api | Phase 2 | **Done** — `meters[]` dropped from samples, `meter_status_changed` events (0039) |
| T-14 | At 15-min polling `telemetry_15m` holds one row per raw point for 5 years (≈ 120 GB/year at 10,000 devices) | rollups as compressed hypertables with a tenant-safe read path (ADR: the API reads rollups under RLS; continuous aggregates cannot carry RLS), or shorter 15m retention — O-014 | getproperty-api | Phase 3 | **Done** — `telemetry_15m` dropped, tenant-checked `smart.telemetry_15m_series()` over raw points, 1h/1d RLS rollups (ADR-0014, D-241) |
| T-15 | Restore drill does not exercise getproperty | product hook for `restore-drill.sh` (owner login, cycle preview, RTO measured against 30 min); re-apply DSR erasures after a restore | collective-infra + getproperty-api RUNBOOK | before pilot go-live | **Done** — `node dist/src/drill-smoke.js` (D-248); hook + RTO in collective-infra |
| T-16 | Cross-product transport not built | outbox → HTTP webhook subscriber + `/webhooks/integration/<platform>` receiver with HMAC; SNS/SQS adapter only when a partner is on another box | getproperty-api + collective-asset-core (contracts) | Phase 2 (D1) | **Done** — `integration-delivery` job + webhook transport, SNS stub, `/webhooks/integration/{platform}` (D-247; asset-core 0.4.0 signing) |
| T-17 | collective-infra `PLAN.md` / README still say EMQX "TLS 8883 via Caddy-issued cert", "Migration = `npx prisma migrate deploy`" and getproperty "web 512 · api 512 · worker 768" | update with the device-CA listener, the migrate service and getproperty's five-container budget line | collective-infra | with the branch merge | Done in collective-infra |

## Pricing & packaging

คิดต่อยูนิตต่อเดือนเป็นหลัก (หน่วยที่ทุกอาคารนับอยู่แล้ว) บวก hardware IoT และ add-on ต่อ module; ผู้เช่า ลูกบ้าน ช่าง และกรรมการใช้ฟรีไม่จำกัดเพื่อให้ network effect เกิด

| Tenant type | แพ็กเกจ | หน่วยคิดเงิน | ราคาเริ่มต้น (ประมาณ) | รวมอะไร |
| --- | --- | --- | --- | --- |
| Apartment | Starter | ต่อยูนิต/เดือน (ขั้นต่ำ 20 ยูนิต) | 25 บาท/ยูนิต | A1, A2, A4, LIFF ผู้เช่า, PromptPay |
| Apartment | Smart | ต่อยูนิต/เดือน + hardware | 40 บาท/ยูนิต + มิเตอร์ \~1,500–2,500 บาท/จุด (ขายขาดหรือเช่า 60 บาท/เดือน) | + A3 smart meter, C2 ส่วนกลาง |
| Condo juristic | Juristic | ต่อยูนิต/เดือน (ขั้นต่ำ 100 ยูนิต) | 15 / 12 / 10 บาท/ยูนิต (ขั้นบันได) | A1–A4 + B2 resident bot |
| Condo juristic | Juristic Pro | ต่อยูนิต/เดือน + ต่ออาคาร/ปี | 20 บาท/ยูนิต + B1 6,000–15,000 บาท/ปี (1 AGM + 1 EGM) | + B1, B2 เต็ม, B3 |
| Condo / Apartment | Access add-on | ต่ออาคาร/เดือน + hardware | 3,000–8,000 บาท/เดือน | C1 |
| PM company | Portfolio | สัญญารายปี ตามจำนวนอาคาร/ยูนิตรวม | เริ่ม 50,000 บาท/เดือน สำหรับ 10 อาคาร; volume tier ลด 25–35% | C3 + ทุก module ของอาคารที่บริหาร |
| Developer (post-sale) | รวมใน getbuild Developer Handover | ต่อยูนิต | ฟรี 12 เดือนแรก แล้วเปลี่ยนเป็นแพ็กเกจของนิติฯ | D1 |
| Landlord | Free / Plus | ต่อ landlord/เดือน | ฟรี ≤3 ยูนิต; 99 บาท ≤10 ยูนิต; 299 บาท ≤20 ยูนิต | D2 + A1/A2/A4 ของยูนิตตน |
| ทุกชนิด | Inspection report | ต่อรายงาน | 3,000–5,000 บาท | B3 statutory inspection (ขายผู้ตรวจสอบอาคารเป็น channel) |

**AI usage**: B2 Q&A และ bot รวมในแพ็กเกจ; OCR มิเตอร์จากรูปรวม 500 รูป/เดือน เกินคิด 0.5 บาท/รูป; STT ประชุมรวมใน B1

**เป้าหมายรายได้ปีที่ 2** (สมมติฐานให้ตรวจ): อพาร์ตเม้นต์ 150 แห่ง × 80 ยูนิต × 30 บาท + คอนโด 120 อาคาร × 300 ยูนิต × 14 บาท + PM company 5 ราย × 60,000 บาท + landlord paid 1,500 ราย × 150 บาท ≈ 1.4 ล้านบาท/เดือน (MRR) ≈ 17 ล้านบาท/ปี ไม่รวม hardware (ประมาณ 10–15 ล้านบาท/ปี margin 25–35%) และรายได้ที่ไหลไป getbuild/getpack; AI cost ต่อรายได้ <8%

**Billing mechanics**: ใบกำกับภาษีในนาม Collective Group (Thailand); รอบรายเดือน/รายปี (ลด 15%); จำนวนยูนิตนับอัตโนมัติจาก `unit` ที่ active; hardware ออกใบแจ้งหนี้แยกผ่าน getpack order flow

## Compliance

ระบบแตะกฎหมาย 7 กลุ่ม ข้อกำหนดเชิงตัวเลขเก็บเป็น config ที่ version ได้ และตารางด้านล่างต้องให้ทนายอาคารชุดทบทวนก่อน GA ของกลุ่ม B

| กฎหมาย / มาตรฐาน | กระทบ | ข้อกำหนดที่ต้องบังคับในระบบ | สถานะ |
| --- | --- | --- | --- |
| PDPA (พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล 2562) | ทุก module โดยเฉพาะ A1, C1 | consent/privacy notice ตอน LINE Login; ฐานการประมวลผล; เข้ารหัสเลขบัตร; retention ของ log เข้าออกและภาพกล้อง; สิทธิ์เจ้าของข้อมูล; DPA กับเจ้าของอาคาร/นิติฯ (ผู้ควบคุม) โดย Collective เป็นผู้ประมวลผล; ป้ายแจ้งกล้อง | ก่อน Phase 1 ส่งมอบ |
| กฎหมายโรงแรม/หอพัก และ ตม.30 | A1 (apartment, landlord) | หอพักตาม พ.ร.บ.หอพัก 2558 (ทะเบียนผู้พัก); การแจ้งที่พักคนต่างด้าวภายใน 24 ชม. (ตม.30) — ระบบเตรียมข้อมูล/ไฟล์สำหรับยื่น | Phase 1: export ตม.30 |
| ประมวลกฎหมายแพ่งว่าด้วยเช่าทรัพย์ และประกาศ สคบ. ธุรกิจให้เช่าอาคารเพื่ออยู่อาศัยเป็นธุรกิจควบคุมสัญญา (2562) | A1, A2, D2 | ผู้ให้เช่า ≥5 ยูนิต: ข้อสัญญาต้องห้าม, คืนมัดจำใน 7 วัน, อัตราค่าน้ำ-ไฟห้ามเกินที่กำหนด/ตามจริง, แจ้งล่วงหน้า 30 วัน — เทมเพลตสัญญาและ rate plan ต้องสอดคล้อง | เทมเพลตให้ทนายทบทวน |
| พ.ร.บ.อาคารชุด 2522 และที่แก้ไข | A2, B1, B2 | องค์ประชุม สัดส่วนมติ ระยะเวลาหนังสือเชิญ มอบฉันทะ สิทธิ์ของผู้ค้างชำระ เงินเพิ่ม หน้าที่ผู้จัดการ | ตารางกฎให้ทนายทบทวน |
| พ.ร.ก.การประชุมผ่านสื่ออิเล็กทรอนิกส์ 2563 | B1 | ยืนยันตัวตน, บันทึกเสียง/ภาพ, ข้อมูลจราจร, ลงคะแนนตรวจสอบได้ | ออกแบบ hybrid ให้ผ่านตั้งแต่ต้น |
| พ.ร.บ.ควบคุมอาคาร และกฎกระทรวงตรวจสอบอาคาร | B3 | ประเภทอาคารที่ต้องตรวจ, รอบตรวจ, 4 หัวข้อ, คุณสมบัติผู้ตรวจ, รูปแบบรายงาน | ตรวจกับกรมโยธาฯ |
| มาตรฐานมิเตอร์และการขายไฟฟ้า/น้ำต่อ | A3 | ผู้ให้เช่าเก็บค่าไฟ-น้ำได้ไม่เกินอัตราที่ สคบ. กำหนด; มิเตอร์ย่อยที่ใช้คิดเงินควรผ่านการรับรอง (สมอ./ชั่งตวงวัด) | ระบุในสเปก hardware |
| ภาษี: e-Tax Invoice, ภาษีเงินได้จากค่าเช่า (40(5)), ภาษีที่ดินและสิ่งปลูกสร้าง | A2, D2 | ใบกำกับภาษีอิเล็กทรอนิกส์; รายงานรายได้ค่าเช่าต่อปี; ประเภทการใช้ที่ดินกระทบอัตราภาษี | reuse e-Tax จาก getpack |
| พ.ร.บ.ธุรกรรมทางอิเล็กทรอนิกส์ / e-Signature | A1, B1, D2 | สัญญาเช่าและรายงานประชุมที่ลงนามอิเล็กทรอนิกส์: ตัวตน เวลา hash เจตนา | ลายมือชื่อทั่วไป + audit trail ก่อน, CA ภายหลัง |

**หลักการ**: AI ไม่ตัดสินใจขั้นสุดท้ายในเรื่องที่กฎหมายกำหนด (ตัดสิทธิ์, ผลคะแนน, ค่าปรับ); ทุกการตัดสินใจเหล่านั้นสืบย้อนได้จาก `audit_log` + เอกสาร PDF ที่ hash; ค่าตัวเลขตามกฎหมาย (สัดส่วนคะแนน, จำนวนวัน, เพดานค่าน้ำ-ไฟ, อัตราเงินเพิ่ม) เป็น config มี effective date

## Roadmap & release plan

ส่งมอบกลุ่ม A ให้อพาร์ตเม้นต์รายแรกภายใน 4 เดือนบน schema กลาง แล้วเปิด tenant type ทีละชนิดตาม channel ที่ขายได้หลายอาคารต่อดีล (PM company, สมาคมอาคารชุด) กลุ่ม B ที่มี AI และกฎหมายหนักไว้ Phase 3 เมื่อมีอาคารชุดบนระบบพอให้คุ้มการลงทุน corpus และทนาย

&#91;embedded content: roadmap · 4 phases, 3 gates, Oct 2026 – Apr 2028\]

ทีม: Phase 1 — 1 tech lead (ดูแล `collective-asset-core` ร่วมกับ getbuild), 2 full stack, 1 IoT/edge engineer, 0.5 designer, 1 PM/BA ที่เคยบริหารอาคาร; Phase 2 เพิ่ม 1 full stack และ onboarding specialist; Phase 3 เพิ่ม 1 AI engineer, ทนายอาคารชุดที่ปรึกษา, content owner ของ legal corpus; Phase 4 เพิ่ม field engineer สำหรับ hardware

**KPIs ที่ติดตามรายเดือน**

| KPI | Phase 1 | สิ้น Phase 2 | สิ้น Phase 4 |
| --- | --- | --- | --- |
| อาคารบนระบบ | 1 | 20 | 300 |
| ยูนิต active | 80 | 3,000 | 60,000 |
| MRR (บาท) | 3,000 | 120,000 | 1,400,000 |
| บิลที่จ่ายผ่านระบบ (%) | 60% | 75% | 85% |
| อุปกรณ์ IoT ออนไลน์ | 1 ตึก | 500 | 10,000 |
| ยูนิตที่รับจาก getbuild | — | 300 | 10,000 |
| Gross retention (รายปี) | — | — | >92% |

## Next steps

สิ่งที่ต้องทำใน session หลักของ getproperty ทันทีคือล็อก schema กลางตามส่วน Data model ก่อนที่โค้ดจะโตไปกว่านี้ จากนั้นเดินตาม prompt pack ด้านล่าง

**Open decisions**

- [ ] ยืนยันชื่อตารางกลางตาม guideline (property / building / unit / party / occupancy / lease) และ rename โค้ดที่เขียนไปแล้ววันนี้
- [ ] `collective-asset-core` เริ่มเป็น folder ใน `getproperty-api` ก่อนแล้วค่อยแยก package เมื่อ getbuild เริ่ม หรือแยกตั้งแต่ตอนนี้
- [ ] ลูกค้าอพาร์ตเม้นต์รายแรก: จำนวนตึก/ห้อง, มีมิเตอร์แบบไหนอยู่, ใช้ Excel/โปรแกรมอะไรอยู่ (กำหนด import และ hardware Phase 1)
- [ ] Smart meter protocol ที่จะใช้เป็นมาตรฐาน (LoRaWAN vs NB-IoT vs Modbus gateway) และยี่ห้อที่ทดสอบก่อน
- [ ] PromptPay: ใช้ Bill Payment API ของธนาคารไหน (ต้องเป็น QR อ้างอิงต่อบิลเพื่อกระทบยอดอัตโนมัติ)
- [ ] ทนายอาคารชุดสำหรับกลุ่ม B (ต้องมีก่อน Phase 3) และทบทวนเทมเพลตสัญญาเช่าตามประกาศ สคบ. (ก่อน Phase 1 ส่งมอบ)

**Claude Code prompt pack สำหรับ getproperty (เรียงลำดับ)**

1. **Schema lock** — rename + เพิ่มคอลัมน์ตาม checklist ในส่วน Data model; สร้าง schema `core` / `ops` / `bridge`; enum `tenant.type`, `unit.type`, `invoice_line.source_type`; RLS policy ทุกตาราง; seed tenant type `apartment`
2. **Core scaffold** — Nest modules: identity (email+OTP, LINE Login), tenant/membership/RBAC, asset core CRUD (property → building → floor → unit → party), document service, notification (LINE Flex), workflow engine (generic state machine + SLA timer), audit log
3. **A1 Lease & Occupant** — unit board, reservation, lease + e-sign (LIFF), occupancy, move-in/out checklist, ตม.30 export
4. **A2 Billing** — rate\_plan engine (jsonb tiers), billing cycle run (BullMQ), invoice/invoice\_line, PromptPay QR ต่อบิล, payment reconciliation, receipt/e-Tax (reuse getpack), dunning เบา, ledger/aging reports
5. **A3 Smart Meter** — device registry, `getproperty-edge` MQTT ingestion → TimescaleDB, meter\_assignment, reading-to-bill, manual/photo reading พร้อม OCR ผ่าน AI gateway, consumption dashboard
6. **A4 Service Request** — LIFF intake, work order, technician LIFF, preventive maintenance บน asset\_item, warranty hook (integration\_event stub)
7. **LIFF app** (`getproperty-liff`) — บิล/จ่าย, แจ้งซ่อม, สัญญา, ประกาศ, พัสดุ; ช่าง: งานของฉัน
8. **Admin back-office** — onboarding tenant/building/import Excel, แพ็กเกจ, อุปกรณ์ IoT, support, AI/usage cost
9. **Import & UAT** — import ห้อง/ผู้เช่า/มิเตอร์จากไฟล์ของลูกค้ารายแรก, seed data, UAT script ตาม Phase 1 acceptance
10. **Phase 2 prep** — tenant type `condo_juristic` + ownership\_ratio billing, `operator_tenant_id` switching, D1 handover intake consumer, C3 portfolio view

**เอกสารที่ควรทำต่อจากนี้**: (1) spec `collective-asset-core` ฉบับเต็ม (DDL + Prisma schema + event contracts) ใช้ร่วม getbuild, (2) UX flow spec + Claude Design mockups ของ A1–A4 สำหรับ web และ LIFF, (3) hardware spec และ BOM ของ smart meter kit สำหรับลูกค้ารายแรก

**Reuse จาก getpack**: auth + OTP, file service, LINE Flex notification, invoice/receipt/e-Tax, admin layout, CI (reusable workflows ของ collective-infra — product repo ไม่มี Terraform), UI kit, queue `pdf-render` — และ order flow ของ getpack ใช้ขาย hardware IoT ได้ทันที

## Changelog — infrastructure alignment 2026-10-21

Infrastructure alignment only (founder instruction 2026-10-21, `collective-infra/docs/BLUEPRINT-ALIGNMENT-PROMPT.md` A + B2): product scope, modules, phases, pricing and business content are unchanged. Copy for circulation: `getproperty-platform-blueprint-2026-10-21.md`.

**Sections changed**

- *Executive summary* — the stack bullet names the Collective shared platform (AWS `ap-southeast-7`, EC2 + docker compose) and points to `collective-infra/PLAN.md`.
- *Platform core → Shared services* — IoT ingestion runs through the platform's EMQX into the shared PostgreSQL/TimescaleDB.
- *Integration contracts* — transport is outbox → HTTP webhook (same box) or SNS/SQS (separate boxes); Pub/Sub removed; `integration_event` / `idempotency_key` / additive-schema rules unchanged (D-238).
- *Technical architecture* — Workers (BullMQ on Valkey, PDFs through `pdf-render`, Python AI workers in Phase 2 on the worker box), IoT edge (on-prem gateway agent unchanged; broker = platform EMQX; GKE/Cloud IoT wording removed), Data (shared PostgreSQL `timescaledb-ha`, S3, Valkey), Repos (`getproperty-ai-workers` on the worker box), multi-tenancy line (device JWT + HTTP authz); the Deployment and Observability paragraphs (Cloud Trace/Logging, "backup รายวัน + PITR 7 วัน") replaced by a pointer.
- *Infrastructure & operations (Collective platform)* — **new**: the 14 locked decisions as they apply, the managed-service mapping, the memory budget line (≈ 1.8 GB: api 512 · worker 512 · ingest 192 · web 384 · liff 192 MB), the image-contract confirmation, the data-safety mapping (RPO ≤ 5 min, PITR 35 days, RTO target 30 min, retention, PDPA), the EMQX authn/authz contract with the topic comparison, **Infrastructure asks from collective-infra** (A-1–A-16, quantified) and the gap tasks T-1–T-17.
- *Next steps → Reuse จาก getpack* — "Terraform/CI" → collective-infra reusable workflows; `pdf-render` added.

**Decisions** (`docs/decisions.md`): D-233 locked infrastructure decisions (explicitly supersedes D-160 — already superseded by D-230 — and amends D-230 / D-207); D-234 telemetry on TimescaleDB with compression after 30 days (supersedes D-162, amends D-184); D-235 EMQX shared-broker contract (amends D-130, D-165, D-230 (3)); D-236 PDF rendering through `pdf-render`; D-237 Python AI workers in Phase 2 on the worker box, Phase 1 OCR through the vision-model API adapter; D-238 cross-platform events = outbox → HTTP webhook / SNS-SQS. ADR-0001 and ADR-0010 amended 2026-10-21.

**Open questions for the founder (max 5)** — all five resolved 2026-10-22 as recommended: O-012 → D-239, O-013 → D-240, O-014 → D-241, O-015 → D-242, O-016 → D-243 (`docs/decisions.md`).

1. **O-013** — Per-merchant provider credentials (payments, locks, e-Tax) live today as Secrets Manager entries under `collective/<env>/getproperty/{payments,locks,etax}/…`, read at run time. Allow that as the one exception to "one secret per product per env", or move them into PostgreSQL encrypted with the tenant data key? *Recommendation: database envelope encryption (keeps the locked rule).*
2. **O-014** — At the Phase 4 KPI (10,000 devices) getproperty's IoT data is ≈ 142 GB in year 1 and ≈ 232 GB in year 2 even after compression — more than its share of a 250 GB volume. Confirm the trigger for a DB box (proposal: getproperty database > 100 GB or `/data` > 70 %) and whether the 15-minute rollups keep 5 years (or 24 months, like raw points).
3. **O-015** — Will getpack's `pdf-render` queue (Thai fonts, A4 + 80 mm thermal, output into getproperty's bucket) exist before the pilot goes live? If not, accept getproperty's own Chromium on the pilot with worker 1.5 GB under an ADR until it does.
4. **O-016** — Which region receives the DLM cross-region snapshot copy, and is the PDPA s.28 cross-border basis (encrypted snapshot, processor DPA wording) documented for the building owners' data?
5. **O-012** (updated) — WSS fallback on 443 for buildings that block 8883: accept gateways on EMQX ws 8083 behind Caddy with device-JWT-only authentication (no client certificate on that path; the JWT lives ≤ 1 h and is issued only to a non-retired gateway), or keep 8883-only?

## Changelog — gap tasks and founder decisions 2026-10-22

- Founder resolved O-012–O-016 as recommended (D-239 WSS fallback with the device JWT per gateway; D-240 provider
  credentials in PostgreSQL; D-241 DB-box trigger + 15-minute data = raw horizon, rollups 5 years; D-242 own Chromium
  under ADR-0012 until getpack's `pdf-render` consumer; D-243 DLM copy to `ap-northeast-1`, PDPA s.28 basis).
- getproperty-api implemented T-1 (producer + contract), T-3, T-5–T-9, T-12–T-16 (implementation decisions D-244–D-248,
  ADR-0012–ADR-0015); collective-asset-core 0.4.0 (non-superuser runner, webhook signing); collective-infra carries
  T-2, T-4, T-6, T-7, T-10, T-11, T-15, T-17 on `getproperty/r1-platform`. Status column added to *Gap tasks*.
