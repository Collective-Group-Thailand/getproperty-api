# J-AUTORUN state (orchestrator log)

Pack: `docs/prompts/J-README.md` · Plan: https://claude.ai/artifact/23kqUR4FHTm2FKC2Snrv5Q · Design: `../docs/design/J-DESIGN.md`
Baseline (2026-11-05): api 143943c · web 77b4f25 · liff 1f8ce19 · edge 2d508c0 · asset-core 2065010 (v0.7.0)

| Step | Repo | Status | Commit (merge) | Contract | O-### | Notes |
|---|---|---|---|---|---|---|
| J0 | api | done | 246d7cf (8b9b8bb) | — (docs only) | O-038, O-039, O-040, O-041, O-042 | D-302–D-321; gap `docs/juristic-gap.md`, §7.6 drafts; J1.1 must first fix co-owner share / transfer proration / ownership-only sweep (golden-first); pack names corrected |
| JA | asset-core | done | asset-core 7dcf39c (c175eac), tag v0.8.0; api 51c7593 (21df284) | openapi.json regenerated (enum `juristic`) | — | core migrations 0014–0015, api 0068; asset-core 96 tests, api unit 620 (+2 skipped), int 506/514 — 7 fail on baseline too (real clock past 2026-11-01: billing, loss ×5, smart-metering 3.3) → fixed first in JR; `.github/workflows/build-image.yml` (founder file) still pins v0.7.0 → founder bumps; founder rebuilds asset-core dist on the Mac |
| JR | api | done | api 1c5aa77 (56236c3; clock fix 12f1513) | +7 operations | — | D-322; migration 0069; unit 623 (+2 skipped), int 517/519 + migrations suite re-run green after count fix; new resident-units.int-spec (5). LIFF needs: /me/units, /units/{id}/usage, unit-invitations redeem flow, ?unitId= on invoices |
| JRL | liff | done | liff 4985566 (49e684b) | sourceCommit c66e284 | — | unit 862 (+34), build, storybook, lhci ≤180 KB (new set units-roles); e2e units-roles.spec written, deferred; CR #41 propertyKind on resident unit DTOs → J1.1b; visual baseline resident-shell-unit-sheet to re-baseline |
| J1.1a | api | done | api 72b3a97a (d02f9e0) | 804 paths, frequency fields | — | D-323; migration 0070; fixed co-owner full billing, transfer double billing, owner-only cycles + valid_to off-by-one; frequencies monthly/quarterly/semiannual/annual keyed (property, frequency, period_key); juristic.revenue_schedule; unit 635, int 525/526 (0 failed) |
| J1.1b | api | done | api a03b192 (31fc29f) | 821 paths (+17) | — | D-324; migration 0071; register/transfers/bill-to/resolutions/budgets endpoints; per_sqwa + budget_split; committee/auditor roles; CR #41 done; unit 643 (+2 skipped), int 536/537 (0 failed) |
| J1.2a | api | done | api ba8ee73 (16bfc67) | 843 paths | — | D-325; migration 0072; platform-unique slip ref, allocation policy + credit, payment plans, recurring (fake, mode off in uat/prod), debt clearance DCL + public verify; unit 655, int 544/545 (0 failed). Before deploying 0072: run the duplicate slip-ref query in deployment.md. Web needs /verify/<code> page |
| J1.2b | api | todo | | | | collections ladder on the workflow engine, statements, D-270 workspace, aging/KPI reports |
| JW1 | web | todo | | | | |
| JL1 | liff | todo | | | | |
| J4.1 | api | todo | | | | |
| J4.2 | api | todo | | | | |
| JE1 | edge | todo | | | | |
| JW4 | web | todo | | | | |
| JL4 | liff | todo | | | | |
| J2.1 | api | todo | | | | |
| J2.2 | api | todo | | | | |
| JW2 | web | todo | | | | |
| J3.1 | api | todo | | | | |
| J3.2 | api | todo | | | | |
| J3.3 | api | todo | | | | |
| JW3 | web | todo | | | | |
| e2e | all | todo | | | | deferred runs |
| Review | all | todo | | | | |
| Report | api | todo | | | | |

**2026-11-05 00:58** — J0 merged (api 246d7cf). Orchestrator (team lead) accepted J0 findings: J1.1 and J1.2 split into a/b slices; pack corrections marked "J0:" in J-juristic-api.md. JA restarted with corrected spec (no own_unit helper, title_deed_no exists, enum core.building_legal_form, event unit_ownership.transferred).

**2026-11-05 03:35** — JA merged on the Mac (asset-core fast-forward to 7dcf39c + tag v0.8.0; api merge 51c7593, PROGRESS conflict resolved newest-first).

**2026-11-05 05:40** — server restart at ~04:00 stopped JR; resumed from transcript, merged (fast-forward) on the Mac. Next: J1.1a (api) + JRL (liff) in parallel.

**2026-11-05 07:10** — second server restart (~06:40) stopped J1.1a + JRL; both resumed. JRL merged (ff). J1.1a finishing.

**2026-11-05 07:45** — J1.1a merged. Next: J1.1b (+ CR #41 propertyKind on resident unit DTOs).

**2026-11-05 ~10:30** — J1.1b merged (ff). Next: J1.2a (api).

**2026-11-05 ~13:30** — third server restart during J1.2a; resumed; merged (ff). Next: J1.2b.
