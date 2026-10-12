# Fixed-character video generation — live acceptance (2026-10-11)

## Result

- Source and installed Node suites: 9/9 test files passed.
- Reusable assets: one character board and one harbor scene, shared by both projects.
- The original two 4-second video submissions reached `completed`: `MiniMax-H3` and `seedance-2.5`.
- One bounded H3 acceptance rerun also reached `completed` after sanitized request-shape persistence was enabled.
- No source-video screenshot was used as a generation reference.

## Organized media cockpit release gate (2026-10-12)

- Release versions: `mangosteen-image` 5.3.27, `mangosteen-video` 5.3.25, and `mangosteen-video-replica` 1.2.0.
- Source and installed regressions: all 27 plugin test files passed; both deployment-script tests passed; the source/installed allow-list hashes matched 60/60.
- The real active-generation gate returned `ACTIVE 0 []` immediately before deployment. A fresh pre-sync backup was saved at `/Users/ziyan/ObsidianVaults/.obsidian/mangosteen-plugin-backups/20261012T111416+0800-591577fc`.
- Obsidian 1.14.4 was reloaded after those gates passed. The existing 10-shot project reopened as 10/10 complete; 山竹出图 and 山竹视频 both opened and loaded account balance plus model choices without a plugin-load error.
- The cockpit was visually checked at 1199 px, 719 px, and 358 px content widths without horizontal overflow. The queue collapses to its compact selector at the narrower widths.
- Queued and processing shots now share one lock rule in the ViewModel, UI, and save boundary; non-queued shots remain selectable and editable. The active-run disabled state for “整理当前项目” is regression-tested, but no live active task was created solely to exercise that state.
- Migration execution remains **fail-closed**. The current Obsidian Node runtime does not provide a vetted descriptor-relative `openat/*at` filesystem capability, so migration is limited to read-only preview and must not be described as executable offline migration.
- No old file was moved or reorganized. Existing projects remain readable without automatic migration.
- At the original release gate no paid task was run. The explicitly approved one-shot billed acceptance was completed later on 2026-10-12; see the section below.

## Live outputs

| Model | Requested | Returned media | Platform cost | Vault output |
|---|---:|---|---:|---|
| `MiniMax-H3` | 4 s, 768p | 4.458 s, 768×768, H.264, 24 fps | $0.8712 | `山竹视频复刻/固定人物流程测试-H3-2026-10-11/03-视频片段/镜头-001-走向集装箱.mp4` |
| `seedance-2.5` | 4 s, 720p, 9:16 | 4.064 s, 720×1280, H.264, 24 fps | $4.0920 | `山竹视频复刻/固定人物流程测试-Seedance-2026-10-11/03-视频片段/镜头-001-转身看向海面.mp4` |
| `MiniMax-H3` final evidence rerun | 4 s, 768p | 4.458 s, 768×768, H.264, 24 fps | $0.8712 | `山竹视频复刻/固定人物流程最终验收-H3-2026-10-11/03-视频片段/镜头-001-走向集装箱.mp4` |

Shared asset IDs:

- Character: `mvp-harbor-hero-v1`
- Scene: `mvp-harbor-scene-v1`

## Sanitized input evidence

- The completed H3 live task store proves the selected model, duration, resolution, terminal state, and that its retained payload contains neither `ratio` nor `referenceImages`. The saved project also contains the exact local first/last keyframes used by the workflow.
- Retroactive on-wire presence of H3 `first_image` and `last_image` cannot be proved: the then-installed task store intentionally removed those signed fields and did not yet persist a sanitized request shape. Exact adapter replay shows the expected mapping, but is supporting inference rather than live transport proof.
- Seedance's completed live task store contained `referenceImages` with two entries and contained neither `first_image` nor `last_image`.
- Future accepted requests persist only sanitized request-shape metadata: field names, field-presence booleans, and reference counts. Media URLs, API keys, Authorization headers, account identifiers, and task identifiers are excluded from acceptance evidence.
- The final H3 acceptance rerun persisted direct transport-shape evidence: `hasFirstImage=true`, `hasLastImage=true`, `hasRatio=false`, `hasGenerateAudio=false`, and all reference-media counts equal to zero.

## Visual inspection

- Character: short black hair, off-white jacket, navy cargo trousers, and white shoes remained recognizable in both model outputs.
- Scene: blue containers remained left, sea remained right, and the lighthouse/sunset remained visible.
- H3 kept the character and harbor stable during forward movement, but the square frame and mostly rear/side face limit facial-identity assessment.
- Seedance completed a continuous turn toward the sea with stable clothing and background; framing moved closer than the keyframes.

## Live defects fixed during acceptance

1. `mangosteen-image/main.js`: a valid platform image task exceeded the old 180-second wait and was marked failed locally. The wait is now 15 minutes with a regression test. The already accepted task was polled to completion instead of resubmitted.
2. `mangosteen-video-replica/main.js`: unchanged retries now reuse fingerprint-matched saved keyframes and completed videos. The fingerprint covers character, scene, prompts, model, duration, effective ratio/resolution, and reference mode; missing mandatory keyframes force bounded regeneration instead of stale video reuse.
3. `mangosteen-video/main.js`: temporary-upload failures now include a safe machine code without exposing credentials or URLs.
4. `mangosteen-video/main.js`: future accepted tasks persist a sanitized transport request shape and remove all temporary media URL arrays from retained payloads.

One extra first-frame image task was accepted before a full Obsidian restart loaded the retry-safe code. It cost $0.02835. No duplicate H3 or Seedance video submission occurred.

## Remaining limits

- H3 frame mode returned 768×768 because the API requires ratio omission with first/last frames.
- The first H3 call predates request-shape persistence; the bounded final H3 rerun supplies the missing direct field-presence evidence without altering earlier outputs.
- Two short, single-character shots do not establish long-form or multi-character identity locking.
- Two completed image tasks had not yet received matched usage cost at inspection time; they are recorded as unknown, not zero.

## Organized cockpit billed acceptance (2026-10-12)

- Project: `山竹视频复刻/付费验收-新版稳定存储-2026-10-12`.
- Run: `run_3ddc20032e7454191c3813509bc66562f8106cd5f52afa42a403bdb09139e891`; terminal state `completed`; one selected shot, one completed, zero failed.
- First frame: task `task_Qy4Ul4kTgRUmTHksiG31DnGuns9HqEuf`; cost `$0.02835`; saved to `03-分镜/001/首帧.png`; SHA-256 `6292e780a49b0e2f998fe13eaed884a8c0b16bc988337927661f4dcf41d84b1f`.
- Video: task `task_gFgLkbeeuaz4tsQJp3aVwhmM4ZZhZH3u`; usage request `202610120633421018607128268d9d69YxH6yS5`; MiniMax-H3, requested 4 seconds at 768p with one first-image reference; cost `$0.8712`.
- Shot output: `03-分镜/001/视频.mp4`; 3,054,084 bytes; 4.458333 seconds; 768×832, H.264/AAC, 24 fps; SHA-256 `17ddb535598b8e2f1e8b45ff3a290431144dbd6c185a9f82ac526bfc605f692e`.
- Final output: `04-最终成片/最终成片.mp4`; 3,053,501 bytes; 4.490315 seconds; 768×832, H.264/AAC, 24 fps; SHA-256 `d8d19fa7bfc1ccdcfed77e75bcee56cf118363623e45acc9b612b64a435b88a6`.
- Total billed cost: `$0.89955`. Exactly one first-frame task and one video task were submitted; no duplicate video was created.
- Restart recovery was exercised between first-frame submission and video continuation. The completed image was reused from its exact durable output target and the queue continued without a duplicate paid image request.
- Follow-up hardening persists the exact resolved runtime fingerprint before a paid frame request, retries transient model-catalog startup races, periodically reconciles completed image reservations, and exposes the latest archived task ID without reactivating the completed queue.
- Post-fix verification: video-replica 19/19, image 4/4, video 4/4, deployment scripts 2/2, plus `git diff --check`.
