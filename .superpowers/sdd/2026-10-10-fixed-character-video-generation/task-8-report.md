# Task 8 report — minimal real API acceptance

## Changes

- Extended asynchronous image-task waiting from 180 seconds to 15 minutes and added `image-plugin.test.cjs`.
- Added retry-safe keyframe/video checkpoint reuse for unchanged version-2 projects.
- Added safe temporary-upload diagnostic codes.
- Added live acceptance documentation and sanitized field evidence.

## Tests

- Source Node suite: 9/9 test files passed.
- Installed vault Node suite: 9/9 test files passed.
- New regressions prove a 91-poll image task completes and an unchanged retry does not regenerate keyframes or resubmit completed videos.

## Live terminal results

- `MiniMax-H3`: `completed`, 4-second request, output 4.458 seconds, platform cost $0.8712.
- `seedance-2.5`: `completed`, 4-second request, output 4.064 seconds, platform cost $4.0920.
- Both projects finished with `failedShots: 0`.

## Output paths

- `/Users/ziyan/ObsidianVaults/山竹视频资产库/人物/mvp-harbor-hero-v1/人物参考板.png`
- `/Users/ziyan/ObsidianVaults/山竹视频资产库/场景/mvp-harbor-scene-v1/场景参考图.png`
- `/Users/ziyan/ObsidianVaults/山竹视频复刻/固定人物流程测试-H3-2026-10-11/`
- `/Users/ziyan/ObsidianVaults/山竹视频复刻/固定人物流程测试-Seedance-2026-10-11/`

## Issues and bounded fixes

- Location: image plugin wait loop. Cause: valid image task exceeded 180 seconds. Fix: 15-minute polling window plus regression test; existing accepted task was resumed.
- Location: live Obsidian runtime. Cause: community-plugin refresh did not load the new running code. Fix: full Obsidian restart; one extra first-frame image task was recorded, but no duplicate video was submitted.
- Location: video temporary upload. Cause: old runtime returned a generic upload failure before paid submission. Fix: restart loaded current code; retry reused existing keyframes and succeeded. Diagnostic codes are now preserved safely.

## Request-field evidence

- H3: the completed live task proves model/duration/resolution/terminal state and retained absence of `ratio`/`referenceImages`; exact adapter replay maps the saved keyframes to `first_image`/`last_image`. Because the old live task store stripped signed frame fields and had no request-shape record, exact on-wire first/last presence is not retroactively provable.
- Seedance: completed live payload stored two `referenceImages` and no first/last frame fields.
- Sanitized evidence contains no credentials, account data, task identifiers, or temporary URLs.

## Task 8 fix round 1/5 — review-requested changes

- Added future transport-layer `requestShape` persistence containing field names, field-presence booleans, and reference counts only. Retained payloads now remove first/last-frame and all reference-media URLs.
- Replaced loose checkpoint comparisons with a SHA-256 generation fingerprint covering character ID/prompt, scene ID/prompt, image/last-image/video prompts, model, duration, effective ratio, effective resolution, and mandatory-reference mode. Legacy checkpoints without a fingerprint regenerate once rather than reuse stale output.
- A completed video is reusable only while every model-required keyframe still exists. The regression deletes a mandatory first keyframe and verifies that the keyframe and its video are regenerated.
- Source suite and installed-vault suite both pass 9/9 test files; eight changed allow-listed files have matching SHA-256 hashes after deployment.
- No paid image or video request was submitted in this fix round. Existing live videos and reusable assets were not modified; their pre/post SHA-256 hashes match.

## Final H3 evidence rerun

- A single additional 4-second H3 acceptance request reached `completed`; cost was `$0.8712`.
- Output: `/Users/ziyan/ObsidianVaults/山竹视频复刻/固定人物流程最终验收-H3-2026-10-11/03-视频片段/镜头-001-走向集装箱.mp4`.
- Persisted request shape directly proves `first_image` and `last_image` were present, while `ratio`, `generate_audio`, and all reference-media arrays were absent.
- No retry or duplicate submission was made.
