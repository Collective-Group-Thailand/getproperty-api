# Test accounts (dev only)

บัญชีทดสอบที่ `pnpm db:seed:dev` สร้างไว้ (ที่มา: `DEV` และ `seedDev()` ใน `prisma/seed/run.ts`).
ใช้ได้เฉพาะฐานข้อมูล local/dev เท่านั้น — production ไม่มี tenant ทดสอบและบัญชี `*.invalid` เหล่านี้

## เตรียมข้อมูล

```bash
pnpm db:local        # embedded PostgreSQL (ถ้ายังไม่ได้รัน)
pnpm db:migrate
pnpm db:seed:dev
pnpm dev             # API ที่ http://localhost:3000
```

## รหัสผ่านกลาง

ทุกบัญชี operator และ platform ใช้รหัสผ่านเดียวกัน: `getproperty-dev-only-password`

## Operator — tenant "หอพักตัวอย่าง" (`apartment`)

Tenant id: `0199f2a0-0000-7000-8000-000000000001` (slug `sample-dormitory`)

| Role    | Email                     | Phone           | User id                                |
| ------- | ------------------------- | --------------- | -------------------------------------- |
| owner   | `owner@example.invalid`   | `+660000000001` | `0199f2a0-0000-7000-8000-0000000000a1` |
| manager | `manager@example.invalid` | `+660000000002` | `0199f2a0-0000-7000-8000-0000000000a2` |
| staff   | `staff@example.invalid`   | `+660000000003` | `0199f2a0-0000-7000-8000-0000000000a3` |

```bash
curl -s localhost:3000/v1/auth/operator/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.invalid","password":"getproperty-dev-only-password"}'
```

ส่ง header `X-Tenant-Id: 0199f2a0-0000-7000-8000-000000000001` กับคำขอ `/v1/owner/*` และ `/v1/staff/*`

## Platform — `/v1/admin`

| Role           | Email                       | Phone           | User id                                |
| -------------- | --------------------------- | --------------- | -------------------------------------- |
| platform_admin | `admin@getproperty.invalid`   | `+660000000091` | `0199f2a0-0000-7000-8000-0000000000b1` |
| support        | `support@getproperty.invalid` | `+660000000092` | `0199f2a0-0000-7000-8000-0000000000b2` |

ผู้ใช้ platform ต้องลงทะเบียน TOTP ตอนเข้าใช้ครั้งแรก (`/v1/auth/platform/totp/enroll` → `/v1/auth/platform/totp/activate`)
แล้วส่ง `totpCode` จากแอป authenticator ทุกครั้งที่ login ที่ `/v1/auth/platform/login`

## Resident — ผู้เช่าห้อง A-101

| Party                    | Phone           | Party id                               | Lease                              |
| ------------------------ | --------------- | -------------------------------------- | ---------------------------------- |
| ผู้เช่า ตัวอย่าง (ทดสอบ) | `+660000000011` | `0199f2a0-0000-7000-8000-000000000005` | `CTR-2026-00001` (active, 12 เดือน) |

Resident ไม่มีรหัสผ่าน — เข้าผ่าน OTP (`/v1/auth/resident/otp/*`) หรือ LINE (`/v1/auth/resident/line`).
เมื่อ `INTEGRATIONS_MODE=fake` SMS เก็บไว้ในหน่วยความจำ (`FakeSms`) ไม่ได้ส่งจริง ส่วน LINE รับ id token ปลอมที่สร้างด้วย
`fakeLineIdToken()` (`src/integrations/line/fake-line-login.ts`) รูปแบบ `fake-line.<base64url(claims)>` เช่น

```bash
node -e 'const c={sub:"U-dev-resident",aud:"fake-channel",exp:Math.floor(Date.now()/1000)+600,name:"LINE Test"};
console.log("fake-line."+Buffer.from(JSON.stringify(c)).toString("base64url"))'
```

## ข้อมูลอื่นที่ seed ไว้

- Property `0199f2a0-0000-7000-8000-000000000003`, building A `0199f2a0-0000-7000-8000-000000000004`
- ห้อง A-101 … A-106 และ A-201 … A-206 พร้อมมิเตอร์ไฟและน้ำ (จดมือ) ห้องละ 1 ตัว
