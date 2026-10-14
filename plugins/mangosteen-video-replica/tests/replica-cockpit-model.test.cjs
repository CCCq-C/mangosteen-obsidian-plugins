const assert = require("assert");

const { deriveCockpitModel } = require("../replica-cockpit-model.cjs");

const nowMs = Date.parse("2026-10-11T15:07:00.000Z");
const draft = {
  title: "九镜头样片",
  shots: Array.from({ length: 9 }, (_, index) => {
    const id = String(index + 1).padStart(3, "0");
    return {
      id,
      title: `镜头 ${id}`,
      references: [`${id}-reference.png`],
      timeline: [{ start: 0, end: 4, action: `动作 ${id}`, dialogue: "", performance: "自然", camera: "中景", environment: "客厅" }],
      effectiveVideoPrompt: `最终提示词 ${id}`,
    };
  }),
};
const project = {
  title: "九镜头样片",
  videoModel: "旧模型不得覆盖",
  shots: draft.shots.map((shot, index) => ({
    id: shot.id,
    status: index < 7 ? "已完成" : "等待生成",
    ...(index < 7 ? { videoPath: `${shot.id}.mp4` } : {}),
  })),
};
const activeRun = {
  runId: "run-8",
  status: "processing",
  activeShotId: "008",
  startedAt: "2026-10-11T15:00:00.000Z",
  queue: ["008", "009"],
  shots: {
    "008": {
      id: "008",
      status: "video-processing",
      stage: "provider-generation",
      taskId: "task_xxx",
      progress: 68,
      elapsedMs: 402000,
      paidTaskSubmitted: true,
      generationContext: { settings: { videoModel: "MiniMax-H3" } },
      confirmedPayload: { ...draft.shots[7], effectiveVideoPrompt: "已确认提示词 008" },
    },
    "009": {
      id: "009",
      status: "queued",
      stage: "queued",
      taskId: null,
      progress: null,
      paidTaskSubmitted: false,
      generationContext: { settings: { videoModel: "MiniMax-H3" } },
      confirmedPayload: draft.shots[8],
    },
  },
};
const activeRunSnapshot = JSON.stringify(activeRun);

const model = deriveCockpitModel({ project, draft, activeRun, selectedShotId: "008", nowMs });
assert.deepStrictEqual(Object.keys(model), ["header", "rail", "editor", "monitor"]);
assert.strictEqual(model.rail.items[7].status, "processing");
assert.strictEqual(model.editor.locked, true);
assert.strictEqual(model.monitor.shotId, "008");
assert.strictEqual(model.monitor.paidTaskSubmitted, true);
assert.strictEqual(model.monitor.taskId, "task_xxx");
assert.strictEqual(model.monitor.taskIdAvailability, "available");
assert.strictEqual(model.monitor.progress, 68);
assert.deepStrictEqual(model.monitor.stages.map((item) => item.status), ["done", "done", "skipped", "active", "waiting"]);
assert.strictEqual(model.rail.items[8].paidTaskSubmitted, false);
assert.deepStrictEqual(model.header, {
  title: "九镜头样片",
  completed: 7,
  total: 9,
  currentText: "镜头 008 · 生成中",
  percent: 68,
});
assert.strictEqual(model.editor.effectivePrompt, "已确认提示词 008");
assert.deepStrictEqual(model.editor.references, ["008-reference.png"]);
assert.deepStrictEqual(model.editor.timeline, draft.shots[7].timeline);
assert.strictEqual(model.monitor.model, "MiniMax-H3");
assert.strictEqual(model.monitor.elapsedMs, 402000, "persisted elapsed time is authoritative when present");

const lockedQueued = deriveCockpitModel({ project, draft, activeRun, selectedShotId: "009", nowMs });
assert.strictEqual(lockedQueued.editor.locked, true, "a confirmed queued shot must lock before paid submission starts");
assert.match(lockedQueued.editor.lockReason, /生成队列|不能编辑/);
assert.strictEqual(lockedQueued.rail.items[8].locked, true);
assert.strictEqual(lockedQueued.monitor.shotId, "008", "viewing another queued shot must keep the active shot authoritative in the monitor");
assert.strictEqual(lockedQueued.monitor.taskId, "task_xxx");
assert.strictEqual(lockedQueued.monitor.progress, 68);

const threeShotDraft = {
  ...draft,
  shots: draft.shots.slice(0, 3),
};
const threeShotProject = {
  ...project,
  shots: project.shots.slice(0, 3).map((shot) => ({ ...shot, status: "等待生成", videoPath: undefined })),
};
const activeFirstShot = {
  runId: "run-active-001",
  status: "processing",
  activeShotId: "001",
  startedAt: "2026-10-11T15:00:00.000Z",
  queue: ["001", "002"],
  shots: {
    "001": {
      id: "001",
      status: "video-processing",
      stage: "provider-generation",
      taskId: "task-001",
      progress: 68,
      paidTaskSubmitted: true,
      generationContext: { requestVersion: 5, settings: { videoModel: "MiniMax-H3" } },
      confirmedPayload: threeShotDraft.shots[0],
    },
    "002": {
      id: "002",
      status: "queued",
      stage: "queued",
      taskId: null,
      progress: null,
      paidTaskSubmitted: false,
      generationContext: { requestVersion: 5, settings: { videoModel: "MiniMax-H3" } },
      confirmedPayload: threeShotDraft.shots[1],
    },
  },
};
for (const [selectedShotId, expectedLocked] of [["002", true], ["003", false]]) {
  const editingAnotherShot = deriveCockpitModel({
    project: threeShotProject,
    draft: threeShotDraft,
    activeRun: activeFirstShot,
    selectedShotId,
    nowMs,
  });
  assert.strictEqual(editingAnotherShot.editor.shot.id, selectedShotId);
  assert.strictEqual(editingAnotherShot.editor.locked, expectedLocked, "only shots already in the queue may be locked");
  assert.strictEqual(editingAnotherShot.monitor.shotId, "001");
  assert.strictEqual(editingAnotherShot.monitor.taskId, "task-001");
  assert.strictEqual(editingAnotherShot.monitor.progress, 68);
  assert.strictEqual(editingAnotherShot.monitor.status, "processing");
}

for (const [status, patch, expectedAvailability] of [
  ["submission-reserved", { submissionReservation: { reservationId: "reserved-without-id" }, paidTaskSubmitted: true }, "platform-pending"],
  ["recovery-pending", { paidTaskSubmitted: true, recoveryContext: { boundary: "video-submission" } }, "recovery-pending"],
  ["pending", { paidTaskSubmitted: false }, "not-submitted"],
]) {
  const taskIdentity = deriveCockpitModel({
    project: threeShotProject,
    draft: threeShotDraft,
    activeRun: {
      ...activeFirstShot,
      activeShotId: "001",
      shots: {
        ...activeFirstShot.shots,
        "001": { ...activeFirstShot.shots["001"], status, taskId: null, submissionReservation: null, ...patch },
      },
    },
    selectedShotId: "002",
    nowMs,
  });
  assert.strictEqual(taskIdentity.monitor.shotId, "001");
  assert.strictEqual(taskIdentity.monitor.taskId, null);
  assert.strictEqual(taskIdentity.monitor.taskIdAvailability, expectedAvailability);
}

function stageFixture({ videoModel, requestVersion, timeline, lastImagePrompt, stage = "provider-generation" }) {
  const confirmedPayload = {
    id: "001",
    title: "阶段测试",
    timeline,
    lastImagePrompt,
  };
  return deriveCockpitModel({
    project: { title: "阶段测试", shots: [{ id: "001", status: "等待生成" }] },
    draft: { shots: [confirmedPayload] },
    activeRun: {
      runId: "stage-run",
      status: "processing",
      activeShotId: "001",
      shots: {
        "001": {
          id: "001",
          status: "video-processing",
          stage,
          paidTaskSubmitted: true,
          taskId: "stage-task",
          generationContext: { requestVersion, settings: { videoModel } },
          confirmedPayload,
        },
      },
    },
    selectedShotId: "001",
    nowMs,
  });
}

const directReferenceStages = stageFixture({ videoModel: "seedance-2.5", requestVersion: 5, timeline: draft.shots[0].timeline });
assert.deepStrictEqual(
  directReferenceStages.monitor.stages.map(({ id, status }) => [id, status]),
  [["references", "done"], ["first-frame", "skipped"], ["last-frame", "skipped"], ["provider", "active"], ["saving", "waiting"]],
  "Seedance structured direct-reference mode must not claim skipped frames completed",
);

const firstFrameOnlyStages = stageFixture({ videoModel: "MiniMax-H3", requestVersion: 5, timeline: draft.shots[0].timeline });
assert.deepStrictEqual(
  firstFrameOnlyStages.monitor.stages.map(({ id, status }) => [id, status]),
  [["references", "done"], ["first-frame", "done"], ["last-frame", "skipped"], ["provider", "active"], ["saving", "waiting"]],
  "structured MiniMax runs must report only the required first frame",
);

const noLastFrameStages = stageFixture({ videoModel: "MiniMax-H3", requestVersion: 3, timeline: [], lastImagePrompt: "" });
assert.strictEqual(noLastFrameStages.monitor.stages.find((stage) => stage.id === "last-frame").status, "skipped");

const unknownStage = stageFixture({
  videoModel: "MiniMax-H3",
  requestVersion: 5,
  timeline: draft.shots[0].timeline,
  stage: "provider-awaiting-capacity",
});
assert(unknownStage.monitor.stages.some((stage) => stage.label === "provider-awaiting-capacity"), "unknown stages must keep their raw name");
assert.strictEqual(unknownStage.monitor.stages.some((stage) => stage.status === "done"), false, "unknown stages must not invent completed steps");

const noNumericProgress = deriveCockpitModel({
  project,
  draft,
  activeRun: {
    ...activeRun,
    shots: { ...activeRun.shots, "008": { ...activeRun.shots["008"], progress: undefined } },
  },
  selectedShotId: "008",
  nowMs,
});
assert.strictEqual(noNumericProgress.monitor.progress, null, "unknown provider progress must not be invented");
assert.strictEqual(noNumericProgress.header.percent, null);

const oldCompletedProject = {
  ...project,
  shots: project.shots.map((shot) => shot.id === "008" ? {
    ...shot,
    status: "已完成",
    videoPath: "旧成片-008.mp4",
    videoTaskId: "legacy-task-must-not-leak",
    videoTaskProgress: 72,
    error: "旧错误不得覆盖活动运行",
  } : shot),
};
const regeneratingOldShot = deriveCockpitModel({
  project: oldCompletedProject,
  draft,
  activeRun: {
    ...activeRun,
    shots: {
      ...activeRun.shots,
      "008": {
        ...activeRun.shots["008"],
        status: "video-processing",
        taskId: null,
        paidTaskSubmitted: false,
        progress: null,
        error: null,
      },
    },
  },
  selectedShotId: "008",
  nowMs,
});
assert.strictEqual(regeneratingOldShot.rail.items[7].status, "processing", "active-run status must override an old videoPath");
assert.strictEqual(regeneratingOldShot.editor.locked, true, "regenerating an old completed shot must stay locked");
assert.strictEqual(regeneratingOldShot.rail.items[7].taskId, null, "legacy task IDs must not leak into active-run shots");
assert.strictEqual(regeneratingOldShot.monitor.taskId, null, "the active-run monitor must not fall back to an older project task ID");
assert.strictEqual(regeneratingOldShot.rail.items[7].paidTaskSubmitted, false, "legacy paid markers must not leak into active-run shots");
assert.strictEqual(regeneratingOldShot.monitor.progress, null, "an explicit active-run null must override legacy progress");
assert.strictEqual(regeneratingOldShot.header.percent, null);
assert.strictEqual(regeneratingOldShot.monitor.error, null, "legacy errors must not leak into active-run shots");
assert.strictEqual(regeneratingOldShot.header.completed, 7, "the old completed artifact must not relabel the active regeneration");

const failed = deriveCockpitModel({
  project,
  draft,
  activeRun: {
    ...activeRun,
    status: "failed",
    activeShotId: null,
    shots: {
      ...activeRun.shots,
      "008": {
        ...activeRun.shots["008"],
        status: "failed",
        error: { message: "平台查询失败", action: "稍后继续查询原任务" },
      },
    },
  },
  selectedShotId: "008",
  nowMs,
});
assert.deepStrictEqual(failed.monitor.error, {
  message: "平台查询失败",
  nextAction: "稍后继续查询原任务",
});
assert.strictEqual(failed.editor.locked, false, "terminal failures must unlock editing");

const legacyStateProject = {
  title: "旧运行状态",
  shots: [{ id: "001", title: "旧镜头", status: "等待生成" }],
};
const legacyStateDraft = { shots: [{ id: "001", title: "旧镜头" }] };
const legacyStateFailed = deriveCockpitModel({
  project: legacyStateProject,
  draft: legacyStateDraft,
  activeRun: {
    runId: "legacy-state-failed",
    compatibilitySource: "legacy-state",
    status: "failed",
    stage: "镜头 001",
    error: { message: "旧任务失败", action: "检查旧任务记录后重试" },
    queue: ["001"],
    shots: { "001": { id: "001", status: "queued", stage: "queued", error: null } },
  },
  selectedShotId: "001",
  nowMs,
});
assert.strictEqual(legacyStateFailed.monitor.status, "failed");
assert.strictEqual(legacyStateFailed.header.currentText, "镜头 001");
assert.deepStrictEqual(legacyStateFailed.monitor.error, {
  message: "旧任务失败",
  nextAction: "检查旧任务记录后重试",
});

const legacyStateStopped = deriveCockpitModel({
  project: legacyStateProject,
  draft: legacyStateDraft,
  activeRun: {
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
assert.strictEqual(legacyStateStopped.monitor.status, "stopped");
assert.deepStrictEqual(legacyStateStopped.monitor.error, {
  message: "用户停止",
  nextAction: "可重新选择镜头生成",
});

const runLevelRecovery = deriveCockpitModel({
  project: legacyStateProject,
  draft: legacyStateDraft,
  activeRun: {
    runId: "run-level-recovery",
    status: "recovery-pending",
    stage: "provider-generation",
    error: { message: "供应商状态待核对", action: "继续查询原任务，禁止重复提交" },
    queue: [],
    shots: {},
  },
  selectedShotId: "001",
  nowMs,
});
assert.strictEqual(runLevelRecovery.monitor.status, "recovery-pending");
assert.deepStrictEqual(runLevelRecovery.monitor.error, {
  message: "供应商状态待核对",
  nextAction: "继续查询原任务，禁止重复提交",
});

for (const [status, patch, expectedStatus, expectedLocked] of [
  ["submission-reserved", { submissionReservation: { reservationId: "reservation-1" } }, "reserved", true],
  ["recovery-pending", { paidTaskSubmitted: true, taskId: "task-recovery" }, "recovery-pending", true],
  ["pending", { paidTaskSubmitted: false, taskId: null }, "pending", true],
]) {
  const state = deriveCockpitModel({
    project,
    draft,
    activeRun: {
      ...activeRun,
      activeShotId: "008",
      shots: { ...activeRun.shots, "008": { ...activeRun.shots["008"], status, ...patch } },
    },
    selectedShotId: "008",
    nowMs,
  });
  assert.strictEqual(state.rail.items[7].status, expectedStatus);
  assert.strictEqual(state.editor.locked, expectedLocked);
}

const legacyProject = {
  title: "旧项目",
  shots: [{
    id: "1",
    title: "旧镜头",
    status: "正在生成视频",
    videoTaskId: "legacy-task",
    videoTaskProgress: 33,
    plot: "人物举起手机",
    dialogue: "你好",
    camera: "中景推进",
    environment: "摄影棚",
    videoPrompt: "旧版完整提示词",
    referenceImagePaths: ["人物.png", "场景.png"],
  }],
};
const emptyCastModel = deriveCockpitModel({
  project: {
    title: "空镜项目",
    characterAssets: [
      { id: "female-lead", imagePath: "女主.png" },
      { id: "male-lead", imagePath: "男主.png" },
    ],
    sceneAssets: [{ id: "room", imagePath: "客厅.png" }],
    shots: [{ id: "001", title: "空镜", sceneId: "room", characterIds: [], productIds: [] }],
  },
  draft: { shots: [{ id: "001", title: "空镜", sceneId: "room", characterIds: [], productIds: [] }] },
  selectedShotId: "001",
  nowMs,
});
assert.deepStrictEqual(emptyCastModel.editor.references, ["客厅.png"], "empty shots must not inherit all character boards");
const legacy = deriveCockpitModel({ project: legacyProject, selectedShotId: "1", nowMs });
assert.strictEqual(legacy.rail.items[0].status, "processing");
assert.strictEqual(legacy.editor.shot.id, "1");
assert.strictEqual(legacy.editor.effectivePrompt, "旧版完整提示词");
assert.deepStrictEqual(legacy.editor.references, ["人物.png", "场景.png"]);
assert.deepStrictEqual(legacy.editor.timeline, [{
  start: 0,
  end: null,
  action: "人物举起手机",
  dialogue: "你好",
  performance: "",
  camera: "中景推进",
  environment: "摄影棚",
}]);
assert.strictEqual(legacy.monitor.taskId, "legacy-task");
assert.strictEqual(legacy.monitor.progress, 33);

assert.deepStrictEqual(project.shots[7], {
  id: "008",
  status: "等待生成",
}, "derivation must not mutate project data");
assert.strictEqual(JSON.stringify(activeRun), activeRunSnapshot, "derivation must not mutate active-run data");
assert.deepStrictEqual(
  Object.keys(require("../replica-cockpit-model.cjs")).sort(),
  ["deriveCockpitModel"],
);

console.log("replica-cockpit-model: ok");
