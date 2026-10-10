# Fixed Character Video Generation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build one end-to-end Obsidian workflow that turns a prompt or script plus reusable character and scene assets into consistent video shots using only MiniMax-H3 or Seedance.

**Architecture:** The image plugin owns multi-image editing, the video plugin owns uploads and API-valid payloads, and the replica plugin owns asset orchestration and model selection through a small model-policy adapter. Model-specific behavior is data-driven and isolated so a future model is added by extending one capability table plus one adapter branch, not by rewriting the workflow.

**Tech Stack:** Obsidian desktop plugins, CommonJS, Node.js standard library, AIHubKit `/v1/images/edits/tasks` and `/v1/videos`, assert-based Node tests.

---

## Working locations

- Canonical source worktree: `/Users/ziyan/.codex/worktrees/mangosteen-fixed-character-video`
- Current runnable vault: `/Users/ziyan/ObsidianVaults`
- Installed plugins: `/Users/ziyan/ObsidianVaults/.obsidian/plugins`
- Never copy or commit `data.json`, API keys, cookies, generated media, Whisper models, or bundled FFmpeg binaries.

### Task 1: Establish canonical plugin source without user data

**Files:**
- Create: `plugins/mangosteen-image/{main.js,image-api.cjs,manifest.json,styles.css}`
- Create: `plugins/mangosteen-video/{main.js,video-api.cjs,manifest.json,styles.css}`
- Create: `plugins/mangosteen-video-replica/{main.js,replica-core.cjs,replica-cli.cjs,manifest.json,styles.css}`
- Create: `plugins/mangosteen-video-replica/tests/*.test.cjs`
- Create: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Copy only code and tests from the current runnable plugins**

Run a fixed allow-list copy from `/Users/ziyan/ObsidianVaults/.obsidian/plugins`. Do not copy `data.json`, models, runtimes, logs, or media.

**Step 2: Write the deployment script**

The script must accept an optional vault path, default to `/Users/ziyan/ObsidianVaults`, copy only the allow-listed code files, and refuse a target without `.obsidian/plugins`.

**Step 3: Run baseline replica tests**

Run:

```bash
node plugins/mangosteen-video-replica/tests/replica-core.test.cjs
node plugins/mangosteen-video-replica/tests/replica-cli.test.cjs
node plugins/mangosteen-video-replica/tests/plugin-load.test.cjs
```

Expected: all three print `ok`.

**Step 4: Verify secrets are absent**

Run:

```bash
! find plugins -name data.json -o -name '*.bin'
! rg -n 'session=|Bearer [A-Za-z0-9]|sk-[A-Za-z0-9]' plugins
```

Expected: both commands succeed with no matches.

**Step 5: Commit**

```bash
git add plugins scripts/sync-plugin-code-to-vault.sh
git commit -m "chore: add canonical plugin sources"
```

### Task 2: Enforce API-valid video payloads

**Files:**
- Modify: `plugins/mangosteen-video/video-api.cjs`
- Create: `plugins/mangosteen-video/tests/video-api.test.cjs`

**Step 1: Write failing payload tests**

Cover these exact cases:

```js
assert.deepStrictEqual(api.createVideoPayload({
  model: "MiniMax-H3", prompt: "move", duration: 4,
  ratio: "9:16", resolution: "768p", firstImage: "https://x/first.png"
}), {
  model: "MiniMax-H3", prompt: "move", duration: 4,
  resolution: "768p", first_image: "https://x/first.png"
});

assert.throws(() => api.createVideoPayload({
  model: "MiniMax-H3", prompt: "move", duration: 4, resolution: "768p",
  firstImage: "https://x/first.png", referenceImages: ["https://x/person.png"]
}), /不能同时使用/);

assert.throws(() => api.createVideoPayload({
  model: "seedance-2.5", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p",
  firstImage: "https://x/first.png"
}), /Seedance.*参考图片/);
```

Also assert that Seedance 2.0 accepts at most 9 reference images and Seedance 2.5 accepts at most 30.

**Step 2: Run the test and verify failure**

Run: `node plugins/mangosteen-video/tests/video-api.test.cjs`

Expected: FAIL because incompatible fields are currently accepted.

**Step 3: Implement one capability table**

Add one exported model-family resolver and capability table. Keep transport-independent rules in `video-api.cjs`:

- `minimax-h3`: frame mode, first/last allowed, all reference arrays forbidden, omit ratio.
- `seedance-2.0`: reference mode, maximum 9 images.
- `seedance-2.5`: reference mode, maximum 30 images.
- Other models retain existing generic behavior outside video-replica.

Validate conflicts before returning the payload.

**Step 4: Run tests**

Expected: new video API test passes.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video
git commit -m "fix: validate model-specific video inputs"
```

### Task 3: Add backward-compatible multi-image editing

**Files:**
- Modify: `plugins/mangosteen-image/image-api.cjs`
- Modify: `plugins/mangosteen-image/main.js`
- Create: `plugins/mangosteen-image/tests/image-api.test.cjs`

**Step 1: Write a failing multipart test**

Add a pure helper test that builds a multipart body for three images and asserts that `name="image[]"` occurs three times while model, prompt, size, quality, and output format occur once.

**Step 2: Run the test and verify failure**

Run: `node plugins/mangosteen-image/tests/image-api.test.cjs`

Expected: FAIL because no reusable multipart builder accepts arrays.

**Step 3: Implement the minimal API**

- Add `buildImageEditMultipart(fields, boundary)` to `image-api.cjs`.
- Accept either `image` or `images`; normalize to an array of 1–4 local image objects.
- Add `generateEditMulti(prompt, images)` in `main.js`.
- Keep `generateEdit(prompt, image)` and delegate to `generateEditMulti(prompt, [image])`.
- Keep the existing 20 MB per-image boundary check.

**Step 4: Run image and existing plugin tests**

Expected: multipart test passes and existing single-image behavior remains valid.

**Step 5: Commit**

```bash
git add plugins/mangosteen-image
git commit -m "feat: support multi-image edit references"
```

### Task 4: Upload local Seedance reference images

**Files:**
- Modify: `plugins/mangosteen-video/main.js`
- Create: `plugins/mangosteen-video/tests/video-plugin.test.cjs`

**Step 1: Write a failing plugin test**

Mock the account bridge `uploadTemporaryImage`, call `submitVideo` with two `referenceImageFiles`, and assert:

- both files upload exactly once;
- the final payload contains two HTTPS URLs in `referenceImages`;
- no local file object reaches `sendVideoPayload`;
- upload failure stops before the paid video request.

**Step 2: Run the test and verify failure**

Run: `node plugins/mangosteen-video/tests/video-plugin.test.cjs`

Expected: FAIL because only first/last local images are uploaded today.

**Step 3: Implement shared temporary-image upload**

Add one private upload method used by first frame, last frame, and reference image files. `submitVideo` accepts `referenceImageFiles` while preserving existing URL inputs.

**Step 4: Run video tests**

Expected: API and plugin tests pass.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video
git commit -m "feat: upload local video reference images"
```

### Task 5: Isolate replica model selection and request mapping

**Files:**
- Create: `plugins/mangosteen-video-replica/generation-policy.cjs`
- Create: `plugins/mangosteen-video-replica/tests/generation-policy.test.cjs`
- Modify: `plugins/mangosteen-video-replica/main.js`

**Step 1: Write failing policy tests**

Test:

- eligible models include only MiniMax-H3 and Seedance-compatible IDs returned by the current account;
- H3 maps a generated first frame and optional last frame to `firstImageFile` and `lastImageFile`;
- Seedance maps the same files to `referenceImageFiles`;
- Kling, Wan, and unknown models are rejected before any paid request.

**Step 2: Run and verify failure**

Run: `node plugins/mangosteen-video-replica/tests/generation-policy.test.cjs`

Expected: FAIL because the policy module does not exist.

**Step 3: Implement the pure adapter**

Export only:

```js
classifyModel(modelId)
eligibleModels(modelIds)
buildVideoOptions({ model, prompt, duration, ratio, resolution, firstImageFile, lastImageFile })
```

Do not place file I/O, UI, account lookup, or HTTP inside this module.

**Step 4: Run tests**

Expected: all policy and existing replica tests pass.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica
git commit -m "feat: isolate replica video model policy"
```

### Task 6: Add reusable character and scene assets

**Files:**
- Create: `plugins/mangosteen-video-replica/reference-assets.cjs`
- Create: `plugins/mangosteen-video-replica/tests/reference-assets.test.cjs`
- Modify: `plugins/mangosteen-video-replica/replica-core.cjs`
- Modify: `plugins/mangosteen-video-replica/main.js`

**Step 1: Write failing request and path tests**

Define request version 2:

```json
{
  "version": 2,
  "confirmed": true,
  "character": { "id": "hero", "prompt": "固定人物参考板" },
  "scenes": [{ "id": "harbor", "prompt": "海边集装箱场景" }],
  "settings": { "videoModel": "MiniMax-H3", "ratio": "9:16", "resolution": "768p" },
  "shots": [{
    "title": "人物走向集装箱",
    "sceneId": "harbor",
    "imagePrompt": "人物全身中景",
    "videoPrompt": "人物向前走，镜头缓慢推进",
    "duration": 4
  }]
}
```

Assert safe shared paths under `山竹视频资产库/人物/<id>` and `山竹视频资产库/场景/<id>`. Reject missing scene IDs, path traversal, unsupported models, and more than 12 shots. Preserve version-1 request compatibility.

**Step 2: Run and verify failure**

Expected: FAIL because the asset module and version-2 schema do not exist.

**Step 3: Implement asset resolution**

`reference-assets.cjs` owns only asset IDs, safe paths, existence checks, and metadata JSON. Generation stays in `main.js`.

In the workflow:

- reuse existing character/scene images when present;
- otherwise generate and save one character reference board and one reference image per scene;
- generate each shot first frame with `generateEditMulti` using character board plus scene image;
- generate an optional last frame only when `lastImagePrompt` exists;
- never add source-video screenshots.

**Step 4: Update dashboard output and run tests**

Show selected model, character asset, scene assets, first/last keyframes, and each video result in Obsidian.

Expected: replica core, asset, and plugin integration tests pass.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica
git commit -m "feat: generate shots from reusable reference assets"
```

### Task 7: End-to-end mock verification and vault deployment

**Files:**
- Modify: `plugins/mangosteen-video-replica/tests/plugin-load.test.cjs`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Add two mock end-to-end cases**

Run the same two-shot request through:

- MiniMax-H3: assert video calls contain first frame and optional last frame only.
- Seedance: assert video calls contain local reference image files only.

Assert that one character asset, one scene asset, two shot keyframes, and two video files are retained.

**Step 2: Run the full suite**

```bash
find plugins -path '*/tests/*.test.cjs' -print0 | sort -z | xargs -0 -n1 node
```

Expected: every test prints `ok` and exits 0.

**Step 3: Deploy code to the runnable vault**

```bash
./scripts/sync-plugin-code-to-vault.sh /Users/ziyan/ObsidianVaults
```

Expected: code files update; `data.json`, runtimes, models, and user assets remain unchanged.

**Step 4: Re-run tests from the installed plugin directories**

Expected: the same test suite passes against `/Users/ziyan/ObsidianVaults/.obsidian/plugins`.

**Step 5: Commit**

```bash
git add plugins scripts
git commit -m "test: verify fixed-character workflow end to end"
```

### Task 8: Minimal real API acceptance

**Files:**
- Create in vault: `山竹视频复刻/固定人物流程测试/generation-request.json`
- Generated in vault: `山竹视频资产库/**`
- Generated in vault: `山竹视频复刻/固定人物流程测试/**`

**Step 1: Read the live account catalog through the enabled plugins**

Confirm the exact available MiniMax-H3 and Seedance model IDs. Do not read, print, or export API keys.

**Step 2: Generate one reusable character asset and one scene asset**

Use a non-sensitive test prompt and verify both images are visible in Obsidian.

**Step 3: Generate two 4-second shots**

Use one H3 call and one actually available Seedance call. Keep the same character and scene; vary action and camera only.

**Step 4: Inspect output and request states**

Verify H3 used frame fields only, Seedance used reference images only, all assets are visible, and failures identify location, cause, and retry action.

**Step 5: Record acceptance**

Add `验收记录.md` to the test project with model IDs, outputs, observed consistency, cost returned by the platform, and any remaining limitation. Do not include secrets or temporary signed URLs.

## Completion gate

Do not declare completion until:

- all mock tests pass;
- current vault plugin code is deployed without overwriting user data;
- at least one real H3 task and one real Seedance task reach a terminal state;
- generated character, scene, keyframe, and video artifacts open in Obsidian;
- the request log proves model-specific fields did not conflict.
