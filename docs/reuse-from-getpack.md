# Reuse from getpack (founder 2026-10-24)

getpack (`~/Collective/getpack`, api `dcd2a56`, web `57d5d4a`) is built on the same stack and conventions as
getproperty (Next.js 16 + NestJS + Prisma, ports + adapters with fakes, contract-first, `INTEGRATIONS_MODE`).
Before writing an integration or a generic module, **port it from getpack** instead of writing it again.

## How to port
1. Copy the file(s) into the matching getproperty folder; keep the port/adapter split and the fake.
2. First line of each ported file: `// Ported from getpack-api@dcd2a56 src/…; adapted for getproperty (D-…)`.
3. Rename symbols to getproperty's conventions, swap getpack config keys for getproperty settings/secrets,
   keep their tests (spec files) and make them pass here.
4. Never import across repositories; no runtime dependency on getpack.
5. When a third product (getbuild) needs the same code, extract it into a shared package next to
   `@collective/asset-core` (e.g. `@collective/integrations`, `@collective/web-kit`) and switch all products to it.

## Map
| getpack source | Use in getproperty | Deliverable |
|---|---|---|
| api `src/integrations/identity/*` (identity-verifier.port, firebase-verifier, line-verifier, fakes) | phone OTP / Google / Apple through Firebase Auth ID tokens + LINE (D-255) | B7.8 login |
| api `src/modules/auth/login/*` (otp.service, phone.ts, customer-login.service) + `controllers/customer-auth.controller.ts` | OTP rate limits, phone normalisation, social login → session | B7.8 login |
| api `src/integrations/payments/twoc2p.adapter.ts`, `slip2go.adapter.ts`, `payment-gateways.port.ts` | 2C2P as a split-settlement gateway candidate (O-020); Slip2Go as a second slip verifier beside EasySlip | B7.6 |
| api `src/modules/loyalty/*` (registry, points math, jobs) | owner referral credit (D-273) — credits instead of points | B7.11 |
| api `src/modules/catalog/cms/*` + store content endpoints | guides / articles / glossary edited by the platform team (D-271), replacing web content files | B7.13 (new) |
| api `src/integrations/pdf/pdfa3.ts`, `srgb-icc.ts` | PDF/A-3 output if the e-Tax provider needs it locally | as needed |
| web `src/features/shared/auth/*`, `src/app/[locale]/sign-in` | sign-in page layout, return-to handling, consent step | F6.1 / D-255 |
| web `src/features/customer/help/*` (GuidedHelp, IntentPicker, ContactForm, CsHandoff) | `/help` and `/contact` with guided intents and LINE hand-off | web public site |
| web `src/features/customer/learn/Glossary*` | glossary chips in guides | web public site |
| web `src/app/[locale]/(storefront)/referral/[code]`, `reviews` | referral landing (D-273), verified reviews page | F6.7 |
| `design/taste-audit-*` | design review checklist before shipping public pages | web |
