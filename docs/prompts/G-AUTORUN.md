# G — Autorun (run the whole Listing & Growth pack without stopping)

Run this from the folder that holds all getproperty repos (`~/Collective/getproperty`, containing `collective-asset-core`, `getproperty-api`, `getproperty-web`, `getproperty-liff`). You are the **orchestrator**. You do not write feature code yourself: each step runs in its own subagent with a fresh context, the equivalent of a `/clear` between sessions.

## Before the first step
1. Read `getproperty-api/docs/prompts/G-README.md`. Then read `G-growth-api.md`, `getproperty-web/docs/prompts/G-growth-web.md` and `getproperty-liff/docs/prompts/G-growth-liff.md`.
2. Check that every repo is on `main`, its working tree is clean, and its tests are green. If a tree is dirty, commit it as `wip: pre-G snapshot` before starting.
3. Create or read `getproperty-api/docs/G-AUTORUN-STATE.md`. It records each step with its status (`todo | running | done | partial | blocked`), the commit SHA, the contract SHA, and the O-### opened. **If the file already exists, resume from the first step that is not `done`.**

## Order (a step starts only when everything in its "after" column is `done` or `partial`)
| Wave | Steps | After |
|---|---|---|
| 1 | G0 | — |
| 2 | G1, G2 (+ asset-core release), G3, G7 | G0 |
| 3 | G4, G5, G8 · GW1 (after G1) · GW3, GL3 (after G3) | wave 2 |
| 4 | G6, G9 · GW2 (after G2) · GW4 (after G4, G5) · GL2 (after G7) | wave 3 |
| 5 | GW5, GL1 (after G6) · GW6, GL4 (after G7–G9) | wave 4 |

**Concurrency rule.** Inside a wave, steps in different repos may run in parallel. API steps run **one at a time**, because they share migrations, `decisions.md`, numbering and `openapi.json`.

## Each step = one subagent with this brief
> You work in `<repo>`. Read `CLAUDE.md`, `docs/prompts/00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md` (web/liff: also the repo's design-system prompt), `getproperty-api/docs/prompts/G-README.md`, and `docs/prompts/G-growth-<repo>.md`. Do **<step> only**.
>
> **How to work**
> - Write the plan to `docs/plans/<step>.md` first, then execute it. Do not wait for approval.
> - Follow every existing rule in CLAUDE.md: tenancy/RLS, money as decimal strings, audit + outbox, Idempotency-Key, PDPA, D-024/D-071, collective-infra only.
> - If a decision is missing (price, partner, provider, legal wording), **do not guess**. Add an O-### row, implement behind a setting or fake adapter, and finish the rest.
> - **web/liff only:** adopt the API contract from the latest committed api SHA with `API_CONTRACT_REF=<sha> pnpm gen:api --adopt`.
>
> **Done means:** lint, typecheck, unit, integration/e2e, and Lighthouse budgets (web/liff) are all green. The step's acceptance list in the pack is covered by tests.
> - Also update `docs/PROGRESS.md`, regenerate the contract (api), and list any deployment needs in `docs/deployment.md`.
> - Make one commit per step (`feat(G<N>): …`), with no push.
> - Report back: commit SHA, contract SHA (api), tests run and passing, O-### opened, and anything left `partial`.

## The orchestrator after each step
- Update `G-AUTORUN-STATE.md`.
- If the step is red after two fix attempts, mark it `partial` with the reason and continue with the steps that don't depend on it. **Never stop the whole run for one step.**
- **asset-core.** If a step changed `collective-asset-core`, release and bump it in the dependent repos before the next api step.

## Finish
1. Run every repo's full test suite once more on the final HEADs.
2. Run one independent review subagent over the whole G diff, covering tenancy leaks, legal-hold deletion paths, consent bypass, money/e-money, and secrets. Fix what it finds, with regression tests.
3. Write `getproperty-api/docs/G-AUTORUN-REPORT.md` with:
   - a table of steps with their status and SHAs;
   - test counts;
   - a list of all new D-### and O-### rows;
   - the deployment needs for collective-infra (env, secrets, buckets, containers);
   - what still waits on the founder.

**Hard rules**
- Do not push.
- Do not change `collective-infra` from here; list its needs instead.
- Do not deploy.
- Do not call real external providers. LINE, Facebook, e-KYC, AI and the lock vendor all stay on fakes.
