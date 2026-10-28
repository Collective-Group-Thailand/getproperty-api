# G-AUTORUN state (orchestrator log)

Started 2026-10-27 01:55 Bangkok by Cowork session `session_0118jx8J2EKuBp9EDzJFed3B` (piyapan.pak@gmail.com).
Bases on the Mac: api `d04b8f8`, web `3c1f7f6`, liff `cf6dcce`, asset-core `8d7dc54` (v0.6.0).
Pre-flight: every repo on `main`; trees clean except the founder's own uncommitted files, which are **not** committed (standing founder rule, overrides the "wip: pre-G snapshot" step). Tests green on these heads (B7.13 run: api 542 unit / 35 e2e / integration 61 suites; web 1,126 unit / 189 e2e; liff 707 unit / 116 e2e).
How it runs: each step in its own subagent on the sandbox copies (Node 24, embedded PostgreSQL 18), one at a time (API steps share migrations; the sandbox has 7 GB, so repos do not run test suites in parallel either). The orchestrator applies each green step on the Mac and commits it as Superball, no trailers, no push.

| Step | Repo | Status | Commit (Mac) | Contract (api) | O-### opened | Notes |
|---|---|---|---|---|---|---|
| G0 | api | done | aabd83b | unchanged (650 paths) | O-022…O-029 | D-284…D-291; docs only |
| G1 | api | done | f44bf20 | 661 paths (+11) | — | D-292; unit 547, e2e 35, int 441; core.document guard deferred (needs asset-core) |
| G2 | api + asset-core | done | api 5931568, core 6049a1a (0.7.0) | 678 paths (+17) | — | D-293; core legal-hold guard on core.document added; unit 551, e2e 35, int 451, core 80; smart-metering 3.3 clock fix |
| G3 | api | done | 36c7c79 | 712 paths (+34) | O-030 | D-294; unit 555, e2e 35, int 463 |
| G7 | api | done | api d69d6c8 (fddfd93) | 721 paths (+9) | O-031 | D-295; migration 0061; unit 562, e2e 35, int 472 (65 suites); self-viewing off by default (O-024); prospect phone OTP added |
| G4 | api | done | api 65e874d (f8ad203) | 730 paths (+9) | — (notes on O-027, O-029) | D-296; migration 0062; unit 569, int 478 (66 suites); test:e2e deferred; FB Page via fake (FACEBOOK_MODE off in uat/prod); LIFF /link/oa must use prospect confirm endpoint |
| G5 | api | done | (this merge) | 746 paths (+16) | O-032 | D-297, D-298; migration 0063; unit 577, int 482 (67 suites); test:e2e deferred; all G5 products seeded without price (O-027) |
| G8 | api | todo | | | | |
| G6 | api | todo | | | | |
| G9 | api | todo | | | | |
| GW1 | web | done | web a115699 | adopted api 5931568 | — | unit 1,130, e2e 192 |
| GW2 | web | done | web d326a41 | — | — | unit 1,138, e2e 196 (2 flaky on retry: admin-tenants:166, owner-settings:180); contract-request AgencyDto details |
| GW3 | web | done | web b65047e (7e73385) | adopted api 36c7c79 | — | unit 1,152, e2e 202 (1 flaky on retry: owner-settings), storybook, Lighthouse owner budgets; contract-requests: owner menu `contracts` key, admin `contract_library` key (admin legal-review page not built), unit/lessee labels on RenewalOfferDto/ContractDto |
| GW4 | web | running | | | | adopts api G5 |
| GW5 | web | todo | | | | |
| GW6 | web | todo | | | | |
| GL1 | liff | todo | | | | |
| GL2 | liff | done | liff e97e41f (52e9d65) | adopted api d69d6c8 | — | unit 729, build, storybook, lhci ≤180 KB (new prospect set); e2e self-viewing/prospect/rent-record written, deferred; CR #35 contact for accompanied viewings (PDPA question) |
| GL3 | liff | done | liff 0e341e9 (ba4e437) | adopted api 36c7c79 | — | unit 717, build, storybook, lhci ≤180 KB (notification prefs moved to /profile/notifications); contracts.spec ran green, later edits e2e deferred; CR #34 lease legal-review fields; question: lease sign screen still cites the OCPB standard lease for own templates |
| GL4 | liff | todo | | | | |
| Review | all | todo | | | | |

**2026-10-28 10:20 Bangkok** — taken over by Claude session `session_0168nuZ6jHAs2SKQZX8MK5kb` (piyapan.pa@abbon.co.th). Previous session idle since 2026-10-27 19:48; its GW3/GL3 were never merged and are redone from Mac main. asset-core main is now 2065010 (v0.7.0, re-pushed by the founder; same release as 6049a1a).

**2026-10-28 12:34 Bangkok — founder change:** web/LIFF Playwright e2e is no longer run per step (specs are still written, linted and typechecked; `pnpm build` runs on its own). Deferred e2e runs — all to be run together before the Review: GL3 onward (GW3 was run: 202). api `test:e2e` and integration still run per step.

**2026-10-28 14:05 Bangkok — founder change:** api `test:e2e` is not run per step either (specs still written). api integration still runs.
