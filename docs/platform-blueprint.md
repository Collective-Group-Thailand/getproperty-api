# getproperty Platform Blueprint — Collective Group

Oct 16, 2026 · @Superball

## Executive summary

**getproperty** คือ Building Operations platform ของ Collective Group: ระบบเดียวสำหรับทุกคนที่ "บริหารอาคารที่มีคนอยู่" — เจ้าของอพาร์ตเม้นต์/หอพัก (ลูกค้ารายแรก), นิติบุคคลอาคารชุด, บริษัทบริหารอาคาร (PM company) และเจ้าของห้องรายย่อยที่ปล่อยเช่า (landlord) ขายเป็น SaaS ต่ออาคาร/ต่อยูนิต บวก IoT (smart meter, access control) ที่สร้างรายได้จาก hardware และข้อมูลที่ไหลเข้าบิลอัตโนมัติ

เอกสารนี้ขยาย scope จาก "ระบบบริหารอพาร์ตเม้นต์ + IoT" ที่เริ่มเขียนโค้ดเมื่อ 16 ต.ค. 2026 ให้เป็น platform เต็มรูปแบบ โดย**ไม่เปลี่ยนสิ่งที่ลูกค้ารายแรกจะได้** แต่ล็อก data model และชื่อตารางให้เป็นกลางตั้งแต่สัปดาห์แรก เพื่อให้เพิ่ม tenant type อื่นได้โดยไม่ migrate

ความสัมพันธ์ในตระกูล get\*: **getbuild** (Build & Deliver — ผู้รับเหมา, Developer) ส่งอาคารที่สร้างเสร็จ ยูนิต เจ้าของ defect history และทะเบียนทรัพย์สินเข้า getproperty ด้วย handover event; **getpack** รับใบขอซื้อวัสดุและอะไหล่ซ่อมบำรุงจาก getproperty; ทั้งสามใช้ `collective-shared` (auth, LINE, billing, UI) และ `collective-asset-core` (building → unit → party) ร่วมกัน โดย **getproperty เป็นเจ้าของ schema ของ asset core** เพราะเป็น platform ที่ถือข้อมูลอาคารยาวที่สุด

ข้อสรุปหลัก:

- 4 tenant types บน core เดียว ต่างกันที่ "ใครเป็นเจ้าของยูนิต" และ "ใครจ่ายบิล": apartment (เจ้าของเดียว ผู้เช่าจ่าย), condo juristic (เจ้าของร่วมหลายราย จ่ายค่าส่วนกลาง), PM company (บริหารแทนหลายอาคาร), landlord (เจ้าของรายย่อย ยูนิตกระจายหลายอาคาร)
- 12 modules ใน 4 กลุ่ม: A ฐานปฏิบัติการอาคาร (เช่า/ผู้อยู่อาศัย, บิล/บัญชี, smart meter, แจ้งซ่อม), B นิติบุคคล (AGM & e-Voting, AI Juristic Assistant, Asset & Sinking Fund & Inspection), C อาคารอัจฉริยะและ portfolio (access control, energy, PM back-office), D จุดเชื่อม (post-sale portal, landlord tier)
- Phase 1 (ตอนนี้–ก.พ. 2027) ส่งมอบกลุ่ม A ให้อพาร์ตเม้นต์รายแรก บน schema กลางที่ออกแบบไว้ในเอกสารนี้; Phase 2 เปิดคอนโดและ PM company; Phase 3 landlord และ access control; Phase 4 energy และ AI เต็มรูปแบบ
- รายได้: ต่อยูนิต 15–40 บาท/เดือนสำหรับอพาร์ตเม้นต์/คอนโด (ขั้นบันได), landlord freemium → 99–299 บาท/เดือน, hardware IoT ขาย/เช่า, PM company สัญญารายปี
- Stack เดียวกับ getpack/getbuild: Next.js + NestJS + PostgreSQL (+ TimescaleDB, pgvector), MQTT edge, LINE LIFF เป็นหน้าบ้านของผู้อยู่อาศัยและช่าง

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
| IoT ingestion (`getproperty-edge`) | MQTT → device registry → TimescaleDB; ใช้กับมิเตอร์ ประตู พลังงาน และกล้องหน้างานของ getbuild |
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

ทุกการสื่อสารข้าม platform เป็น event ผ่าน Pub/Sub + REST callback ที่นิยามใน `collective-asset-core` (`packages/contracts`) ทั้งสองฝั่ง deserialize ด้วย schema เดียวกัน (zod) และบันทึกลง `integration_event` เพื่อ replay ได้

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
| Workers | BullMQ: billing run, notification, reading-to-bill, dunning timers; Python (`getproperty-ai-workers`): OCR มิเตอร์, STT, forecast, RAG indexing | ใช้ AI gateway ร่วม getbuild |
| IoT edge | `getproperty-edge`: EMQX (MQTT), device registry, protocol adapters (LoRaWAN NS, Modbus/TCP gateway, vendor cloud API สำหรับประตู/กล้อง), TimescaleDB writer | ทำงานได้บน on-prem mini PC ต่ออาคารเมื่อเน็ตล่ม (store & forward) |
| Data | PostgreSQL (Cloud SQL) + TimescaleDB extension (readings, energy) + pgvector (B2); Object storage (GCS) สำหรับรูป/สัญญา; Redis | ฐานเดียว แยก schema `core / ops / juristic / smart / bridge` |
| External | LINE Messaging/Login/LIFF, PromptPay (Bill Payment API ธนาคาร) + card gateway, e-Tax provider, LLM providers (Claude/Gemini), vendor APIs ของอุปกรณ์, Zoom/Meet (B1) | adapter pattern ทุกตัว |
| Shared packages | `collective-shared` (UI, auth, LINE, notification, billing types), `collective-asset-core` (schema + migrations + contracts — owned โดย repo นี้) | publish เป็น private npm package, version ตาม semver |

**Repos**

| Repo | สถานะ | หมายเหตุ |
| --- | --- | --- |
| `getproperty-web` | มีแล้ว (เริ่ม 16 ต.ค.) | เพิ่ม route group `(admin)` และ portfolio view สำหรับ PM/landlord ภายหลัง |
| `getproperty-api` | มีแล้ว | จัดโครง `core/` + `modules/ops-*` ตาม data model guideline |
| `getproperty-edge` | มีแล้ว | ขยาย device type: meter → door/camera/energy |
| `getproperty-liff` | ใหม่ | เริ่ม Phase 1 ด้วยหน้าบิล/จ่าย/แจ้งซ่อม |
| `getproperty-ai-workers` | ใหม่ (Phase 2) |  |
| `collective-shared` | แยกจาก getpack | ทำครั้งเดียวใช้สามโปรเจกต์ |
| `collective-asset-core` | ใหม่ owned ที่นี่ | migrations อยู่ที่นี่ getbuild ติดตั้งเป็น dependency |

**Multi-tenancy & security**: `tenant_id` ทุกตาราง + RLS; `operator_tenant_id`/`owner_tenant_id` บน building + `asset_access_grant` สำหรับสิทธิ์ข้าม tenant; PII เข้ารหัสระดับคอลัมน์; signed URL อายุสั้น; audit log append-only 10 ปี; อุปกรณ์ IoT ใช้ per-device certificate (mTLS) และ topic ACL ต่อ tenant

**Deployment**: Docker บน GCP (Cloud Run web/api, Cloud Run jobs workers, GKE Autopilot สำหรับ EMQX), Cloud SQL, GCS, Memorystore; edge box ต่ออาคารเป็น optional (Docker Compose บน mini PC); Terraform และ CI pipeline เดียวกับ getpack; environment dev / uat / prod

**Observability**: OpenTelemetry → Cloud Trace/Logging, Sentry, device health dashboard (ออนไลน์/ค่าล่าสุด/แบตเตอรี่), AI cost ต่อ tenant, billing run audit; backup รายวัน + PITR 7 วัน

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

**Reuse จาก getpack**: auth + OTP, file service, LINE Flex notification, invoice/receipt/e-Tax, admin layout, Terraform/CI, UI kit — และ order flow ของ getpack ใช้ขาย hardware IoT ได้ทันที
