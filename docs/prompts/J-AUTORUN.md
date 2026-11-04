# J — Autorun (run the whole Juristic / Common Charges / Gate pack without stopping)

Run from `~/Collective/getproperty` (holding `collective-asset-core`, `getproperty-api`, `getproperty-web`, `getproperty-liff`, `getproperty-edge`). You are the **orchestrator**: you do not write feature code yourself; each step runs in its own subagent with a fresh context (the equivalent of `/clear` between sessions).

## Before the first step
1. Read `RESUME.md`, `AGENT-BRIEF.md`, `getproperty-api/docs/prompts/J-README.md`, `J-juristic-api.md`, `getproperty-web/docs/prompts/J-juristic-web.md`, `getproperty-liff/docs/prompts/J-juristic-liff.md`, `getproperty-edge/docs/prompts/J-gate-edge.md`, `docs/design/DESIGN.md`, `docs/design/J-DESIGN.md`.
2. Every repo on `main`, clean tree, gates green. A dirty tree that is not the founder's own files → commit `wip: pre-J snapshot`.
3. Create or read `getproperty-api/docs/J-AUTORUN-STATE.md` (status `todo | running | done | partial | blocked`, commit SHAs, contract SHA, D/O rows). **Resume from the first step that is not `done`.** Write your session and start time into RESUME.md "Active session"; if another live session holds it, stop and report.
4. Design tooling for UI steps: `npx -y ui-ux-pro-max-cli init --ai claude` in the working copy root (do not commit `.claude/`), Stitch tools as described in `J-DESIGN.md` §2.

## Order
| Wave | Steps |
|---|---|
| 1 | J0 |
| 2 | JA (asset-core 0.8.0 release, bump in api) |
| 3 | JR → JRL (liff, beside J1.1) |
| 4 | J1.1 → J1.2 |
| 5 | JW1 + JL1 (beside J4.1) · J4.1 → J4.2 |
| 6 | JE1 + JW4 + JL4 (beside J2.1) · J2.1 → J2.2 |
| 7 | JW2 (beside J3.1) · J3.1 → J3.2 → J3.3 |
| 8 | JW3 |
| 9 | Deferred e2e (api `test:e2e`, web + LIFF Playwright) → Review → Report |

API steps one at a time. A web / LIFF / edge step starts when its API step is merged on Mac `main`; it may run while the next API step runs (memory: never api integration and Playwright together in a 7 GB sandbox).

## Each step = one subagent with this brief
> You work in `<repo>`. Read `CLAUDE.md`, `docs/prompts/00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md` (web/liff: also `docs/prompts/design-system.md`, `../docs/design/DESIGN.md`, `../docs/design/J-DESIGN.md`), `getproperty-api/docs/prompts/J-README.md` and the repo's J pack file. Do **<step> only**.
> - Write `docs/plans/<step>.md` first, then execute. Never wait for approval, never ask.
> - Follow every rule in CLAUDE.md and AGENT-BRIEF (tenancy/RLS, money as decimal strings, audit + outbox, Idempotency-Key, PDPA, collective-infra only).
> - Missing decision (price, partner, provider, legal wording) → O-### (api) or contract-request / PROGRESS (others), implement behind a setting or fake, finish the rest. UX questions are decided by `J-DESIGN.md`; if it is silent, decide as design lead, write the decision and reason into `J-DESIGN.md` §7 "Decisions during the run".
> - web/liff: adopt the contract `API_CONTRACT_REF=<api sha> pnpm gen:api --adopt`; render screenshots of every new screen (1440 / 1180×820 / 390) into `_shots/j-<step>/` and compare with `docs/design/stitch/j/`.
> - Done = lint, format, typecheck, unit, build (+ api contract build/lint and integration; web/liff storybook + Lighthouse budgets) green; e2e specs written (run deferred); PROGRESS, deployment needs, contract regenerated (api).
> - Commit on a `feat/<step>` branch as `Superball <Piyapan.pa@abbon.co.th>` with **no** Co-Authored-By or Claude-Session trailers, merge `--no-ff` into `main` on the Mac. No push.
> - Report: commit SHA, contract SHA, tests and counts, O-### opened, anything partial.

## Orchestrator after each step
- Update `J-AUTORUN-STATE.md` (and RESUME.md + `getproperty-web/docs/CHECKLIST.md` at least hourly).
- Red after two fix attempts → `partial` with the reason; continue with steps that do not depend on it. Never stop the whole run for one step.
- asset-core changed → release + bump before the next api step; note that the founder must rebuild asset-core dist on the Mac after pulling.
- web `contract.lock.json` `apiCommit` = 12 chars of the Mac api SHA; liff `sourceCommit` = full 40-char SHA.

## Finish
1. Deferred e2e on final HEADs: api `test:e2e`, web Playwright, LIFF Playwright; fix failures with failing-first tests.
2. Three independent read-only review subagents (api; web; liff + edge) over the whole J diff: tenancy leaks across juristic / PM / landlord grants, money and allocation correctness, duplicate-slip and idempotency, collection steps that bypass the legal flags, gate PDPA (retention really deletes, residents see only their unit), device command replay, secrets. Fix every finding with a regression test.
3. `getproperty-api/docs/J-AUTORUN-REPORT.md`: steps × status × SHAs, test counts, all new D/O rows, design decisions taken during the run, collective-infra needs (env, secrets, jobs, buckets), founder to-do (O-038…O-042, O-020, pilot data), screenshots index.
4. Update RESUME.md (clear "Active session"), give the founder a short Thai report.

**Hard rules**: no push, no deploy, no `collective-infra` changes, no real external providers, never commit or discard the founder's own files (list in `HANDOFF-G-AUTORUN.md`), never touch key files (AWS CSV, Firebase admin JSON).
