# 山竹视频复刻制作驾驶舱 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有“山竹视频复刻”插件中增加一个可编辑、可查看实时生成进度、可被 Obsidian 原生拖拽停靠，并能随容器宽度自动重排的制作驾驶舱。

**Architecture:** 保留现有拆解、分析、图片生成、视频生成和拼接流程不动；新增纯数据 ViewModel、纯函数编辑器和一个原生 `ItemView`。插件主类只负责项目文件读写、视图注册和调用已有流程，UI 不直接调用算力接口。

**Tech Stack:** Obsidian Plugin API、CommonJS、原生 DOM API、CSS Container Queries、Node.js `assert` 测试。

**Spec:** `docs/superpowers/specs/2026-10-11-video-replica-cockpit-ui-design.md`

---

## Global Constraints

- 不引入 React、Tailwind、拖拽库或新的运行时依赖。
- 驾驶舱标签拖拽完全复用 Obsidian `ItemView`；不开发自定义窗口拖拽系统。
- 分镜排序只保留“上移、下移”，不做卡片自由拖拽。
- 实时进度只读 `.work/generation-state.json`、`project.json`、`generation-request.json`，不解析终端日志。
- 当前生成任务仍为 `processing` 时，只完成代码和自动测试，不重启 Obsidian、不覆盖正在运行的插件实例。
- 所有保存先校验，再通过临时文件原子替换；已确认或生成中的任务拒绝编辑。
- 旧版 v1/v2 项目缺少产品字段时按空数组展示，不触发迁移和付费重跑。

## Review Focus

1. 将标签拖入 320px 侧栏后，表单、按钮和错误信息仍可见，不出现横向溢出。
2. 用户正在编辑时，2 秒刷新不能覆盖未保存内容或重复绑定点击事件。
3. `generation-state.json` 缺失、损坏或过期时，页面降级到项目状态而不是崩溃。
4. `confirmed: true` 或 `processing` 时，保存、排序和确认按钮必须锁定。
5. v1/v2/v3、缺图、模型 404、部分镜头失败都必须有稳定占位和明确动作。

### Task 1: 建立稳定的驾驶舱 ViewModel

**Files:**
- Create: `plugins/mangosteen-video-replica/replica-ui-state.cjs`
- Create: `plugins/mangosteen-video-replica/tests/replica-ui-state.test.cjs`

**Interfaces:**

```js
deriveWorkbenchState({ project, request, generationState, nowMs })
calculateStageProgress({ project, request, generationState })
stateSignature(viewModel)
```

`deriveWorkbenchState` 返回固定结构：

```js
{
  empty: false,
  folder: "山竹视频复刻/项目名",
  title: "项目名",
  status: "generating",
  statusText: "正在生成",
  locked: true,
  canConfirm: false,
  progress: { percent: 56, indeterminate: true, label: "分镜视频" },
  current: { step: "镜头 002", model: "MiniMax-H3", elapsedMs: 120000 },
  assets: { character: null, products: [], scenes: [] },
  shots: [],
  output: { finalVideoPath: "", concatError: "" },
  error: null
}
```

**Step 1: Write the failing test**

覆盖五个输入类：空项目、`analysis_ready` 草案、参考资产完成、3 个镜头完成 1 个、最终成片完成。另加损坏/缺失状态对象与旧版无 `products` 的容错。

```js
const ready = deriveWorkbenchState({
  project: { folder: "山竹视频复刻/测试", title: "测试", status: "analysis_ready", shots: [] },
  request: { version: 3, confirmed: false, products: [], scenes: [], shots: [] },
  generationState: null,
  nowMs: Date.parse("2026-10-11T00:02:00Z"),
});
assert.strictEqual(ready.progress.percent, 30);
assert.strictEqual(ready.locked, false);
assert.strictEqual(ready.canConfirm, true);

const generating = deriveWorkbenchState({
  project: {
    status: "generating",
    shots: [
      { id: "001", status: "已完成", videoPath: "001.mp4" },
      { id: "002", status: "正在生成视频" },
      { id: "003", status: "等待生成" },
    ],
  },
  request: { confirmed: true, shots: [{}, {}, {}] },
  generationState: {
    status: "processing",
    currentStep: "镜头 002",
    startedAt: "2026-10-11T00:00:00Z",
  },
  nowMs: Date.parse("2026-10-11T00:02:00Z"),
});
assert.strictEqual(generating.progress.percent, 60);
assert.strictEqual(generating.progress.indeterminate, true);
assert.strictEqual(generating.current.elapsedMs, 120000);
```

**Step 2: Run test to verify it fails**

Run:

```bash
node plugins/mangosteen-video-replica/tests/replica-ui-state.test.cjs
```

Expected: FAIL with `Cannot find module '../replica-ui-state.cjs'`.

**Step 3: Write minimal implementation**

- 只接受普通对象；数组、`null` 和错误内容视为空对象。
- 阶段值固定为 0、15、30、45、45～90、95、100。
- 分镜完成数量优先看 `videoPath`，其次看“已完成”状态；失败镜头不算完成。
- 运行中但上游没有精确百分比时设置 `indeterminate: true`。
- 错误优先级：结构化 generation state → project status text → 单镜头 error。
- `stateSignature` 只序列化会影响页面显示的字段，供 2 秒刷新去重。

核心计算：

```js
function calculateStageProgress({ project = {}, request = {}, generationState = {} } = {}) {
  if (project.finalVideoPath) return { percent: 100, indeterminate: false, label: "成片完成" };
  if (generationState.currentStep === "拼接成片") return { percent: 95, indeterminate: true, label: "拼接成片" };

  const shots = Array.isArray(project.shots) ? project.shots : [];
  const total = Math.max(shots.length, Array.isArray(request.shots) ? request.shots.length : 0);
  const completed = shots.filter((shot) => shot?.videoPath || shot?.status === "已完成").length;
  if (total > 0 && ["generating", "processing", "completed_with_errors"].includes(project.status || generationState.status)) {
    return {
      percent: Math.round(45 + (completed / total) * 45),
      indeterminate: generationState.status === "processing",
      label: "分镜视频",
    };
  }

  const expectedScenes = Array.isArray(request.scenes) ? request.scenes.length : 0;
  const readyScenes = (Array.isArray(project.sceneAssets) ? project.sceneAssets : [])
    .filter((asset) => asset?.imagePath).length;
  const assetsReady = Boolean(project.characterAsset?.imagePath)
    && expectedScenes > 0
    && readyScenes >= expectedScenes;
  if (assetsReady) return { percent: 45, indeterminate: false, label: "参考资产" };
  if (project.status === "analysis_ready" || request?.confirmed === false) return { percent: 30, indeterminate: false, label: "AI 分析" };
  if (["prepared", "analyzing", "analysis_failed", "analysis_model_error"].includes(project.status)) {
    return { percent: project.status === "prepared" ? 15 : 30, indeterminate: project.status === "analyzing", label: "AI 分析" };
  }
  return { percent: 0, indeterminate: false, label: "等待开始" };
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
node plugins/mangosteen-video-replica/tests/replica-ui-state.test.cjs
```

Expected: `replica-ui-state: ok`.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/replica-ui-state.cjs plugins/mangosteen-video-replica/tests/replica-ui-state.test.cjs
git commit -m "feat: add video replica workbench state"
```

### Task 2: 增加可校验、可锁定的草案编辑器

**Files:**
- Create: `plugins/mangosteen-video-replica/replica-editor.cjs`
- Create: `plugins/mangosteen-video-replica/tests/replica-editor.test.cjs`
- Modify: `plugins/mangosteen-video-replica/replica-core.cjs:67-183`
- Modify: `plugins/mangosteen-video-replica/tests/replica-core.test.cjs`

**Interfaces:**

```js
isDraftLocked(request, generationState)
updateDraftField(request, target, value)
moveShot(request, shotIndex, direction)
validateDraft(request, normalizeGenerationRequest)
```

`target` 只允许以下白名单结构：

```js
{ section: "character", field: "prompt" }
{ section: "product", index: 0, field: "prompt" }
{ section: "scene", index: 0, field: "prompt" }
{ section: "shot", index: 0, field: "dialogue" }
{ section: "settings", field: "videoModel" }
```

**Step 1: Write the failing test**

```js
const draft = {
  version: 3,
  confirmed: false,
  character: { id: "hero", prompt: "原人物" },
  products: [],
  scenes: [{ id: "room", prompt: "原场景" }],
  settings: { imageModel: "gpt-image-2", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
  shots: [
    { id: "001", title: "第一镜", sceneId: "room", productIds: [], imagePrompt: "首帧1", videoPrompt: "视频1" },
    { id: "002", title: "第二镜", sceneId: "room", productIds: [], imagePrompt: "首帧2", videoPrompt: "视频2" },
  ],
};
assert.strictEqual(isDraftLocked(draft, null), false);
assert.strictEqual(isDraftLocked({ ...draft, confirmed: true }, null), true);
assert.strictEqual(isDraftLocked(draft, { status: "processing" }), true);

const edited = updateDraftField(draft, { section: "shot", index: 0, field: "dialogue" }, "新台词");
assert.strictEqual(edited.shots[0].dialogue, "新台词");
assert.notStrictEqual(edited, draft);

const moved = moveShot(draft, 1, "up");
assert.deepStrictEqual(moved.shots.map((shot) => shot.title), ["第二镜", "第一镜"]);
assert.deepStrictEqual(moved.shots.map((shot) => shot.id), ["001", "002"]);
assert.throws(() => updateDraftField(draft, { section: "shot", index: 0, field: "__proto__" }, "x"), /不支持编辑/);
```

再验证缺少场景引用时返回 `{ ok: false, errors: [{ path: "shots.0.sceneId", message }] }`，而不是直接让 UI 崩溃。

**Step 2: Run test to verify it fails**

Run:

```bash
node plugins/mangosteen-video-replica/tests/replica-editor.test.cjs
```

Expected: FAIL with missing module.

**Step 3: Write minimal implementation**

- 所有编辑操作返回深拷贝，不原地修改。
- 白名单字段包括人物/产品/场景提示词、分镜标题/时长/引用/台词/剧情/环境/镜头语言/首尾帧/视频提示词，以及模型设置。
- `moveShot` 越界时返回未改变的副本，移动后按顺序重排 `001`～`012`。
- `validateDraft` 调用现有规范化器时临时设置 `confirmed: true`，成功后恢复 `confirmed: false`。
- 为避免 UI 依赖中文错误字符串，在 `replica-core.cjs` 的验证错误上补充 `error.path`，保留原有中文信息以兼容现有测试。

```js
function validateDraft(request, normalizeGenerationRequest) {
  try {
    const value = normalizeGenerationRequest({ ...clone(request), confirmed: true });
    return { ok: true, value: { ...value, confirmed: false }, errors: [] };
  } catch (error) {
    return {
      ok: false,
      value: null,
      errors: [{ path: String(error?.path || "request"), message: String(error?.message || error) }],
    };
  }
}
```

**Step 4: Run focused tests**

Run:

```bash
node plugins/mangosteen-video-replica/tests/replica-editor.test.cjs
node plugins/mangosteen-video-replica/tests/replica-core.test.cjs
```

Expected: `replica-editor: ok` and `replica-core: ok`.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/replica-editor.cjs plugins/mangosteen-video-replica/replica-core.cjs plugins/mangosteen-video-replica/tests/replica-editor.test.cjs plugins/mangosteen-video-replica/tests/replica-core.test.cjs
git commit -m "feat: add safe replica draft editing"
```

### Task 3: 建立可拖拽停靠的原生 ItemView 与自适应 UI

**Files:**
- Create: `plugins/mangosteen-video-replica/replica-workbench.cjs`
- Create: `plugins/mangosteen-video-replica/tests/replica-workbench.test.cjs`
- Modify: `plugins/mangosteen-video-replica/styles.css`

**Interfaces:**

```js
const VIEW_TYPE = "mangosteen-video-replica-workbench";

class VideoReplicaWorkbenchView extends ItemView {
  getViewType()
  getDisplayText()
  getIcon()
  onOpen()
  onClose()
  refresh({ force = false } = {})
  render()
}
```

视图只调用插件提供的接口：

```js
listWorkbenchProjects()
loadWorkbenchProject(folder)
saveWorkbenchDraft(folder, request)
confirmWorkbenchDraft(folder)
openVaultPath(vaultPath)
openPrepareModal()
openAnalysisModelModal()
openGenerationModelModal()
```

**Step 1: Write the failing test**

用最小 `FakeElement` 和 `ItemView` mock，验证：

- `getViewType()` 和标题稳定。
- `onOpen()` 只创建一个 2 秒定时器。
- 连续 `refresh()` 在签名不变时不重建 DOM。
- 本地 `dirty === true` 时外部刷新不覆盖 draft。
- `onClose()` 清理定时器。
- 空项目、锁定草案和失败镜头都能渲染，不抛异常。

```js
const view = new VideoReplicaWorkbenchView(leaf, plugin);
assert.strictEqual(view.getViewType(), VIEW_TYPE);
assert.strictEqual(view.getDisplayText(), "山竹视频复刻");
await view.onOpen();
assert.strictEqual(plugin.loadCalls, 1);
await view.refresh();
assert.strictEqual(plugin.loadCalls, 2);
await view.onClose();
assert.strictEqual(view.refreshTimer, null);
```

**Step 2: Run test to verify it fails**

Run:

```bash
node plugins/mangosteen-video-replica/tests/replica-workbench.test.cjs
```

Expected: FAIL with missing module.

**Step 3: Implement the ItemView shell**

- `contentEl` 根节点使用 `mangosteen-replica-workbench`，设置 `container-type: inline-size`。
- 顶部工具栏：项目选择、新建、刷新、更换模型、状态。
- 导航：总览、资产、分镜、成片、设置。
- 分镜编辑控件使用 DOM `input`、`textarea`、`select`，不注入 HTML 字符串。
- 输入只更新内存 draft 并标记 `dirty`；点击保存时调用编辑器校验和插件原子保存。
- `ResizeObserver` 只更新可选的宽度标签，不参与布局；实际布局由 CSS 完成。
- 页面重渲染前保存 `activeTab`、滚动位置和折叠状态；脏草案不被轮询覆盖。
- 原生标签拖拽不写任何 pointer/mouse 事件，避免破坏 Obsidian 停靠。

主要 CSS：

```css
.mangosteen-replica-workbench {
  container-type: inline-size;
  --replica-gap: clamp(8px, 1.2cqi, 18px);
  --replica-pad: clamp(10px, 1.8cqi, 24px);
  height: 100%;
  min-width: 0;
  overflow: hidden;
}

.mangosteen-replica-shell {
  display: grid;
  grid-template-columns: minmax(168px, 220px) minmax(0, 1fr);
  height: 100%;
  min-width: 0;
}

.mangosteen-replica-content {
  min-width: 0;
  overflow: auto;
}

.mangosteen-replica-shot-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--replica-gap);
}

@container (max-width: 1099px) {
  .mangosteen-replica-shot-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@container (max-width: 759px) {
  .mangosteen-replica-shell { grid-template-columns: minmax(0, 1fr); }
  .mangosteen-replica-nav { display: flex; flex-wrap: wrap; overflow: visible; }
  .mangosteen-replica-shot-grid { grid-template-columns: minmax(0, 1fr); }
}

@container (max-width: 519px) {
  .mangosteen-replica-toolbar,
  .mangosteen-replica-form-row { align-items: stretch; flex-direction: column; }
  .mangosteen-replica-toolbar button { width: 100%; }
  .mangosteen-replica-workbench input,
  .mangosteen-replica-workbench select,
  .mangosteen-replica-workbench textarea { max-width: 100%; min-width: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .mangosteen-replica-workbench * { scroll-behavior: auto; transition-duration: 0.01ms !important; }
}
```

补充普通 `@media (max-width: ...)` 降级规则，但不重复颜色和间距定义。

**Step 4: Run test and static checks**

Run:

```bash
node plugins/mangosteen-video-replica/tests/replica-workbench.test.cjs
node --check plugins/mangosteen-video-replica/replica-workbench.cjs
grep -q 'container-type: inline-size' plugins/mangosteen-video-replica/styles.css
```

Expected: test prints `replica-workbench: ok`; syntax and CSS checks exit 0.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/replica-workbench.cjs plugins/mangosteen-video-replica/styles.css plugins/mangosteen-video-replica/tests/replica-workbench.test.cjs
git commit -m "feat: add responsive replica cockpit view"
```

### Task 4: 把驾驶舱接入现有插件和固定项目读写

**Files:**
- Modify: `plugins/mangosteen-video-replica/main.js:1-190`
- Modify: `plugins/mangosteen-video-replica/main.js:209-536`
- Modify: `plugins/mangosteen-video-replica/manifest.json`
- Modify: `plugins/mangosteen-video-replica/tests/plugin-load.test.cjs`

**Step 1: Extend the failing plugin-load test**

在 Obsidian mock 中增加 `ItemView`、`registerView`、`getLeavesOfType`、`getLeaf`、`revealLeaf`，并断言：

```js
assert.strictEqual(registeredViews.length, 1);
assert.strictEqual(registeredViews[0].type, "mangosteen-video-replica-workbench");

await plugin.activateWorkbench();
assert.deepStrictEqual(openedViewState, {
  type: "mangosteen-video-replica-workbench",
  active: true,
});

await plugin.saveWorkbenchDraft(folder, draft);
assert.strictEqual(JSON.parse(fs.readFileSync(requestPath)).confirmed, false);

await plugin.confirmWorkbenchDraft(folder);
assert.strictEqual(JSON.parse(fs.readFileSync(requestPath)).confirmed, true);
```

同时验证已确认草案、`processing` 草案和非法项目路径均拒绝保存。

**Step 2: Run test to verify it fails**

Run:

```bash
node plugins/mangosteen-video-replica/tests/plugin-load.test.cjs
```

Expected: FAIL because no workbench view is registered.

**Step 3: Integrate the view**

在 `onload()`：

```js
const workbench = require(path.join(pluginRoot, "replica-workbench.cjs"));
this.workbenchViewType = workbench.VIEW_TYPE;
this.registerView(this.workbenchViewType, (leaf) => new workbench.VideoReplicaWorkbenchView(leaf, this));
this.addRibbonIcon("clapperboard", "山竹视频复刻", () => void this.activateWorkbench());
this.addCommand({
  id: "open-video-replica-workbench",
  name: "打开视频复刻制作驾驶舱",
  callback: () => void this.activateWorkbench(),
});
```

保留“从本地视频新建复刻项目”命令，删除旧的 ribbon 直接打开 `PrepareModal` 行为。

新增主类方法：

```js
async activateWorkbench() {
  const existing = this.app.workspace.getLeavesOfType(this.workbenchViewType)[0];
  const leaf = existing || this.app.workspace.getLeaf(true);
  if (!existing) await leaf.setViewState({ type: this.workbenchViewType, active: true });
  await this.app.workspace.revealLeaf(leaf);
  return leaf;
}

listWorkbenchProjects() {
  return this.projectRecords().map(({ project, mtimeMs }) => ({
    folder: project.folder,
    title: project.title || path.basename(project.folder || ""),
    status: project.status || "unknown",
    mtimeMs,
  }));
}
```

`loadWorkbenchProject(folder)` 分别容错读取三个 JSON；每个失败都返回 `readErrors`，不抛出导致整页空白。

`saveWorkbenchDraft(folder, draft)`：

1. 用 `core.normalizeVaultPath` 限制在 `山竹视频复刻/` 下。
2. 读取当前 request 和 state，再次检查未确认且未运行。
3. 调 `replica-editor.validateDraft`。
4. 原子写入 `generation-request.json`。
5. 更新 `project.shots` 的可编辑显示字段，但不删除已有产物字段。

`confirmWorkbenchDraft(folder)` 只确认用户当前选择的项目，不再误用“最近项目”；模型选择仍复用现有目录与 404 错误处理。

项目 JSON 或 request/state 文件被修改时，调用已打开视图的 `requestRefresh()`；视图自身做签名去重。

将 `manifest.json` 版本从 `1.0.0` 升为 `1.1.0`。

**Step 4: Run integration tests**

Run:

```bash
node plugins/mangosteen-video-replica/tests/plugin-load.test.cjs
node --check plugins/mangosteen-video-replica/main.js
node --check plugins/mangosteen-video-replica/replica-workbench.cjs
```

Expected: `plugin-load: ok` and both syntax checks exit 0.

**Step 5: Commit**

```bash
git add plugins/mangosteen-video-replica/main.js plugins/mangosteen-video-replica/manifest.json plugins/mangosteen-video-replica/tests/plugin-load.test.cjs
git commit -m "feat: integrate video replica cockpit"
```

### Task 5: 全量回归、真实停靠验收与安全同步

**Files:**
- Modify if needed: `plugins/mangosteen-video-replica/*.cjs`
- Modify if needed: `plugins/mangosteen-video-replica/main.js`
- Modify if needed: `plugins/mangosteen-video-replica/styles.css`
- Test: `plugins/mangosteen-video-replica/tests/*.test.cjs`

**Step 1: Run the complete automated suite**

Run:

```bash
set -e
for test_file in   plugins/mangosteen-image/tests/*.test.cjs   plugins/mangosteen-video-replica/tests/*.test.cjs   plugins/mangosteen-video/tests/*.test.cjs   scripts/tests/*.test.cjs
do
  node "$test_file"
done
```

Expected: every test exits 0; no paid API request is made.

**Step 2: Run release hygiene checks**

Run:

```bash
git diff --check
node --check plugins/mangosteen-video-replica/main.js
node --check plugins/mangosteen-video-replica/replica-ui-state.cjs
node --check plugins/mangosteen-video-replica/replica-editor.cjs
node --check plugins/mangosteen-video-replica/replica-workbench.cjs
grep -RInE 'TODO|TBD|FIXME' plugins/mangosteen-video-replica --exclude-dir=tests
```

Expected: checks exit 0 and grep returns no unfinished markers.

**Step 3: Verify the live task is safe to reload**

Read:

```text
/Users/ziyan/ObsidianVaults/山竹视频复刻/*/.work/generation-state.json
```

If the newest state is `processing`, stop here and report “代码已通过，等待当前任务结束后同步”，不要重启 Obsidian。

If it is `completed`、`completed_with_errors` or `failed`, copy only this allowlist into:

```text
/Users/ziyan/ObsidianVaults/.obsidian/plugins/mangosteen-video-replica/
```

Allowlist: `main.js`、`manifest.json`、`styles.css`、`replica-workbench.cjs`、`replica-ui-state.cjs`、`replica-editor.cjs`。不要删除用户数据，不同步测试文件。

**Step 4: Perform manual Obsidian acceptance**

1. 点击左侧“山竹视频复刻”，确认打开驾驶舱而非弹窗。
2. 拖动标签到左侧、右侧、底部和主编辑区分屏，确认 Obsidian 接受停靠。
3. 将面板缩放到约 320px、720px、1200px，确认无横向溢出，主要按钮始终可点。
4. 打开未确认测试项目，编辑台词并上下移动分镜；保存后重开仍保持。
5. 打开生成中/已完成项目，确认进度、资产、镜头错误和成片均来自结构化文件，且锁定状态不能编辑。

Expected: 五项全部通过，且没有触发新的图片或视频付费任务。

**Step 5: Commit any acceptance-only fixes**

只有手动验收发现问题时才修改并重新执行 Step 1～4；通过后提交：

```bash
git add plugins/mangosteen-video-replica
git commit -m "fix: harden responsive replica cockpit"
```

若无需修复，不创建空提交。
