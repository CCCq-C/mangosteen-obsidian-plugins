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

- H3: exact adapter replay used `first_image` and `last_image`, omitted `ratio`, and excluded `referenceImages`; live storage redacts signed frame URLs by design.
- Seedance: completed live payload stored two `referenceImages` and no first/last frame fields.
- Sanitized evidence contains no credentials, account data, task identifiers, or temporary URLs.
