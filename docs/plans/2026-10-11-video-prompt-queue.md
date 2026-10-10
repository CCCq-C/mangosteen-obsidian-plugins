# Video Prompt Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add editable final video-prompt resolution and per-shot confirmed generation queues without changing the workbench UI.

**Architecture:** Keep draft fields as the source of truth and resolve an effective prompt through an optional override. Build immutable, hash-validated generation plans, then execute confirmed selected-shot snapshots sequentially through an injected runner callback so the queue stays independent from Obsidian and provider plugins.

**Tech Stack:** CommonJS, Node.js built-ins (`assert`, `crypto`), existing plugin policy/core modules.

---

### Task 1: Final video prompt resolution

**Files:**
- Modify: `plugins/mangosteen-video-replica/generation-policy.cjs`
- Modify: `plugins/mangosteen-video-replica/replica-core.cjs`
- Modify: `plugins/mangosteen-video-replica/replica-editor.cjs`
- Test: `plugins/mangosteen-video-replica/tests/generation-policy.test.cjs`
- Test: `plugins/mangosteen-video-replica/tests/replica-core.test.cjs`
- Test: `plugins/mangosteen-video-replica/tests/replica-editor.test.cjs`

**Step 1:** Add failing tests for `videoPromptOverride`, effective prompt resolution, normalization, and fingerprint invalidation.

**Step 2:** Run the three focused test files and verify the new assertions fail.

**Step 3:** Add `resolveVideoPrompt`, preserve `videoPromptOverride` through normalization, permit editing it, and fingerprint the effective prompt.

**Step 4:** Run the focused tests and verify they pass.

**Step 5:** Commit the prompt-resolution change.

### Task 2: Immutable selected-shot plans

**Files:**
- Create: `plugins/mangosteen-video-replica/generation-queue.cjs`
- Create: `plugins/mangosteen-video-replica/tests/generation-queue.test.cjs`

**Step 1:** Add failing tests for empty selection, unknown IDs, draft-order sorting, automatic and overridden prompts, immutable snapshots, and stable plan IDs.

**Step 2:** Run `node plugins/mangosteen-video-replica/tests/generation-queue.test.cjs` and verify it fails because the module does not exist.

**Step 3:** Implement `prepareGenerationPlan` with selected-shot validation, deep-cloned snapshots, effective prompts, and SHA-256 request signatures.

**Step 4:** Implement `confirmGenerationPlan` so a changed selected shot, character voice profile, or generation setting rejects the stale plan.

**Step 5:** Run the queue test and commit the planning layer.

### Task 3: Per-shot locks and sequential runner

**Files:**
- Modify: `plugins/mangosteen-video-replica/generation-queue.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/generation-queue.test.cjs`

**Step 1:** Add failing tests for selected-only locks, duplicate queue rejection, sequential execution, continue-on-shot-failure, stop-before-next-shot, and unlocked editing after terminal states.

**Step 2:** Run the focused test and verify failures.

**Step 3:** Implement queue creation, lock lookup, next-shot transitions, stop requests, and `runGenerationQueue(queue, runShot)`.

**Step 4:** Run the focused test and verify all queue cases pass.

**Step 5:** Commit the queue runner.

### Task 4: Stable integration contract

**Files:**
- Create: `plugins/mangosteen-video-replica/replica-logic-api.cjs`
- Create: `plugins/mangosteen-video-replica/tests/replica-logic-api.test.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/plugin-load.test.cjs`

**Step 1:** Add failing tests for the logic-only API exported to the future UI.

**Step 2:** Implement a small facade exposing preview, confirm, queue, lock, stop, and run methods without importing Obsidian.

**Step 3:** Run focused tests, then run every plugin test.

**Step 4:** Verify `git diff --check` and confirm no UI or style file changed.

**Step 5:** Commit the integration contract and provide the UI handoff field/method list.

