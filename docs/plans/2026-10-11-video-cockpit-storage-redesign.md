# 山竹视频制作驾驶舱与媒体存储根治 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将视频复刻升级为三栏制作驾驶舱，并让山竹生图、山竹视频和视频复刻通过统一输出目标直接保存媒体，消除单文件任务目录、二次复制和运行状态冲突。

**Architecture:** 山竹生图和山竹视频各自增加轻量的输出路径适配器，并把 `outputTarget` 随远程任务持久化。视频复刻新增版本 6 项目存储层和唯一 `active-run.json`，通过现有队列更新运行状态；驾驶舱只消费稳定 ViewModel。旧项目继续兼容，迁移采用“复制、哈希验证、原子切换、旧文件归档”的事务式流程。

**Tech Stack:** Obsidian Plugin API、CommonJS、Node.js `fs/path/crypto/assert`、原生 DOM API、CSS Container Queries。

**Spec:** `docs/superpowers/specs/2026-10-11-video-cockpit-storage-redesign.md`

---

## Global Constraints

- 实施代码位于 `/Users/ziyan/.codex/worktrees/mangosteen-video-cockpit-ui`，不要直接编辑 `/Users/ziyan/ObsidianVaults/.obsidian/plugins`。
- 当前真实项目仍有运行中的远程任务时，可以修改和测试源码，但禁止同步、重载或迁移真实 Vault。
- 不新增并发生成，不改变算力 API 请求字段、模型选择和付费请求哈希逻辑。
- `outputTarget` 是本地保存信息，不得进入远程请求 payload、供应商签名或日志中的敏感字段。
- 旧目录和旧 JSON 不自动删除；迁移、清理均需要用户明确确认。
- 每个任务先写失败测试，再写最小实现，再运行相关插件全部测试并提交。

## Test Commands

```bash
for test in plugins/mangosteen-image/tests/*.test.cjs; do node "$test"; done
for test in plugins/mangosteen-video/tests/*.test.cjs; do node "$test"; done
for test in plugins/mangosteen-video-replica/tests/*.test.cjs; do node "$test"; done
```

预期：每个测试打印对应的 `*: ok`，命令退出码为 `0`。

---

### Task 1: 为山竹生图增加稳定输出路径

**Files:**
- Create: `plugins/mangosteen-image/output-storage.cjs`
- Create: `plugins/mangosteen-image/tests/output-storage.test.cjs`
- Modify: `plugins/mangosteen-image/main.js:533-587, 691-716, 759-808`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Write the failing path tests**

覆盖以下行为：

```js
const {
  normalizeImageOutputTarget,
  standaloneImagePath,
} = require("../output-storage.cjs");

assert.deepStrictEqual(normalizeImageOutputTarget({
  owner: "video-replica",
  projectId: "project-1",
  shotId: "008",
  assetType: "first-frame",
  destinationPath: "山竹视频复刻/project-1/03-分镜/008/首帧.png",
}), {
  owner: "video-replica",
  projectId: "project-1",
  shotId: "008",
  assetType: "first-frame",
  destinationPath: "山竹视频复刻/project-1/03-分镜/008/首帧.png",
  overwrite: "replace-current",
});

assert.strictEqual(
  standaloneImagePath({ now: new Date("2026-10-11T07:00:51Z"), taskId: "task_abcd", index: 1, extension: "png" }),
  "山竹创作记录/图片/2026-10/20261011-150051-task_abcd-01.png",
);
assert.throws(() => normalizeImageOutputTarget({ destinationPath: "../outside.png" }), /输出路径不安全/);
assert.throws(() => normalizeImageOutputTarget({ destinationPath: "项目/视频.mp4" }), /图片扩展名/);
```

同时测试路径中的反斜杠、绝对路径、空段、`.`、`..`、NUL 字符和非图片扩展名均被拒绝。

**Step 2: Run the test and verify failure**

```bash
node plugins/mangosteen-image/tests/output-storage.test.cjs
```

Expected: FAIL with `Cannot find module '../output-storage.cjs'`.

**Step 3: Implement the pure path adapter**

导出：

```js
normalizeImageOutputTarget(target)
standaloneImagePath({ now, taskId, index, extension, timezoneOffsetMinutes = 480 })
```

实现要求：

- 只接受 Vault 相对路径。
- 目标扩展名限定为 `.png`、`.jpg`、`.jpeg`、`.webp`。
- 文件名中的任务 ID 只保留 `[A-Za-z0-9_-]`，最大 64 字符。
- 默认路径按 Asia/Shanghai 月份归档，不创建单任务子目录。
- 不在该纯函数中访问文件系统。

**Step 4: Persist `outputTarget` with image tasks**

在 `main.js` 中完成以下传递链：

```js
generateText(..., { model, outputTarget })
  -> submitImageTask({ ..., outputTarget })
  -> rememberImageTask({ ..., outputTarget })

generateEditMulti(..., { model, outputTarget })
  -> submitImageTask({ ..., outputTarget })
  -> rememberImageTask({ ..., outputTarget })
```

`rememberImageTask()` 保存规范化后的 `outputTarget`。同步返回和异步任务必须一致。

**Step 5: Make persistence destination-aware**

修改：

```js
persistGeneration({ candidates, prompt, mode, cost, model, taskId, outputTarget })
saveImageResult({ ..., outputTarget })
```

规则：

- 有 `outputTarget`：直接创建目标父目录并写入目标文件；不创建 `生图记录/<时间>/`，不向旧 `任务记录.md` 追加项目内部任务。
- 无 `outputTarget`：写入 `山竹创作记录/图片/YYYY-MM/`，多图使用同一任务 ID 和连续序号。
- `refreshImageTasksNow()` 调用 `saveImageResult()` 时必须传入 `task.outputTarget`。
- 保存成功后仍设置 `task.saved = true`、`task.imagePaths` 并清理对应 submission marker。
- 写入现有文件使用 `modifyBinary`；不存在时使用 `createBinary`。

**Step 6: Add plugin regression tests**

在 `image-plugin.test.cjs` 增加：

- `outputTarget` 不进入远程 JSON 或 multipart 字段。
- Obsidian 重启后，从持久化任务恢复并保存到相同项目路径。
- 项目任务保存完成后不会再次生成全局历史副本。
- 10 次独立单图任务仅使用月份目录，不产生 10 个单文件目录。
- 付费响应不确定时仍不重复提交。

**Step 7: Run image tests**

```bash
for test in plugins/mangosteen-image/tests/*.test.cjs; do node "$test"; done
```

Expected: all image tests pass.

**Step 8: Commit**

```bash
git add plugins/mangosteen-image scripts/sync-plugin-code-to-vault.sh
git commit -m "feat: support destination-aware image storage"
```

---

### Task 2: 为山竹视频增加稳定输出路径

**Files:**
- Create: `plugins/mangosteen-video/output-storage.cjs`
- Create: `plugins/mangosteen-video/tests/output-storage.test.cjs`
- Modify: `plugins/mangosteen-video/main.js:544-568, 620-669, 683-744`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Write the failing path tests**

```js
const {
  normalizeVideoOutputTarget,
  standaloneVideoPath,
} = require("../output-storage.cjs");

assert.strictEqual(
  normalizeVideoOutputTarget({
    owner: "video-replica",
    projectId: "project-1",
    shotId: "008",
    assetType: "shot-video",
    destinationPath: "山竹视频复刻/project-1/03-分镜/008/视频.mp4",
  }).destinationPath,
  "山竹视频复刻/project-1/03-分镜/008/视频.mp4",
);
assert.strictEqual(
  standaloneVideoPath({ now: new Date("2026-10-11T07:13:02Z"), taskId: "task_efgh" }),
  "山竹创作记录/视频/2026-10/20261011-151302-task_efgh.mp4",
);
assert.throws(() => normalizeVideoOutputTarget({ destinationPath: "/tmp/out.mp4" }), /输出路径不安全/);
```

**Step 2: Run the test and verify failure**

```bash
node plugins/mangosteen-video/tests/output-storage.test.cjs
```

Expected: missing module failure.

**Step 3: Implement the pure path adapter**

导出：

```js
normalizeVideoOutputTarget(target)
standaloneVideoPath({ now, taskId, timezoneOffsetMinutes = 480 })
```

仅允许 `.mp4`，并复用 Task 1 的路径安全规则。

**Step 4: Persist local output metadata without leaking it remotely**

在 `submitVideo(options)` 开始处提取并删除本地字段：

```js
const outputTarget = normalizeVideoOutputTarget(options.outputTarget);
const payloadOptions = { ...options };
delete payloadOptions.outputTarget;
```

将 `outputTarget` 只传给 `rememberVideoTask()`。断言：

- `videoSubmissionDescriptor()` 不包含本地路径。
- provider payload、request shape、submission fingerprint 均不包含 `outputTarget`。
- `rememberVideoTask()` 保留 `outputTarget`，同时继续移除签名媒体 URL。

**Step 5: Save completed media directly**

修改 `saveCompletedVideo(task, response)`：

- 有 `task.outputTarget`：直接保存到 `destinationPath`。
- 无目标：保存到月份目录，不再创建 `山竹视频/<taskId>/`。
- 目标已存在时原子覆盖当前文件，不创建带提示词的文件名。
- 返回最终 Vault 路径，并保存在 `task.localPath`。

**Step 6: Add plugin regression tests**

在 `video-plugin.test.cjs` 增加：

- 远程提交成功后 `outputTarget` 随任务保存。
- 重启恢复的任务保存到原项目路径。
- provider payload 与付费 fingerprint 不含本地路径。
- 10 个独立任务只写入月份目录。
- 下载失败保留已接受任务，不重复提交。

**Step 7: Run video tests**

```bash
for test in plugins/mangosteen-video/tests/*.test.cjs; do node "$test"; done
```

Expected: all video tests pass.

**Step 8: Commit**

```bash
git add plugins/mangosteen-video scripts/sync-plugin-code-to-vault.sh
git commit -m "feat: support destination-aware video storage"
```

---

### Task 3: 建立版本 6 项目存储层

**Files:**
- Create: `plugins/mangosteen-video-replica/project-storage.cjs`
- Create: `plugins/mangosteen-video-replica/tests/project-storage.test.cjs`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Write the failing layout tests**

```js
const storage = require("../project-storage.cjs");

assert.deepStrictEqual(storage.projectRelativePaths("山竹视频复刻/project-1"), {
  overview: "山竹视频复刻/project-1/00-项目总览.md",
  sourceRoot: "山竹视频复刻/project-1/01-原始素材",
  referenceIndex: "山竹视频复刻/project-1/02-参考资产/参考资产.md",
  shotRoot: "山竹视频复刻/project-1/03-分镜",
  finalRoot: "山竹视频复刻/project-1/04-最终成片",
  metadataRoot: "山竹视频复刻/project-1/.mangosteen",
  project: "山竹视频复刻/project-1/.mangosteen/project.json",
  draft: "山竹视频复刻/project-1/.mangosteen/draft.json",
  activeRun: "山竹视频复刻/project-1/.mangosteen/active-run.json",
  runs: "山竹视频复刻/project-1/.mangosteen/runs",
  history: "山竹视频复刻/project-1/.mangosteen/history",
});

assert.deepStrictEqual(storage.shotArtifactPaths("山竹视频复刻/project-1", "008"), {
  folder: "山竹视频复刻/project-1/03-分镜/008",
  firstFrame: "山竹视频复刻/project-1/03-分镜/008/首帧.png",
  lastFrame: "山竹视频复刻/project-1/03-分镜/008/尾帧.png",
  video: "山竹视频复刻/project-1/03-分镜/008/视频.mp4",
});
```

另测镜头标题变化不影响路径、非法镜头 ID 被拒绝、JSON 原子写失败时原文件保持不变。

**Step 2: Run and verify failure**

```bash
node plugins/mangosteen-video-replica/tests/project-storage.test.cjs
```

Expected: missing module failure.

**Step 3: Implement storage helpers**

导出：

```js
projectRelativePaths(folder)
shotArtifactPaths(folder, shotId)
createProjectLayout({ resolveSafe, folder })
readProjectDocument({ readJson, paths, legacyPaths })
atomicWriteJson({ resolveSafe, relativePath, value })
archiveCurrentArtifact({ resolveSafe, projectFolder, shotId, kind, now })
```

要求：

- 保留 `main.js` 现有真实路径和符号链接安全检查；模块通过注入的 `resolveSafe()` 获取绝对路径。
- `archiveCurrentArtifact()` 只在目标文件存在时移动到隐藏历史目录。
- 所有路径使用稳定项目 ID 和镜头 ID，不使用标题。

**Step 4: Add complete storage tests**

使用临时目录验证：创建目录、覆盖文件前归档、原子写、异常回滚和符号链接拒绝。

**Step 5: Run test**

```bash
node plugins/mangosteen-video-replica/tests/project-storage.test.cjs
```

Expected: `project-storage: ok`.

**Step 6: Commit**

```bash
git add plugins/mangosteen-video-replica/project-storage.cjs plugins/mangosteen-video-replica/tests/project-storage.test.cjs scripts/sync-plugin-code-to-vault.sh
git commit -m "feat: add version six project storage"
```

---

### Task 4: 将运行状态统一为 `active-run.json`

**Files:**
- Create: `plugins/mangosteen-video-replica/run-state.cjs`
- Create: `plugins/mangosteen-video-replica/tests/run-state.test.cjs`
- Modify: `plugins/mangosteen-video-replica/generation-queue.cjs`
- Modify: `plugins/mangosteen-video-replica/main.js:430-480, 614-782, 1287-1464`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Write the failing state tests**

覆盖：

```js
const run = createActiveRun({ runId: "run-1", plan, now: "2026-10-11T15:00:00.000Z" });
assert.strictEqual(run.status, "queued");
assert.deepStrictEqual(run.queue, ["008", "009"]);

const processing = updateShotState(run, "008", {
  status: "video-processing",
  stage: "provider-generation",
  taskId: "task-1",
  progress: 68,
});
assert.strictEqual(processing.activeShotId, "008");
assert.strictEqual(processing.shots["008"].paidTaskSubmitted, true);

assert.strictEqual(selectCurrentRun({ activeRun: processing, legacyState: { status: "stopped" } }).status, "processing");
```

再测：进度未知时保持 `null`、错误结构规范化、停止不清除已提交 taskId、终态归档后没有活动锁。

**Step 2: Run and verify failure**

```bash
node plugins/mangosteen-video-replica/tests/run-state.test.cjs
```

Expected: missing module failure.

**Step 3: Implement the pure state model**

导出：

```js
createActiveRun({ runId, plan, now })
updateShotState(activeRun, shotId, patch)
normalizeGenerationError(error, context)
isRunActive(activeRun)
archiveRun(activeRun, now)
selectCurrentRun({ activeRun, legacyQueue, legacyState, requestMtimeMs })
```

状态限定为：`queued`、`processing`、`stopping`、`completed`、`partial-failure`、`failed`、`stopped`。

**Step 4: Repoint queue persistence**

- 新版项目把现有队列对象持久化到 `.mangosteen/active-run.json`。
- 每次阶段变化同时更新镜头的 `stage`、`taskId`、`progress`、`elapsedMs`、错误和 `paidTaskSubmitted`。
- 运行结束后把完整对象原子写入 `.mangosteen/runs/<run-id>.json`，再删除活动文件。
- 旧项目继续读取 `.work/generation-queue.json` 和 `.work/generation-state.json`，但只经过 `selectCurrentRun()` 转换；UI 不再自行比较两套状态。

**Step 5: Add regression tests**

修改 `generation-queue.test.cjs` 和 `workbench-queue-plugin.test.cjs`，覆盖：

- 当前 active run 覆盖旧的 stopped state。
- 任务 ID 在重启后可恢复。
- 停止只阻止后续付费提交。
- 归档失败时保留 active run，不丢失任务恢复信息。
- 原有 SHA-256 计划锁与重复入队保护不变。

**Step 6: Run replica state and queue tests**

```bash
node plugins/mangosteen-video-replica/tests/run-state.test.cjs
node plugins/mangosteen-video-replica/tests/generation-queue.test.cjs
node plugins/mangosteen-video-replica/tests/workbench-queue-plugin.test.cjs
```

Expected: all pass.

**Step 7: Commit**

```bash
git add plugins/mangosteen-video-replica scripts/sync-plugin-code-to-vault.sh
git commit -m "feat: unify video replica active run state"
```

---

### Task 5: 让视频复刻直接保存到项目目录

**Files:**
- Modify: `plugins/mangosteen-video-replica/main.js:1482-1570, 1671-1925, 2029-2165`
- Modify: `plugins/mangosteen-video-replica/generation-policy.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/workbench-queue-plugin.test.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/plugin-load.test.cjs`

**Step 1: Write failing integration tests**

新增用例断言：

```js
assert.deepStrictEqual(imageOptions.outputTarget, {
  owner: "video-replica",
  projectId: "project-1",
  shotId: "008",
  assetType: "first-frame",
  destinationPath: "山竹视频复刻/project-1/03-分镜/008/首帧.png",
  overwrite: "replace-current",
});

assert.strictEqual(videoOptions.outputTarget.destinationPath,
  "山竹视频复刻/project-1/03-分镜/008/视频.mp4");
assert.strictEqual(copyVaultFileCalls, 0);
```

再测修改镜头标题后仍使用相同路径，重新生成前旧文件进入 `.mangosteen/history/`。

**Step 2: Run and verify failure**

```bash
node plugins/mangosteen-video-replica/tests/workbench-queue-plugin.test.cjs
```

Expected: output target assertions fail.

**Step 3: Pass output targets to image generation**

修改 `generateImage()` 和 `generateImageMulti()` 接收 `outputTarget`，并把它传入山竹生图插件的 options。`saveImageCandidate()` 改为调用山竹生图的目标感知保存方法，使对应 task 设置 `saved: true`；只在旧版山竹生图没有该能力时使用现有原子写兼容路径，并显示升级提示。

**Step 4: Pass output targets to video generation**

调用 `video.submitVideo()` 时增加：

```js
outputTarget: {
  owner: "video-replica",
  projectId,
  shotId: shot.id,
  assetType: "shot-video",
  destinationPath: shotArtifactPaths(projectFolder, shot.id).video,
  overwrite: "replace-current",
}
```

`waitForVideo()` 返回的 `localPath` 必须等于目标路径；删除新版流程中的 `copyVaultFile()` 调用。旧项目恢复旧任务时仍兼容其原始 `localPath`。

**Step 5: Replace title-based artifact paths**

- 版本 6 项目统一使用 `03-分镜/<ID>/首帧.png`、`尾帧.png`、`视频.mp4`。
- 首次覆盖前调用 `archiveCurrentArtifact()`。
- `generationFingerprint` 仍决定是否复用，路径本身不代表内容相同。

**Step 6: Run integration tests**

```bash
node plugins/mangosteen-video-replica/tests/workbench-queue-plugin.test.cjs
node plugins/mangosteen-video-replica/tests/plugin-load.test.cjs
```

Expected: pass with zero copy calls in version 6 flow.

**Step 7: Commit**

```bash
git add plugins/mangosteen-video-replica
git commit -m "feat: save replica media directly into projects"
```

---

### Task 6: 创建版本 6 项目和 Obsidian 可见索引

**Files:**
- Modify: `plugins/mangosteen-video-replica/replica-cli.cjs:133-240`
- Modify: `plugins/mangosteen-video-replica/replica-core.cjs`
- Modify: `plugins/mangosteen-video-replica/main.js:1092-1186, 2185-2265`
- Modify: `plugins/mangosteen-video-replica/tests/replica-cli.test.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/replica-core.test.cjs`

**Step 1: Write failing creation tests**

创建一个临时项目，断言生成：

- `01-原始素材/原视频.<ext>`、转写和抽帧。
- `02-参考资产/参考资产.md`，使用 Obsidian embeds 指向人物、场景、产品资产。
- `.mangosteen/project.json` 与 `.mangosteen/draft.json`，schema 为 6。
- 不再在 `02-分镜脚本/` 混放抽帧、首帧和尾帧。

**Step 2: Run and verify failure**

```bash
node plugins/mangosteen-video-replica/tests/replica-cli.test.cjs
```

Expected: old layout assertions differ.

**Step 3: Implement version-aware project creation**

- 新项目只创建版本 6 结构。
- `00-项目总览.md` 使用 wikilink/embed 展示项目素材、参考资产、镜头和最终成片。
- `project.json` 只保存稳定资料与当前成果；易变运行状态写入 active run。
- `draft.json` 保存可编辑分析结果。

**Step 4: Keep legacy loading compatible**

`readProjectDocument()` 按顺序检测：

1. `.mangosteen/project.json` 与 `.mangosteen/draft.json`。
2. 根目录 `project.json` 与 `generation-request.json`。

旧项目仅被读取，不因打开驾驶舱自动迁移。

**Step 5: Run project creation tests**

```bash
node plugins/mangosteen-video-replica/tests/replica-cli.test.cjs
node plugins/mangosteen-video-replica/tests/replica-core.test.cjs
```

Expected: pass.

**Step 6: Commit**

```bash
git add plugins/mangosteen-video-replica
git commit -m "feat: create organized video replica projects"
```

---

### Task 7: 增加安全迁移与历史整理

**Files:**
- Create: `plugins/mangosteen-video-replica/project-migration.cjs`
- Create: `plugins/mangosteen-video-replica/tests/project-migration.test.cjs`
- Create: `plugins/mangosteen-image/history-migration.cjs`
- Create: `plugins/mangosteen-image/tests/history-migration.test.cjs`
- Create: `plugins/mangosteen-video/history-migration.cjs`
- Create: `plugins/mangosteen-video/tests/history-migration.test.cjs`
- Modify: `plugins/mangosteen-video-replica/main.js`
- Modify: `plugins/mangosteen-image/main.js`
- Modify: `plugins/mangosteen-video/main.js`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Write failing migration-plan tests**

项目迁移必须先生成只读计划：

```js
const plan = planLegacyProjectMigration({ projectFolder, files, project, request });
assert.strictEqual(plan.blocked, false);
assert.ok(plan.operations.some((item) => item.from.includes("02-分镜脚本") && item.to.includes("03-分镜/001/首帧.png")));
assert.strictEqual(plan.deletes.length, 0);
```

运行中的 `queued`、`processing`、`saving` 和 uncertain submission 必须返回 `blocked: true`。

**Step 2: Implement transactional project migration**

接口：

```js
planLegacyProjectMigration(input)
executeProjectMigration({ plan, copy, move, hash, atomicWrite })
rollbackProjectMigration({ journal, move, removeNew })
```

执行顺序固定为：复制新文件 → SHA-256 验证 → 原子写新版 JSON → 将旧文件移动到隐藏历史目录。任何一步失败都按 journal 回滚。

**Step 3: Implement standalone history consolidation**

- `生图记录/<单任务目录>/图片-1.png` 迁移到 `山竹创作记录/图片/YYYY-MM/<时间>-<taskId>-01.png`。
- `山竹视频/<taskId>/<长提示词>.mp4` 迁移到 `山竹创作记录/视频/YYYY-MM/<时间>-<taskId>.mp4`。
- 使用插件 settings 中的任务 ID、创建时间和路径更新记录。
- 只整理已完成且没有不确定提交标记的任务。
- 不自动删除；旧目录移入插件隐藏迁移备份，二次确认后才能清理。

**Step 4: Expose explicit commands**

增加：

- 视频复刻：`整理当前视频复刻项目`。
- 山竹生图：`整理山竹生图历史记录`。
- 山竹视频：`整理山竹视频历史记录`。

命令先展示文件数量、预计移动量和备份位置，再要求用户确认。

**Step 5: Run migration tests**

```bash
node plugins/mangosteen-video-replica/tests/project-migration.test.cjs
node plugins/mangosteen-image/tests/history-migration.test.cjs
node plugins/mangosteen-video/tests/history-migration.test.cjs
```

Expected: pass, including injected copy failure and hash mismatch rollback.

**Step 6: Commit**

```bash
git add plugins scripts/sync-plugin-code-to-vault.sh
git commit -m "feat: add safe media storage migration"
```

---

### Task 8: 建立三栏驾驶舱 ViewModel

**Files:**
- Create: `plugins/mangosteen-video-replica/replica-cockpit-model.cjs`
- Create: `plugins/mangosteen-video-replica/tests/replica-cockpit-model.test.cjs`
- Modify: `plugins/mangosteen-video-replica/replica-ui-state.cjs`
- Modify: `plugins/mangosteen-video-replica/tests/replica-ui-state.test.cjs`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Write failing model tests**

```js
const model = deriveCockpitModel({ project, draft, activeRun, selectedShotId: "008", nowMs });
assert.strictEqual(model.rail.items[7].status, "processing");
assert.strictEqual(model.editor.locked, true);
assert.strictEqual(model.monitor.taskId, "task_xxx");
assert.strictEqual(model.monitor.progress, 68);
assert.deepStrictEqual(model.monitor.stages.map((item) => item.status), ["done", "done", "done", "active", "waiting"]);
assert.strictEqual(model.rail.items[8].paidTaskSubmitted, false);
```

再测：未锁定镜头仍可编辑、没有数值进度时返回 `null`、失败包含下一步动作、旧项目兼容映射。

**Step 2: Run and verify failure**

```bash
node plugins/mangosteen-video-replica/tests/replica-cockpit-model.test.cjs
```

Expected: missing module failure.

**Step 3: Implement pure ViewModel**

返回固定结构：

```js
{
  header: { title, completed, total, currentText, percent },
  rail: { items: [] },
  editor: { shot, locked, lockReason, references, timeline, effectivePrompt },
  monitor: { status, model, taskId, elapsedMs, progress, stages, error },
}
```

百分比优先使用 provider 数值；没有则为 `null`，UI 显示活动状态而非伪造百分比。

**Step 4: Integrate with existing workbench state**

`deriveWorkbenchState()` 接收 `activeRun`，不再让旧 generation state 覆盖新版活动运行。保留总览、资产、成片和设置页所需字段。

**Step 5: Run model tests**

```bash
node plugins/mangosteen-video-replica/tests/replica-cockpit-model.test.cjs
node plugins/mangosteen-video-replica/tests/replica-ui-state.test.cjs
```

Expected: pass.

**Step 6: Commit**

```bash
git add plugins/mangosteen-video-replica scripts/sync-plugin-code-to-vault.sh
git commit -m "feat: add three pane cockpit view model"
```

---

### Task 9: 实现三栏制作驾驶舱 UI

**Files:**
- Create: `plugins/mangosteen-video-replica/replica-cockpit.cjs`
- Create: `plugins/mangosteen-video-replica/tests/replica-cockpit.test.cjs`
- Modify: `plugins/mangosteen-video-replica/replica-workbench.cjs:284-639`
- Modify: `plugins/mangosteen-video-replica/styles.css`
- Modify: `plugins/mangosteen-video-replica/tests/replica-workbench.test.cjs`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Write failing render-contract tests**

使用现有 fake DOM，断言：

- 宽屏 DOM 顺序为 `shot-rail`、`shot-editor`、`generation-monitor`。
- 点击镜头只切换选中项，不重置未保存的其他镜头草案。
- 生成中的镜头编辑控件禁用，其他镜头仍可编辑和选择。
- 监控区显示 task ID、真实进度、等待时间、阶段和明确错误动作。
- 不再把全部最终提示词默认铺开。

**Step 2: Run and verify failure**

```bash
node plugins/mangosteen-video-replica/tests/replica-cockpit.test.cjs
```

Expected: missing module or missing class failure.

**Step 3: Implement bounded rendering components**

`replica-cockpit.cjs` 导出：

```js
renderShotRail(parent, model, actions)
renderShotEditor(parent, model, actions)
renderGenerationMonitor(parent, model, actions)
renderCockpit(parent, model, actions)
```

`replica-workbench.cjs` 继续负责项目加载、草案状态和事件动作；渲染模块不读文件、不调用算力接口。

**Step 4: Implement the approved visual system**

- 单一低饱和绿色强调色、中性深灰表面、无紫色 AI 渐变。
- 左侧镜头队列固定宽度；中间编辑器自适应；右侧监控固定上限。
- `@container >= 1100px` 三栏；`760–1099px` 监控移到下方；`<760px` 单列。
- 数字和时间使用等宽字体与 tabular numbers。
- 完整 hover、active、focus、disabled、loading、empty 和 error 状态。
- 尊重 `prefers-reduced-motion`。

**Step 5: Connect actions**

动作限定为：选择镜头、保存草案、生成所选、停止后续任务、重新读取模型、打开产物、整理当前项目。不得从 UI 直接改写 `active-run.json`。

**Step 6: Run UI tests**

```bash
node plugins/mangosteen-video-replica/tests/replica-cockpit.test.cjs
node plugins/mangosteen-video-replica/tests/replica-workbench.test.cjs
```

Expected: pass.

**Step 7: Commit**

```bash
git add plugins/mangosteen-video-replica scripts/sync-plugin-code-to-vault.sh
git commit -m "feat: build three pane video production cockpit"
```

---

### Task 10: 完成全量回归、版本更新和安全部署门禁

**Files:**
- Modify: `plugins/mangosteen-image/manifest.json`
- Modify: `plugins/mangosteen-video/manifest.json`
- Modify: `plugins/mangosteen-video-replica/manifest.json`
- Modify: `docs/acceptance/2026-10-11-fixed-character-video-live.md`
- Modify: `scripts/sync-plugin-code-to-vault.sh`

**Step 1: Run all source tests**

```bash
for plugin in mangosteen-image mangosteen-video mangosteen-video-replica; do
  for test in plugins/$plugin/tests/*.test.cjs; do node "$test"; done
done
```

Expected: all tests pass.

**Step 2: Verify the real active-generation gate**

读取真实 Vault 最新项目：

```bash
python3 - <<'PY'
from pathlib import Path
import json
root = Path('/Users/ziyan/ObsidianVaults/山竹视频复刻')
projects = sorted(root.glob('*/project.json'), key=lambda p: p.stat().st_mtime, reverse=True)
if not projects:
    print('NO_PROJECT')
else:
    project = json.loads(projects[0].read_text())
    active = [s for s in project.get('shots', []) if s.get('status') in {'正在生成视频','正在提交视频任务','正在生成首帧','正在生成尾帧'}]
    print('ACTIVE', len(active), [s.get('id') for s in active])
PY
```

Expected before deployment: `ACTIVE 0 []`. If nonzero, stop here; do not sync or reload.

**Step 3: Bump versions**

- `mangosteen-image`: `5.3.27`
- `mangosteen-video`: `5.3.25`
- `mangosteen-video-replica`: `1.2.0`

**Step 4: Commit release-ready source**

```bash
git add plugins scripts docs/acceptance/2026-10-11-fixed-character-video-live.md
git commit -m "release: prepare organized media cockpit plugins"
```

**Step 5: Back up installed plugins**

创建带时间戳的备份目录，完整复制：

- `/Users/ziyan/ObsidianVaults/.obsidian/plugins/mangosteen-image`
- `/Users/ziyan/ObsidianVaults/.obsidian/plugins/mangosteen-video`
- `/Users/ziyan/ObsidianVaults/.obsidian/plugins/mangosteen-video-replica`

不要覆盖旧备份。

**Step 6: Sync allow-listed files**

```bash
scripts/sync-plugin-code-to-vault.sh /Users/ziyan/ObsidianVaults
```

Expected: `Synced allow-listed plugin code to .../.obsidian/plugins`.

**Step 7: Verify source and installed hashes**

对同步清单中的每个文件计算 SHA-256，断言 source 与 installed 完全一致。任何不一致都从备份恢复，不重载插件。

**Step 8: Run installed-plugin tests**

```bash
for plugin in mangosteen-image mangosteen-video mangosteen-video-replica; do
  for test in /Users/ziyan/ObsidianVaults/.obsidian/plugins/$plugin/tests/*.test.cjs; do node "$test"; done
done
```

Expected: all pass.

**Step 9: Reload only after tests pass**

在 Obsidian 中依次关闭并启用三个插件，或使用一次应用重载。验证：

1. 现有旧项目能打开，不自动移动文件。
2. 驾驶舱显示三栏并读取唯一当前状态。
3. 约 1200px、720px、360px 宽度下无横向溢出。
4. “整理当前项目”在活动任务存在时禁用。
5. 不发起任何新的付费生成任务。

**Step 10: Perform one bounded live acceptance after user approval**

仅在用户确认费用后生成一个测试镜头，验证：

- 图片直接保存到 `03-分镜/<ID>/首帧.png`。
- 视频直接保存到 `03-分镜/<ID>/视频.mp4`。
- 全局目录不产生新的单文件任务文件夹。
- UI 显示真实 task ID、阶段、耗时和进度。
- Obsidian 重启后能恢复查询已提交任务且不重复扣费。

将路径、task ID、哈希和结果写入验收文档。

**Step 11: Final commit**

```bash
git add docs/acceptance/2026-10-11-fixed-character-video-live.md
git commit -m "test: verify organized media cockpit deployment"
```

---

## Done Definition

- 三个插件源码和安装版本测试全部通过。
- 视频复刻项目任务直接保存到稳定镜头目录，没有二次复制。
- 独立生图与视频按月份归档，不再创建单文件任务目录。
- UI 只从活动运行状态显示当前生成进度。
- 三栏驾驶舱支持生成中镜头锁定和其他镜头继续编辑。
- 旧项目不迁移也能使用；迁移有预览、哈希验证、回滚和明确确认。
- 当前远程任务未因开发、部署或重载被中断或重复提交。
