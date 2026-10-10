# SDD ledger — plan: docs/plans/2026-10-10-fixed-character-video-generation.md

## Pre-flight scan

| Tasks | Producer -> consumer | Finding |
|---|---|---|
| 1 -> 2-7 | Canonical source files -> all implementation tasks | Clean; Task 1 must copy exact current runnable code before edits. |
| 2 -> 4 | Payload capability validation -> local reference upload | Clean; Task 4 must submit URLs only after upload. |
| 2 -> 5 | Video model rules -> replica model policy | Potential duplication; ruling below. |
| 3 -> 6 | Multi-image edit API -> asset-driven keyframe generation | Clean; existing single-image method remains compatible. |
| 5 -> 6 | Pure model adapter -> orchestration | Clean; no HTTP or file I/O in policy module. |
| 6 -> 7 | Asset workflow -> end-to-end mock cases | Clean. |
| 7 -> 8 | Deployed tested code -> live acceptance | Clean; no live call before local suite passes. |
| 1 | Internal consistency | Clean; only allow-listed files are imported, user data and binaries excluded. |
| 2 | Internal consistency | Clean; generic non-replica model behavior remains intact. |
| 3 | Internal consistency | Clean; tests precede implementation and one-image behavior is preserved. |
| 4 | Internal consistency | Clean; uploads stop before paid request on failure. |
| 5 | Internal consistency | Clean; model filtering is limited to video-replica. |
| 6 | Internal consistency | Clean; reference assets are reusable and source-video screenshots are excluded. |
| 7 | Internal consistency | Clean; deployment preserves data.json, runtimes, models, and assets. |
| 8 | Internal consistency | Clean; real testing is bounded to two 4-second tasks and secrets remain internal. |

Ruling: Task 2 owns transport-level API legality; Task 5 owns workflow-level model selection and mapping — this prevents duplicated business logic while keeping trust-boundary validation — if wrong, one rule could need relocation but public interfaces stay unchanged.
Task 1: complete (commits 933fc43..c16ff43, review clean)
Task 2: complete (commits c16ff43..22e85bb, review clean)
Task 3: complete (commits 22e85bb..29415f5, review clean)
Task 4: fix round 1/5 (2 addressed, 0 open; commits 4116ee8..076cb5e)
Task 4: complete (commits 29415f5..076cb5e, review clean)
Task 5: fix round 1/5 (1 addressed, 0 open; commits b36e9fd..8340634)
Task 5: complete (commits 076cb5e..8340634, review clean)
Task 6: complete (commits 8340634..ef90679, tests: full repository Node suite -> 8/8 pass, self-review clean)
Task 6: fix round 1/5 (2 addressed, 0 open; commits ef90679..b4f7d05, tests: full repository Node suite -> 8/8 pass)
Task 6: fix round 1/5 (2 addressed, 0 open; commits ef90679..b4f7d05)
Task 6: complete (commits 8340634..b4f7d05, review clean)
Task 7: fix round 1/5 (2 addressed, 0 open; commits ab8fe1c..151082a)
Task 7: complete (commits b4f7d05..151082a, review clean)
Task 8: fix round 1/5 (image task wait extended to 15 minutes; accepted task resumed without duplicate submission; regression added)
Task 8: fix round 2/5 (unchanged retries reuse saved keyframes/videos; safe upload diagnostic codes added; full Obsidian restart verified)
Task 8: complete (source and installed Node suites 9/9 pass; live MiniMax-H3 and seedance-2.5 tasks completed; sanitized acceptance evidence recorded)
Task 8: fix round 1/5 (review-requested: future sanitized transport request-shape persistence, deterministic generation fingerprints, and mandatory-keyframe recovery; source/installed suites 9/9 pass; no paid calls)
Task 8: fix round 1/5 (3 addressed, 0 open; commits 8858d5b..7f21a35)
Task 8: complete (commits 151082a..7f21a35, review clean)
Final review: changes requested; Task 8 acceptance pending (5 Important findings open at de0efc0)
Final review fix wave: code and tests prepared for paid-request uncertainty, processing leases, asset-content fingerprints, strict transport validation, and spec-compatible asset metadata.
Task 8 acceptance evidence complete: one bounded H3 rerun completed with sanitized request-shape proof; no automatic retry.
