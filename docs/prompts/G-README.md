# Prompt pack G — Listing & Growth (module E) · getproperty

**getproperty — บิลทำเอง เก็บเงินเอง ถูกกฎหมาย** · Collective Group (Thailand) · pack date 2026-10-27

ที่มา: เอกสารกลยุทธ์ "getproperty — กลยุทธ์ธุรกิจสำหรับ Agency/นายหน้า และรายได้ใหม่" (https://claude.ai/artifact/S1WTXcvCeUaaQ8qpKttrzS) และคำตัดสินของผู้ก่อตั้ง 2026-10-26 (ด้านล่าง) · ใช้กับ `main` ล่าสุดบน Mac (api `d04b8f8`, web `3c1f7f6`, liff `cf6dcce` หรือใหม่กว่า)

## วางไฟล์
| ไฟล์ใน pack | วางที่ |
|---|---|
| `G-growth-api.md` | `getproperty-api/docs/prompts/G-growth-api.md` |
| `G-growth-web.md` | `getproperty-web/docs/prompts/G-growth-web.md` |
| `G-growth-liff.md` | `getproperty-liff/docs/prompts/G-growth-liff.md` |
| `README.md` (ไฟล์นี้) | `getproperty-api/docs/prompts/G-README.md` (ตารางรันรวม 3 repo) |
| `G-AUTORUN.md` | `getproperty-api/docs/prompts/G-AUTORUN.md` (รันทั้ง pack ต่อเนื่องใน session เดียว) |

ชื่อ step ใช้ **G** (Growth) ทั้ง 3 repo เพื่อไม่ชนกับ B7/F/L ที่มีอยู่แล้ว

## คำตัดสินของผู้ก่อตั้งที่ pack นี้ถือเป็นข้อกำหนด (G0 บันทึกเป็น D-### ถัดไป)
1. **Agency และ landlord ใช้ฟรีไม่จำกัด** — ผู้ใช้ ยูนิต ประกาศ ไม่จำกัด (แทน Landlord 99/299 ใน D-156 สำหรับ landlord; apartment / condo juristic / PM ยังคิดตาม D-156)
2. **Storage quota**: ฟรี 5 GB ต่อ tenant ปรับค่าได้ที่หน้า admin; เกินแล้วซื้อ **storage package** ที่ admin สร้างและตั้งราคาเองได้ (ยังไม่กำหนดราคา) หรือลบไฟล์เก่าคืนพื้นที่
3. **นับทุกไฟล์เข้าโควตา** รวมเอกสารที่ระบบออกและกฎหมายบังคับเก็บ (สัญญาเช่า ใบเสร็จ ใบกำกับภาษี สลิป) — **แต่ลบเอกสารเหล่านั้นไม่ได้**จนครบระยะเก็บตามกฎหมาย และระบบยังออกเอกสารตามกฎหมายต่อได้แม้เต็มโควตา (ไม่หยุดออกใบเสร็จ)
4. รายได้: boost ประกาศ, sponsored broadcast ผ่าน LINE OA getproperty (เลือก segment จากผู้ที่ยินยอม), ค่า integrate LINE OA ของ agency, success fee, co-broke fee, verified photo, Renter Passport (มีแล้ว B7.11), move-in referral, market insight
5. **Facebook**: ไม่โพสต์ลงกลุ่มอัตโนมัติ (Groups API ถูกยกเลิก v19) — ใช้ชุดแชร์กึ่งอัตโนมัติ + โพสต์ Facebook Page อัตโนมัติ
6. **Blue ocean 6 ข้อ อนุมัติทั้งหมด**: self-viewing ด้วยรหัสประตูชั่วคราว, relocation network, deposit-free (รอพาร์ทเนอร์), หอพักแรงงาน B2B, getbuild rental handoff, energy insight → getenergy
7. **Contract library**: คลัง draft สัญญาที่ผู้ใช้นำไปใช้หรือแก้ไขเองได้ + ต่อสัญญา
8. ราคาทุกตัวเป็นสมมติฐาน เก็บเป็น price plan / setting ที่มี effective date แก้ได้ที่หน้า admin ไม่ hard-code

## ลำดับรัน (Plan Mode ทีละ session, `/clear` ระหว่าง session)
คำนำหน้า api: `Read CLAUDE.md, docs/prompts/00-master-plan.md, docs/decisions.md, docs/contract/api-conventions.md and docs/prompts/G-README.md.`
คำนำหน้า web/liff: คำนำหน้ามาตรฐานของ repo นั้น + `and docs/prompts/G-growth-<repo>.md`

| Step | Repo | Kickoff | ต้องรอ |
|---|---|---|---|
| G0 | api | `Then read docs/prompts/G-growth-api.md. Do G0 only. Plan first.` | — |
| G1 | api | `… Do G1 only.` (storage quota & packages) | G0 |
| G2 | api + asset-core | `… Do G2 only.` (agency tenant, grants, co-broke) | G0 |
| G3 | api | `… Do G3 only.` (contract library & renewals) | G0 |
| G4 | api | `… Do G4 only.` (distribution: public listing, FB Page, share kit, agency OA) | G2 |
| G5 | api | `… Do G5 only.` (boost, success/co-broke fees on platform invoice) | G1, G2 |
| G6 | api | `… Do G6 only.` (audience, consent, sponsored broadcast) | G4 |
| G7 | api | `… Do G7 only.` (self-viewing) | G0 |
| G8 | api | `… Do G8 only.` (getbuild handoff, employer housing, relocation) | G2 |
| G9 | api | `… Do G9 only.` (verified reviews, listing assistant, energy insight) | G4 |
| GW1–GW6 | web | `Then read docs/prompts/G-growth-web.md. Do GW<N> only. Plan first.` | api step ที่ระบุในไฟล์ |
| GL1–GL4 | liff | `Then read docs/prompts/G-growth-liff.md. Do GL<N> only. Plan first.` | api step ที่ระบุในไฟล์ |

ขนานได้: G1, G2, G3, G7 หลัง G0 (คนละ module) · web/liff เริ่มด้วย MSW mock ได้ทันทีที่ api commit contract ของ step นั้น · ทุก step ปิดด้วย contract ใหม่ → web/liff `API_CONTRACT_REF=<sha> pnpm gen:api --adopt`

## รอคนตัดสิน (ห้ามเดา — ให้ session เขียน O-### แล้วทำส่วนที่ไม่ติด)
ราคา storage package · LINE Thailand ยืนยันว่า sponsored listing ผ่าน OA getproperty ทำได้ (จนกว่าจะยืนยัน `broadcast.sponsored.enabled=false`) · พาร์ทเนอร์ประกัน (deposit-free, ประกันช่วง self-viewing) · ผู้ให้บริการ e-KYC (O-021) · payment gateway (O-020) · ฝ่ายกฎหมายรีวิว draft สัญญาทุกฉบับ

## หลังทุก session
`docs/PROGRESS.md` · contract ใหม่ใน commit เดียวกัน · ถ้าแก้ `core.*` → release `collective-asset-core` ก่อน · ถ้าเพิ่ม container/env/secret/bucket prefix → เขียนรายการลง `docs/deployment.md` และเปิดงานที่ collective-infra (ไม่แก้ infra ใน product repo)
