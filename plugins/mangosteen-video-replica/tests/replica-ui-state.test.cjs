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
  canStop: false,
  progress: { percent: 0, indeterminate: false, label: "等待开始" },
  current: { step: "", model: "", elapsedMs: 0 },
  assets: { character: null, products: [], scenes: [] },
  shots: [],
  output: { finalVideoPath: "", concatError: "" },
  error: null,
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
assert.strictEqual(ready.canStop, false);

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
