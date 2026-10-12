const assert = require("assert");
const {
  calculateStageProgress,
  deriveWorkbenchState,
  stateSignature,
} = require("../replica-ui-state.cjs");

const nowMs = Date.parse("2026-10-11T00:02:00Z");

const empty = deriveWorkbenchState();
assert.deepStrictEqual(empty, {
  empty: true,
  folder: "",
  title: "",
  status: "",
  statusText: "",
  locked: true,
  canConfirm: false,
  canGenerate: false,
  canStop: false,
  queueStatus: "",
  queueShots: [],
  lockedShotIds: [],
  progress: { percent: 0, indeterminate: false, label: "等待开始" },
  current: { step: "", model: "", elapsedMs: 0 },
  assets: { character: null, products: [], scenes: [] },
  shots: [],
  output: { finalVideoPath: "", concatError: "" },
  error: null,
  cockpit: {
    header: { title: "", completed: 0, total: 0, currentText: "", percent: null },
    rail: { items: [] },
    editor: {
      shot: null,
      locked: true,
      lockReason: "请选择镜头",
      references: [],
      timeline: [],
      effectivePrompt: "",
    },
    monitor: {
      shotId: null,
      status: "idle",
      paidTaskSubmitted: false,
      model: "",
      taskId: null,
      taskIdAvailability: "not-submitted",
      elapsedMs: 0,
      progress: null,
      stages: [
        { id: "references", label: "参考资产", status: "waiting" },
        { id: "first-frame", label: "首帧", status: "waiting" },
        { id: "last-frame", label: "尾帧", status: "waiting" },
        { id: "provider", label: "视频生成", status: "waiting" },
        { id: "saving", label: "保存成片", status: "waiting" },
      ],
      error: null,
    },
  },
});

const ready = deriveWorkbenchState({
  project: {
    folder: "山竹视频复刻/测试",
    title: "测试",
    status: "analysis_ready",
    statusText: "山竹智能体分析完成，等待确认生成",
    shots: [],
  },
  request: { version: 3, confirmed: false, products: [], scenes: [], shots: [] },
  generationState: null,
  nowMs,
});
assert.strictEqual(ready.empty, false);
assert.strictEqual(ready.progress.percent, 30);
assert.strictEqual(ready.locked, false);
assert.strictEqual(ready.canConfirm, true);
assert.strictEqual(ready.canGenerate, true);
assert.strictEqual(ready.canStop, false);

const queued = deriveWorkbenchState({
  project: {
    folder: "山竹视频复刻/排队",
    status: "analysis_ready",
    shots: [{ id: "001", status: "正在生成产品参考图" }, { id: "002", status: "等待生成" }],
  },
  request: { confirmed: false, shots: [{ id: "001" }, { id: "002" }], settings: { videoModel: "MiniMax-H3" } },
  generationQueue: {
    status: "processing",
    stopRequested: false,
    startedAt: "2026-10-11T00:00:00Z",
    shots: [{ id: "001", status: "processing" }, { id: "002", status: "completed" }],
  },
  nowMs,
});
assert.deepStrictEqual(queued.lockedShotIds, ["001"]);
assert.strictEqual(queued.locked, false, "a queue must not lock the whole draft");
assert.strictEqual(queued.canGenerate, true, "unlocked shots must remain selectable while another shot is running");
assert.strictEqual(queued.canStop, true);
assert.deepStrictEqual(queued.progress, { percent: 68, indeterminate: true, label: "分镜队列" });
assert.deepStrictEqual(queued.current, { step: "镜头 001 · 正在生成产品参考图", model: "MiniMax-H3", elapsedMs: 120000 });

const authoritativeActiveRun = deriveWorkbenchState({
  project: {
    folder: "山竹视频复刻/活动运行",
    title: "活动运行",
    status: "generating",
    statusText: "旧项目状态",
    shots: [{ id: "008", title: "第八镜", status: "正在生成视频" }, { id: "009", title: "第九镜", status: "等待生成" }],
  },
  request: {
    confirmed: false,
    settings: { videoModel: "旧请求模型" },
    shots: [{ id: "008", title: "第八镜" }, { id: "009", title: "第九镜" }],
  },
  requestMtimeMs: 400,
  generationState: {
    status: "failed",
    requestMtimeMs: 400,
    currentStep: "旧状态不得覆盖",
    error: "旧错误不得覆盖",
  },
  activeRun: {
    runId: "run-authoritative",
    status: "processing",
    activeShotId: "008",
    startedAt: "2026-10-11T00:00:00Z",
    queue: ["008", "009"],
    shots: {
      "008": {
        id: "008",
        status: "video-processing",
        stage: "provider-generation",
        taskId: "task-authoritative",
        progress: 68,
        elapsedMs: 120000,
        paidTaskSubmitted: true,
        generationContext: { settings: { videoModel: "MiniMax-H3" } },
      },
      "009": { id: "009", status: "queued", stage: "queued", progress: null, paidTaskSubmitted: false },
    },
  },
  selectedShotId: "008",
  nowMs,
});
assert.strictEqual(authoritativeActiveRun.status, "processing", "activeRun must override legacy generation state");
assert.strictEqual(authoritativeActiveRun.statusText, "镜头 008 · 生成中");
assert.strictEqual(authoritativeActiveRun.error, null);
assert.deepStrictEqual(authoritativeActiveRun.lockedShotIds, ["008", "009"]);
assert.strictEqual(authoritativeActiveRun.locked, false, "an active run must not lock the whole draft");
assert.deepStrictEqual(authoritativeActiveRun.progress, { percent: 68, indeterminate: false, label: "分镜队列" });
assert.deepStrictEqual(authoritativeActiveRun.current, { step: "镜头 008 · 生成中", model: "MiniMax-H3", elapsedMs: 120000 });
assert.strictEqual(authoritativeActiveRun.cockpit.monitor.taskId, "task-authoritative");
assert.strictEqual(authoritativeActiveRun.cockpit.rail.items[1].locked, true, "confirmed queued shots must lock before paid submission starts");

const activeRunWithoutProgress = deriveWorkbenchState({
  project: {
    title: "无数值进度",
    status: "generating",
    shots: [{ id: "008", status: "正在生成视频" }],
  },
  request: { confirmed: false, shots: [{ id: "008" }] },
  activeRun: {
    runId: "run-no-progress",
    status: "processing",
    activeShotId: "008",
    queue: ["008"],
    shots: { "008": { id: "008", status: "video-processing", stage: "provider-generation", progress: null } },
  },
  selectedShotId: "008",
  nowMs,
});
assert.deepStrictEqual(activeRunWithoutProgress.progress, { percent: null, indeterminate: true, label: "分镜队列" });
assert.strictEqual(activeRunWithoutProgress.cockpit.monitor.progress, null);

const legacyCurrentRunFailed = deriveWorkbenchState({
  project: {
    folder: "山竹视频复刻/旧失败状态",
    title: "旧失败状态",
    status: "generating",
    shots: [{ id: "001", title: "旧镜头", status: "等待生成" }],
  },
  request: { confirmed: false, shots: [{ id: "001", title: "旧镜头" }] },
  currentRun: {
    runId: "legacy-state-failed",
    compatibilitySource: "legacy-state",
    status: "failed",
    stage: "镜头 001",
    error: { message: "旧任务失败", action: "检查旧任务记录后重试" },
    queue: [],
    shots: {},
  },
  selectedShotId: "001",
  nowMs,
});
assert.strictEqual(legacyCurrentRunFailed.status, "failed");
assert.strictEqual(legacyCurrentRunFailed.statusText, "旧任务失败");
assert.deepStrictEqual(legacyCurrentRunFailed.current, { step: "镜头 001", model: "", elapsedMs: 0 });
assert.strictEqual(legacyCurrentRunFailed.error, "旧任务失败");
assert.strictEqual(legacyCurrentRunFailed.cockpit.monitor.status, "failed");
assert.deepStrictEqual(legacyCurrentRunFailed.cockpit.monitor.error, {
  message: "旧任务失败",
  nextAction: "检查旧任务记录后重试",
});

const legacyCurrentRunStopped = deriveWorkbenchState({
  project: {
    folder: "山竹视频复刻/旧停止状态",
    title: "旧停止状态",
    status: "generating",
    shots: [{ id: "001", title: "旧镜头", status: "等待生成" }],
  },
  request: { confirmed: false, shots: [{ id: "001", title: "旧镜头" }] },
  currentRun: {
    runId: "legacy-state-stopped",
    compatibilitySource: "legacy-state",
    status: "stopped",
    stage: "镜头 001",
    error: { message: "用户停止", action: "可重新选择镜头生成" },
    queue: [],
    shots: {},
  },
  selectedShotId: "001",
  nowMs,
});
assert.strictEqual(legacyCurrentRunStopped.status, "stopped");
assert.strictEqual(legacyCurrentRunStopped.statusText, "用户停止");
assert.deepStrictEqual(legacyCurrentRunStopped.current, { step: "镜头 001", model: "", elapsedMs: 0 });
assert.strictEqual(legacyCurrentRunStopped.error, "用户停止");
assert.deepStrictEqual(legacyCurrentRunStopped.cockpit.monitor.error, {
  message: "用户停止",
  nextAction: "可重新选择镜头生成",
});

const assetsReady = deriveWorkbenchState({
  project: {
    folder: "山竹视频复刻/资产完成",
    title: "资产完成",
    status: "generating",
    characterAsset: { id: "hero", imagePath: "人物.png" },
    productAssets: [{ id: "cup", imagePath: "杯子.png" }],
    sceneAssets: [{ id: "room", imagePath: "房间.png" }],
  },
  request: {
    confirmed: true,
    products: [{ id: "cup" }],
    scenes: [{ id: "room" }],
    shots: [],
    settings: { videoModel: "MiniMax-H3" },
  },
  generationState: {},
  nowMs,
});
assert.deepStrictEqual(assetsReady.progress, { percent: 45, indeterminate: false, label: "参考资产" });
assert.deepStrictEqual(assetsReady.assets, {
  character: { id: "hero", imagePath: "人物.png" },
  products: [{ id: "cup", imagePath: "杯子.png" }],
  scenes: [{ id: "room", imagePath: "房间.png" }],
});
assert.strictEqual(assetsReady.current.model, "MiniMax-H3");

const generating = deriveWorkbenchState({
  project: {
    status: "generating",
    statusText: "正在生成",
    videoModel: "MiniMax-H3",
    shots: [
      { id: "001", status: "已完成", videoPath: "001.mp4" },
      { id: "002", status: "正在生成视频" },
      { id: "003", status: "等待生成" },
    ],
  },
  request: { confirmed: true, shots: [{}, {}, {}] },
  requestMtimeMs: 100,
  generationState: {
    status: "processing",
    requestMtimeMs: 100,
    currentStep: "镜头 002",
    startedAt: "2026-10-11T00:00:00Z",
  },
  nowMs,
});
assert.strictEqual(generating.progress.percent, 60);
assert.strictEqual(generating.progress.indeterminate, true);
assert.strictEqual(generating.current.elapsedMs, 120000);
assert.deepStrictEqual(generating.current, { step: "镜头 002", model: "MiniMax-H3", elapsedMs: 120000 });
assert.strictEqual(generating.locked, true);
assert.strictEqual(generating.canConfirm, false);
assert.strictEqual(generating.canStop, true);

const stopping = deriveWorkbenchState({
  project: { status: "generating" },
  request: { confirmed: true },
  requestMtimeMs: 101,
  generationState: { status: "processing", requestMtimeMs: 101, stopRequestedAt: "2026-10-11T00:01:00Z" },
});
assert.strictEqual(stopping.canStop, false, "a recorded stop request must disable repeated stop actions");

assert.deepStrictEqual(calculateStageProgress({
  project: {
    status: "generating",
    shots: [
      { status: "失败", videoPath: "stale.mp4" },
      { status: "已完成" },
      { status: "等待生成" },
    ],
  },
  request: { shots: [{}, {}, {}] },
  generationState: { status: "processing" },
}), { percent: 60, indeterminate: true, label: "分镜视频" });

const completed = deriveWorkbenchState({
  project: {
    folder: "山竹视频复刻/完成",
    title: "完成",
    status: "completed",
    statusText: "全部镜头已生成并拼接为最终成片",
    finalVideoPath: "山竹视频复刻/完成/04-最终成片/最终成片.mp4",
    shots: [{ id: "001", status: "已完成", videoPath: "001.mp4" }],
  },
  request: { confirmed: true, shots: [{}] },
  requestMtimeMs: 102,
  generationState: { status: "completed", requestMtimeMs: 102, currentStep: "完成" },
  nowMs,
});
assert.deepStrictEqual(completed.progress, { percent: 100, indeterminate: false, label: "成片完成" });
assert.deepStrictEqual(completed.output, {
  finalVideoPath: "山竹视频复刻/完成/04-最终成片/最终成片.mp4",
  concatError: "",
});

const completedSelectedShot = deriveWorkbenchState({
  project: {
    folder: "山竹视频复刻/可重做",
    title: "可重做",
    status: "completed",
    statusText: "全部镜头已生成并拼接为最终成片",
    finalVideoPath: "山竹视频复刻/可重做/04-最终成片/最终成片.mp4",
    shots: [{ id: "001", status: "已完成", videoPath: "001.mp4" }],
  },
  request: { confirmed: false, shots: [{ id: "001" }] },
  generationQueue: {
    status: "completed",
    shots: [{ id: "001", status: "completed" }],
  },
  nowMs,
});
assert.strictEqual(completedSelectedShot.locked, false, "a completed selected-shot queue must unlock the draft");
assert.strictEqual(completedSelectedShot.canGenerate, true, "a completed shot must remain editable and regeneratable");
assert.deepStrictEqual(completedSelectedShot.lockedShotIds, []);

const legacy = deriveWorkbenchState({
  project: { folder: "山竹视频复刻/旧项目", status: "analysis_ready", productAssets: null },
  request: { version: 2, confirmed: false, scenes: [], shots: [] },
  generationState: new Error("损坏状态"),
  nowMs,
});
assert.deepStrictEqual(legacy.assets.products, []);
assert.deepStrictEqual(legacy.current, { step: "", model: "", elapsedMs: 0 });
assert.strictEqual(legacy.error, null);
assert.strictEqual(legacy.canConfirm, true);
assert.strictEqual(legacy.canStop, false);

assert.deepStrictEqual(deriveWorkbenchState({
  project: [],
  request: "损坏请求",
  generationState: null,
  nowMs: "错误时间",
}), empty);

const errors = deriveWorkbenchState({
  project: {
    status: "completed_with_errors",
    statusText: "项目状态错误",
    shots: [{ error: "镜头错误" }],
  },
  request: { confirmed: true },
  requestMtimeMs: 103,
  generationState: { status: "failed", requestMtimeMs: 103, error: "结构化错误" },
  nowMs,
});
assert.strictEqual(errors.error, "结构化错误");

const stoppedSameRequest = deriveWorkbenchState({
  project: { folder: "山竹视频复刻/停止", status: "generating", statusText: "旧的生成中状态" },
  request: { confirmed: true },
  requestMtimeMs: 200,
  generationState: { status: "stopped", requestMtimeMs: 200, error: "用户停止" },
  nowMs,
});
assert.strictEqual(stoppedSameRequest.status, "stopped", "same-request terminal state must override stale project generating status");
assert.strictEqual(stoppedSameRequest.statusText, "用户停止");
assert.strictEqual(stoppedSameRequest.error, "用户停止");

const failedSameRequest = deriveWorkbenchState({
  project: { folder: "山竹视频复刻/失败", status: "generating", statusText: "旧的生成中状态" },
  request: { confirmed: true },
  requestMtimeMs: 201,
  generationState: { status: "failed", requestMtimeMs: 201, error: "本次请求失败" },
  nowMs,
});
assert.strictEqual(failedSameRequest.status, "failed");
assert.strictEqual(failedSameRequest.statusText, "本次请求失败");
assert.strictEqual(failedSameRequest.error, "本次请求失败");

const staleState = deriveWorkbenchState({
  project: { folder: "山竹视频复刻/新草案", status: "analysis_ready", statusText: "等待确认" },
  request: { confirmed: false },
  requestMtimeMs: 301,
  generationState: {
    status: "processing",
    requestMtimeMs: 300,
    currentStep: "旧请求镜头",
    error: "旧请求错误",
  },
  nowMs,
});
assert.strictEqual(staleState.status, "analysis_ready", "an old generation state must not relabel a new request");
assert.strictEqual(staleState.locked, false, "an old generation state must not lock a new draft");
assert.strictEqual(staleState.canConfirm, true);
assert.strictEqual(staleState.canStop, false);
assert.deepStrictEqual(staleState.current, { step: "", model: "", elapsedMs: 0 });
assert.strictEqual(staleState.error, null);
const unknownMtimeState = deriveWorkbenchState({
  project: { folder: "山竹视频复刻/未知时间", status: "analysis_ready" },
  request: { confirmed: false },
  requestMtimeMs: null,
  generationState: { status: "processing", requestMtimeMs: null, currentStep: "不得采用" },
  nowMs,
});
assert.strictEqual(unknownMtimeState.canConfirm, true, "missing mtimes must not be coerced into a false state match");
assert.strictEqual(unknownMtimeState.canStop, false);
assert.strictEqual(deriveWorkbenchState({
  project: { status: "completed_with_errors", statusText: "项目状态错误", shots: [{ error: "镜头错误" }] },
  request: { confirmed: true },
  generationState: {},
  nowMs,
}).error, "项目状态错误");
assert.strictEqual(deriveWorkbenchState({
  project: { status: "generating", shots: [{ status: "失败", error: "镜头错误" }] },
  request: { confirmed: true },
  generationState: {},
  nowMs,
}).error, "镜头错误");

const signature = stateSignature(generating);
assert.strictEqual(stateSignature({ ...generating, ignored: "不会显示" }), signature);
assert.notStrictEqual(stateSignature({ ...generating, statusText: "已变化" }), signature);
assert.deepStrictEqual(
  Object.keys(require("../replica-ui-state.cjs")).sort(),
  ["calculateStageProgress", "deriveWorkbenchState", "stateSignature"],
);

console.log("replica-ui-state: ok");
