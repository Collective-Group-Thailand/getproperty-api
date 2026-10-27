# G-AUTORUN state (orchestrator log)

Started 2026-10-27 01:55 Bangkok by Cowork session `session_0118jx8J2EKuBp9EDzJFed3B` (piyapan.pak@gmail.com).
Bases on the Mac: api `d04b8f8`, web `3c1f7f6`, liff `cf6dcce`, asset-core `8d7dc54` (v0.6.0).
Pre-flight: every repo on `main`; trees clean except the founder's own uncommitted files, which are **not** committed (standing founder rule, overrides the "wip: pre-G snapshot" step). Tests green on these heads (B7.13 run: api 542 unit / 35 e2e / integration 61 suites; web 1,126 unit / 189 e2e; liff 707 unit / 116 e2e).
How it runs: each step in its own subagent on the sandbox copies (Node 24, embedded PostgreSQL 18), one at a time (API steps share migrations; the sandbox has 7 GB, so repos do not run test suites in parallel either). The orchestrator applies each green step on the Mac and commits it as Superball, no trailers, no push.

| Step | Repo | Status | Commit (Mac) | Contract (api) | O-### opened | Notes |
|---|---|---|---|---|---|---|
| G0 | api | done | aabd83b | unchanged (650 paths) | O-022…O-029 | D-284…D-291; docs only |
| G1 | api | done | f44bf20 | 661 paths (+11) | — | D-292; unit 547, e2e 35, int 441; core.document guard deferred (needs asset-core) |
| G2 | api + asset-core | running | | | | |
| G3 | api | todo | | | | |
| G7 | api | todo | | | | |
| G4 | api | todo | | | | |
| G5 | api | todo | | | | |
| G8 | api | todo | | | | |
| G6 | api | todo | | | | |
| G9 | api | todo | | | | |
| GW1 | web | todo | | | | |
| GW2 | web | todo | | | | |
| GW3 | web | todo | | | | |
| GW4 | web | todo | | | | |
| GW5 | web | todo | | | | |
| GW6 | web | todo | | | | |
| GL1 | liff | todo | | | | |
| GL2 | liff | todo | | | | |
| GL3 | liff | todo | | | | |
| GL4 | liff | todo | | | | |
| Review | all | todo | | | | |
