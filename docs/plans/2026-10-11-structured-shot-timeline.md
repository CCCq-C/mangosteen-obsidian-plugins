# Structured Shot Timeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace duplicated per-shot prompt fields with a plot-driven structured timeline while preserving fixed-character references and model-specific image handling.

**Architecture:** Add a small `shot-timeline.cjs` domain module that validates, migrates, edits, and compiles timeline rows. Generation request v4 and the queue snapshot carry the normalized timeline; MiniMax H3 derives one automatic first frame, while Seedance 2.5 submits the character, scene, and product assets directly as reference images.

**Tech Stack:** Obsidian plugin JavaScript, CommonJS modules, Node `assert` tests, JSON Schema.

---

### Task 1: Timeline domain module

**Files:**
- Create: `plugins/mangosteen-video-replica/shot-timeline.cjs`
- Create: `plugins/mangosteen-video-replica/tests/shot-timeline.test.cjs`

**Step 1: Write the failing test**

Cover dynamic segments, gap/overlap rejection, first/last boundary checks, legacy single-row migration, and prompt compilation.

**Step 2: Run test to verify it fails**

Run: `node plugins/mangosteen-video-replica/tests/shot-timeline.test.cjs`

Expected: FAIL because `shot-timeline.cjs` does not exist.

**Step 3: Write minimal implementation**

Export:

```js
module.exports = {
  compileTimelinePrompt,
  firstFramePrompt,
  legacyTimeline,
  normalizeTimeline,
};
```

Use an epsilon of `0.001` for adjacent numeric boundaries. Keep segment fields limited to `start`, `end`, `action`, `dialogue`, `performance`, `camera`, and `environment`.

**Step 4: Run test to verify it passes**

Run: `node plugins/mangosteen-video-replica/tests/shot-timeline.test.cjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/shot-timeline.cjs plugins/mangosteen-video-replica/tests/shot-timeline.test.cjs
git commit -m "feat: add structured shot timeline domain"
```

### Task 2: Request v4 and AI analysis

**Files:**
- Modify: `plugins/mangosteen-video-replica/video-analysis-schema.json`
- Modify: `plugins/mangosteen-video-replica/replica-cli.cjs`
- Modify: `plugins/mangosteen-video-replica/replica-core.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/replica-cli.test.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/replica-core.test.cjs`

**Step 1: Write the failing tests**

Assert that the analysis schema requires `timeline`, the prompt says time ranges are plot-driven rather than fixed, `buildGenerationDraft` emits version 4, and old v3 requests migrate to one timeline row.

**Step 2: Run tests to verify they fail**

Run:

```bash
node plugins/mangosteen-video-replica/tests/replica-cli.test.cjs
node plugins/mangosteen-video-replica/tests/replica-core.test.cjs
```

Expected: FAIL on missing timeline/version 4 behavior.

**Step 3: Write minimal implementation**

- Change AI shot schema to require `timeline` instead of per-shot image/video prompt fields.
- Instruct the model to create contiguous, plot-driven time ranges covering each shot.
- Support request versions 1 through 4.
- Normalize v4 timelines strictly; convert v1-v3 flat fields with `legacyTimeline`.
- Keep legacy fields internally only where old projects require them.

**Step 4: Run tests to verify they pass**

Run the two tests above. Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/video-analysis-schema.json plugins/mangosteen-video-replica/replica-cli.cjs plugins/mangosteen-video-replica/replica-core.cjs plugins/mangosteen-video-replica/tests/replica-cli.test.cjs plugins/mangosteen-video-replica/tests/replica-core.test.cjs
git commit -m "feat: analyze shots as dynamic timelines"
```

### Task 3: Immutable compiled timeline prompts

**Files:**
- Modify: `plugins/mangosteen-video-replica/generation-policy.cjs`
- Modify: `plugins/mangosteen-video-replica/generation-queue.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/generation-policy.test.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/generation-queue.test.cjs`

**Step 1: Write the failing tests**

Assert that a v4 timeline compiles into ordered time blocks, includes the fixed voice profile once, preserves exact dialogue, and changes the generation fingerprint when a row changes.

**Step 2: Run tests to verify they fail**

Run the policy and queue tests. Expected: FAIL because timelines are ignored.

**Step 3: Write minimal implementation**

- Let `resolveVideoPrompt` and `composeVideoPrompt` accept `timeline` and `duration`.
- Prefer `videoPromptOverride`, then compiled timeline, then legacy `videoPrompt`.
- Include normalized timeline in generation fingerprints and immutable queue plans.

**Step 4: Run tests to verify they pass**

Run the same tests. Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/generation-policy.cjs plugins/mangosteen-video-replica/generation-queue.cjs plugins/mangosteen-video-replica/tests/generation-policy.test.cjs plugins/mangosteen-video-replica/tests/generation-queue.test.cjs
git commit -m "feat: compile timelines into immutable video prompts"
```

### Task 4: Model-adaptive references

**Files:**
- Modify: `plugins/mangosteen-video-replica/generation-policy.cjs`
- Modify: `plugins/mangosteen-video-replica/main.js`
- Modify: `plugins/mangosteen-video-replica/tests/generation-policy.test.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/plugin-load.test.cjs`

**Step 1: Write the failing tests**

Assert that MiniMax H3 receives one generated first frame and no default last frame, while Seedance 2.5 receives the character, scene, and product files as `referenceImageFiles` without generating shot frames.

**Step 2: Run tests to verify they fail**

Run the policy and plugin-load tests. Expected: FAIL because the queue runner always generates a first frame.

**Step 3: Write minimal implementation**

- Extend `buildVideoOptions` with explicit `referenceImageFiles` for Seedance.
- In the selected-shot runner, branch by model family.
- For MiniMax H3 derive the first-frame prompt from the first timeline row plus continuity rules.
- For Seedance pass reference assets directly and leave frame paths empty.
- Keep legacy runner behavior for already confirmed old queues.

**Step 4: Run tests to verify they pass**

Run the same tests. Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/generation-policy.cjs plugins/mangosteen-video-replica/main.js plugins/mangosteen-video-replica/tests/generation-policy.test.cjs plugins/mangosteen-video-replica/tests/plugin-load.test.cjs
git commit -m "feat: adapt references to selected video model"
```

### Task 5: Structured timeline editor

**Files:**
- Modify: `plugins/mangosteen-video-replica/replica-editor.cjs`
- Modify: `plugins/mangosteen-video-replica/replica-workbench.cjs`
- Modify: `plugins/mangosteen-video-replica/styles.css`
- Modify: `plugins/mangosteen-video-replica/tests/replica-editor.test.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/replica-workbench.test.cjs`

**Step 1: Write the failing tests**

Assert that timeline rows render, all seven fields are editable, rows can be added and removed, invalid timing blocks save/generate, and obsolete frame prompt inputs are absent.

**Step 2: Run tests to verify they fail**

Run the editor and workbench tests. Expected: FAIL because the old flat controls still render.

**Step 3: Write minimal implementation**

- Render compact timeline cards inside each shot.
- Add row and delete row actions using existing button/input patterns.
- Use the existing immutable draft update path.
- Show one read-only compiled prompt preview.
- Preserve responsive layout and shot-level edit locks.

**Step 4: Run tests to verify they pass**

Run the same tests. Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/replica-editor.cjs plugins/mangosteen-video-replica/replica-workbench.cjs plugins/mangosteen-video-replica/styles.css plugins/mangosteen-video-replica/tests/replica-editor.test.cjs plugins/mangosteen-video-replica/tests/replica-workbench.test.cjs
git commit -m "feat: edit shot timelines in the cockpit"
```

### Task 6: Integration verification and safe deployment

**Files:**
- Modify: `docs/integration/video-prompt-queue-ui-handoff.md`
- Test: all tests under `plugins/mangosteen-image/tests`, `plugins/mangosteen-video/tests`, and `plugins/mangosteen-video-replica/tests`

**Step 1: Update integration documentation**

Document v4 timeline rows, compiled prompt preview, MiniMax H3 automatic first frame, and Seedance direct references.

**Step 2: Run all tests**

```bash
find plugins/mangosteen-image/tests plugins/mangosteen-video/tests plugins/mangosteen-video-replica/tests -type f -name '*.test.cjs' -print | sort | while read f; do node "$f" || exit 1; done
```

Expected: every test file passes.

**Step 3: Check repository quality**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intended files changed.

**Step 4: Commit**

```bash
git add docs/integration/video-prompt-queue-ui-handoff.md
git commit -m "docs: document structured timeline generation"
```

**Step 5: Deploy only after the active paid queue is terminal**

Do not overwrite or reload the live plugin while `.work/generation-queue.json` is processing. After completion, copy the changed plugin files, verify hashes, run the live tests, and reload `mangosteen-video-replica` once.
