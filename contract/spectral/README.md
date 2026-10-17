# getproperty contract ruleset

`pnpm contract:lint` runs [Spectral](https://github.com/stoplightio/spectral) with `.spectral.yaml` on the
generated `contract/openapi.json`. Any warning fails CI. The rules implement
`docs/contract/api-conventions.md` §5. `test/unit/spectral-ruleset.spec.ts` proves that the getproperty rules fire.

| Rule | What it enforces |
|---|---|
| `getproperty-operation-id` | `operationId` is `<surface>.<resource>.<action>` (use `@ApiEndpoint`) |
| `getproperty-operation-summary` | one-line `summary` |
| `getproperty-operation-implements` | `description` cites `D-###` or `ADR-####` |
| `getproperty-operation-surface-tag` | exactly one tag, prefixed by the surface; tags need a description (`tag-description`, `operation-tag-defined`) |
| `getproperty-operation-security-declared` | `security` is always present (`[]` = public, via `@Public()`) |
| `getproperty-surface-security` | `/v1/owner`, `/v1/staff` (`operatorBearer`), `/v1/resident` (`residentBearer`), `/v1/technician` (`technicianBearer`), `/v1/admin` (`platformBearer`), `/v1/device` (`deviceBearer`) use only their audience scheme, or are explicitly public / optionally authenticated (contract §2, ADR-0003 as amended by ADR-0009) |
| `getproperty-response-set` | a 2xx and a 500; a 4xx (except `ops.*`); 401 and 403 when secured; 400 and 422 with a body; errors only as `application/problem+json` → `ProblemDetails` |
| `getproperty-status-by-kind` | `If-Match` ⇒ 412; `Idempotency-Key` ⇒ 409; a 202 names the operation to poll or says "Nothing to poll." (`@ApiAsync`) |
| `getproperty-response-example`, `getproperty-request-example` | every body has `example` or `examples` |
| `getproperty-no-inline-enum` | enums are named components (`enumName`) |
| `getproperty-object-shape` | no bare `type: object` |
| `getproperty-field-formats` | money (unit THB) is a decimal string, never a JSON number; `…At` → `date-time`; `…On` / `…Date` → `date` |
| `getproperty-no-duplicate-schemas` | no two component schemas with the same shape |
| `getproperty-no-real-personal-data` | examples use obviously fake data (below) |
| `getproperty-compliance-legal-ref` | every `compliance.*` problem example carries `legalRef` (D-020) |

## Fake data in examples (PDPA, D-025)
- **Email:** only reserved domains: `example.com`, `example.org`, `example.net`, `*.example`, `*.test`, `*.invalid`.
- **Thai phone:** the fake forms `08x-000-xxxx` (mobile) and `02-000-xxxx` (landline), e.g. `081-000-1234`.
- **13-digit ids (national id / tax id):** must start with `0000` and must not pass the Thai id checksum, e.g. `0000000000002`.
- **Licence plates:** Thai letters + digits are flagged unless the digits are all zero (`กข 0000`).
- **Card numbers:** never. Any 13–19 digit string that passes the Luhn check is rejected.
- **Names and addresses:** obviously fictional (e.g. `ผู้เช่า ทดสอบ`, `หอพักตัวอย่าง`, `99/9 ถนนตัวอย่าง`).
- **Epoch timestamps:** a 13-digit epoch in milliseconds trips the id rule. Use ISO 8601 strings, as the contract requires anyway.
- Use the constants in `src/common/openapi/examples.ts` (`FAKE`).
