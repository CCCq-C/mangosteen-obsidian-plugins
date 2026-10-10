# Fixed-character video generation — live acceptance (2026-10-11)

## Result

- Source and installed Node suites: 9/9 test files passed.
- Reusable assets: one character board and one harbor scene, shared by both projects.
- Exactly two 4-second video submissions reached `completed`: `MiniMax-H3` and `seedance-2.5`.
- No source-video screenshot was used as a generation reference.

## Live outputs

| Model | Requested | Returned media | Platform cost | Vault output |
|---|---:|---|---:|---|
| `MiniMax-H3` | 4 s, 768p | 4.458 s, 768×768, H.264, 24 fps | $0.8712 | `山竹视频复刻/固定人物流程测试-H3-2026-10-11/03-视频片段/镜头-001-走向集装箱.mp4` |
| `seedance-2.5` | 4 s, 720p, 9:16 | 4.064 s, 720×1280, H.264, 24 fps | $4.0920 | `山竹视频复刻/固定人物流程测试-Seedance-2026-10-11/03-视频片段/镜头-001-转身看向海面.mp4` |

Shared asset IDs:

- Character: `mvp-harbor-hero-v1`
- Scene: `mvp-harbor-scene-v1`

## Sanitized input evidence

- H3 deterministic replay of the exact installed adapter and saved local keyframes produced `first_image` and `last_image`, omitted `ratio`, and did not produce `referenceImages`.
- The H3 live task store intentionally removes signed frame URLs after submission. The acceptance evidence records field presence only.
- Seedance's completed live task store contained `referenceImages` with two entries and contained neither `first_image` nor `last_image`.
- Evidence files contain no API key, Authorization header, signed URL, account identifier, or task identifier.

## Visual inspection

- Character: short black hair, off-white jacket, navy cargo trousers, and white shoes remained recognizable in both model outputs.
- Scene: blue containers remained left, sea remained right, and the lighthouse/sunset remained visible.
- H3 kept the character and harbor stable during forward movement, but the square frame and mostly rear/side face limit facial-identity assessment.
- Seedance completed a continuous turn toward the sea with stable clothing and background; framing moved closer than the keyframes.

## Live defects fixed during acceptance

1. `mangosteen-image/main.js`: a valid platform image task exceeded the old 180-second wait and was marked failed locally. The wait is now 15 minutes with a regression test. The already accepted task was polled to completion instead of resubmitted.
2. `mangosteen-video-replica/main.js`: unchanged retries now reuse deterministic saved keyframes and completed videos. Tests prove retries do not create duplicate image or video work.
3. `mangosteen-video/main.js`: temporary-upload failures now include a safe machine code without exposing credentials or URLs.

One extra first-frame image task was accepted before a full Obsidian restart loaded the retry-safe code. It cost $0.02835. No duplicate H3 or Seedance video submission occurred.

## Remaining limits

- H3 frame mode returned 768×768 because the API requires ratio omission with first/last frames.
- Two short, single-character shots do not establish long-form or multi-character identity locking.
- Two completed image tasks had not yet received matched usage cost at inspection time; they are recorded as unknown, not zero.
