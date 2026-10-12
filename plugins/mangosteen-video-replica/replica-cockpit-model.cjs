const { classifyModel } = require("./generation-policy.cjs");
const { lockedShotIds } = require("./generation-queue.cjs");

const ACTIVE_RUN_STATUSES = new Set(["queued", "processing", "stopping"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numericProgress(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function shotId(shot, index) {
  return text(shot?.id) || String(index + 1).padStart(3, "0");
}

function runShots(activeRun) {
  const source = activeRun?.shots;
  if (Array.isArray(source)) return new Map(source.map((shot, index) => [shotId(shot, index), plainObject(shot)]));
  if (!source || typeof source !== "object") return new Map();
  return new Map(Object.entries(source).map(([id, shot]) => [text(shot?.id) || id, plainObject(shot)]));
}

function normalizedStatus(runShot, projectShot, isActiveShot, hasRunShot) {
  const source = hasRunShot ? text(runShot.status) : text(projectShot.status);
  const value = source.toLowerCase();
  if (value === "completed" || source === "已完成" || (!hasRunShot && text(projectShot.videoPath))) return "completed";
  if (["failed", "partial-failure", "completed_with_errors"].includes(value)
      || source === "失败" || /_failed$|_error$/.test(value)) return "failed";
  if (value === "stopped") return "stopped";
  if (runShot.submissionReservation || value === "submission-reserved" || value === "reserved") return "reserved";
  if (value === "recovery-pending" || value === "recovery") return "recovery-pending";
  if (["queued", "pending", "waiting", "idle"].includes(value) || source === "等待生成") return "pending";
  if (isActiveShot || [
    "processing", "preparing", "image-processing", "reference-processing", "video-submitting",
    "video-submitted", "video-processing", "saving", "generating",
  ].includes(value) || /^正在/.test(source)) return "processing";
  return "ready";
}

function paidTaskSubmitted(runShot, projectShot, hasRunShot) {
  if (hasRunShot) {
    return runShot.paidTaskSubmitted === true
      || Boolean(text(runShot.taskId) || runShot.submissionReservation);
  }
  return Boolean(text(projectShot.videoTaskId));
}

function lockState(status, paid, isActiveShot, queued) {
  if (queued) {
    return status === "processing"
      ? { locked: true, lockReason: "当前镜头正在生成" }
      : { locked: true, lockReason: "已加入生成队列，完成或停止前不能编辑" };
  }
  if (TERMINAL_STATUSES.has(status) || status === "ready" || status === "pending") {
    if (status === "pending" && paid) {
      return { locked: true, lockReason: "付费任务已保留，完成核对前不能编辑" };
    }
    return { locked: false, lockReason: null };
  }
  if (status === "reserved" || status === "recovery-pending" || paid) {
    return { locked: true, lockReason: "付费任务已保留，完成核对前不能编辑" };
  }
  if (status === "processing" && isActiveShot) {
    return { locked: true, lockReason: "当前镜头正在生成" };
  }
  return { locked: false, lockReason: null };
}

function normalizedError(error, status, paid) {
  if (!error && status !== "failed" && status !== "recovery-pending") return null;
  const source = plainObject(error);
  const message = text(source.message) || text(error) || (status === "failed" ? "镜头生成失败" : "任务状态需要核对");
  const nextAction = text(source.action) || text(source.nextAction)
    || (paid ? "检查供应商任务记录并继续查询原任务" : "检查镜头设置后重试");
  return { message, nextAction };
}

function legacyTimeline(shot) {
  if (Array.isArray(shot.timeline)) return clone(shot.timeline);
  const hasLegacyFields = ["plot", "dialogue", "voiceDirection", "camera", "environment"]
    .some((key) => text(shot[key]));
  if (!hasLegacyFields) return [];
  const duration = Number(shot.duration);
  return [{
    start: 0,
    end: Number.isFinite(duration) && duration >= 0 ? duration : null,
    action: text(shot.plot),
    dialogue: text(shot.dialogue),
    performance: text(shot.performance) || text(shot.voiceDirection),
    camera: text(shot.camera),
    environment: text(shot.environment),
  }];
}

function shotReferences(shot, project) {
  if (Array.isArray(shot.references)) return clone(shot.references);
  if (Array.isArray(shot.referenceImagePaths)) return clone(shot.referenceImagePaths);
  const references = [];
  const characterPath = text(project.characterAsset?.imagePath);
  if (characterPath) references.push(characterPath);
  const scene = (Array.isArray(project.sceneAssets) ? project.sceneAssets : [])
    .find((item) => text(item?.id) === text(shot.sceneId));
  if (text(scene?.imagePath)) references.push(text(scene.imagePath));
  const productIds = new Set(Array.isArray(shot.productIds) ? shot.productIds.map(String) : []);
  for (const product of Array.isArray(project.productAssets) ? project.productAssets : []) {
    if (productIds.has(String(product?.id)) && text(product?.imagePath)) references.push(text(product.imagePath));
  }
  return references;
}

function effectivePrompt(shot, runShot, locked) {
  const confirmed = plainObject(runShot.confirmedPayload);
  const source = locked ? confirmed : shot;
  return text(source.effectiveVideoPrompt) || text(source.videoPromptOverride) || text(source.videoPrompt)
    || text(shot.effectiveVideoPrompt) || text(shot.videoPromptOverride) || text(shot.videoPrompt);
}

function stageIndex(stage) {
  const value = text(stage).toLowerCase();
  if (["reference-assets", "preflight"].includes(value)) return 0;
  if (value === "first-frame") return 1;
  if (value === "last-frame") return 2;
  if (["provider-submission", "video-submission", "provider-generation"].includes(value)) return 3;
  if (value === "saving" || value === "provider-saving") return 4;
  if (value === "completed") return 4;
  return -1;
}

function stageRequirements(runShot, fallbackShot) {
  const source = plainObject(runShot);
  const fallback = plainObject(fallbackShot);
  if (!Object.keys(source).length && !Object.keys(fallback).length) {
    return { needsFirstFrame: null, needsLastFrame: null };
  }
  const context = plainObject(source.generationContext);
  const confirmed = Object.keys(plainObject(source.confirmedPayload)).length
    ? plainObject(source.confirmedPayload)
    : fallback;
  const explicitPlan = plainObject(source.stagePlan);
  const explicitFirst = typeof source.needsFirstFrame === "boolean"
    ? source.needsFirstFrame
    : typeof explicitPlan.needsFirstFrame === "boolean"
      ? explicitPlan.needsFirstFrame
      : typeof context.needsFirstFrame === "boolean"
        ? context.needsFirstFrame
        : null;
  const explicitLast = typeof source.needsLastFrame === "boolean"
    ? source.needsLastFrame
    : typeof explicitPlan.needsLastFrame === "boolean"
      ? explicitPlan.needsLastFrame
      : typeof context.needsLastFrame === "boolean"
        ? context.needsLastFrame
        : null;
  const structuredTimeline = Number(context.requestVersion) >= 4
    && Array.isArray(confirmed.timeline) && confirmed.timeline.length > 0;
  const model = text(plainObject(context.settings).videoModel);
  const directReferenceMode = structuredTimeline && classifyModel(model) === "seedance";
  return {
    needsFirstFrame: explicitFirst === null ? !directReferenceMode : explicitFirst,
    needsLastFrame: explicitLast === null
      ? !structuredTimeline && Boolean(text(confirmed.lastImagePrompt))
      : explicitLast,
  };
}

function monitorStages(status, stage, requirements) {
  const items = [
    { id: "references", label: "参考资产" },
    { id: "first-frame", label: "首帧", required: requirements.needsFirstFrame },
    { id: "last-frame", label: "尾帧", required: requirements.needsLastFrame },
    { id: "provider", label: "视频生成" },
    { id: "saving", label: "保存成片" },
  ];
  if (status === "completed") {
    return items.map(({ required, ...item }) => ({
      ...item,
      status: required === false ? "skipped" : "done",
    }));
  }
  const current = stageIndex(stage);
  const stages = items.map(({ required, ...item }, index) => ({
    ...item,
    status: required === false
      ? "skipped"
      : current < 0
        ? "waiting"
        : index < current
          ? "done"
          : index === current
            ? status === "failed" ? "failed" : "active"
            : "waiting",
  }));
  const rawStage = text(stage);
  if (current < 0 && rawStage) {
    stages.push({
      id: `raw:${rawStage}`,
      label: rawStage,
      status: status === "failed"
        ? "failed"
        : ACTIVE_RUN_STATUSES.has(status) || ["processing", "reserved", "recovery-pending"].includes(status)
          ? "active"
          : "waiting",
    });
  }
  return stages;
}

function taskIdAvailability(taskId, status, paid) {
  if (text(taskId)) return "available";
  if (status === "recovery-pending") return "recovery-pending";
  if (paid || status === "reserved") return "platform-pending";
  return "not-submitted";
}

function statusLabel(status) {
  return {
    completed: "已完成",
    failed: "生成失败",
    stopped: "已停止",
    reserved: "付费任务已保留",
    "recovery-pending": "待恢复",
    processing: "生成中",
    pending: "等待生成",
    ready: "可编辑",
  }[status] || "";
}

function deriveCockpitModel(options = {}) {
  const input = plainObject(options);
  const project = plainObject(input.project);
  const draft = plainObject(input.draft);
  const activeRun = plainObject(input.activeRun);
  const draftShots = Array.isArray(draft.shots) ? draft.shots : [];
  const projectShots = Array.isArray(project.shots) ? project.shots : [];
  const sourceShots = draftShots.length ? draftShots : projectShots;
  const projectById = new Map(projectShots.map((shot, index) => [shotId(shot, index), plainObject(shot)]));
  const activeShots = runShots(activeRun);
  const queueLockedIds = new Set(lockedShotIds(activeRun));
  const activeShotId = text(activeRun.activeShotId);

  const items = sourceShots.map((sourceShot, index) => {
    const id = shotId(sourceShot, index);
    const projectShot = projectById.get(id) || {};
    const shot = { ...clone(projectShot), ...clone(plainObject(sourceShot)), id };
    const hasRunShot = activeShots.has(id);
    const runShot = activeShots.get(id) || {};
    const isActiveShot = activeShotId === id;
    const status = normalizedStatus(runShot, projectShot, isActiveShot, hasRunShot);
    const paid = paidTaskSubmitted(runShot, projectShot, hasRunShot);
    const lock = lockState(status, paid, isActiveShot, queueLockedIds.has(id));
    return {
      id,
      title: text(shot.title),
      status,
      selected: false,
      locked: lock.locked,
      lockReason: lock.lockReason,
      paidTaskSubmitted: paid,
      taskId: (hasRunShot ? text(runShot.taskId) : text(projectShot.videoTaskId)) || null,
      progress: hasRunShot ? numericProgress(runShot.progress) : numericProgress(projectShot.videoTaskProgress),
      error: normalizedError(hasRunShot ? runShot.error : projectShot.error, status, paid),
      shot,
      runShot,
      hasRunShot,
    };
  });

  const requestedId = text(input.selectedShotId);
  const selected = items.find((item) => item.id === requestedId)
    || items.find((item) => item.id === activeShotId)
    || items[0]
    || null;
  if (selected) selected.selected = true;

  const selectedRunShot = plainObject(selected?.runShot);
  const selectedHasRunShot = selected?.hasRunShot === true;
  const selectedShot = plainObject(selected?.shot);
  const selectedStatus = selected?.status || "idle";
  const selectedPaid = selected?.paidTaskSubmitted === true;
  const activeMonitorRunShot = activeShotId ? plainObject(activeShots.get(activeShotId)) : {};
  const useActiveShot = Boolean(activeShotId && activeShots.has(activeShotId));
  const useRunLevel = !useActiveShot && Boolean(activeRun.runId)
    && (activeRun.compatibilitySource === "legacy-state" || !selectedHasRunShot);
  const monitorSource = useActiveShot ? activeMonitorRunShot : useRunLevel ? activeRun : selectedRunShot;
  const monitorShotId = useActiveShot ? activeShotId : useRunLevel ? activeShotId || null : selected?.id || null;
  const monitorProjectShot = monitorShotId ? projectById.get(monitorShotId) || {} : selectedShot;
  const monitorHasRunShot = useActiveShot || (!useRunLevel && selectedHasRunShot);
  const monitorStatus = useRunLevel
    ? normalizedStatus(activeRun, {}, ACTIVE_RUN_STATUSES.has(text(activeRun.status)), true)
    : useActiveShot
      ? normalizedStatus(activeMonitorRunShot, monitorProjectShot, true, true)
      : selectedStatus;
  const monitorPaid = useRunLevel
    ? activeRun.paidTaskSubmitted === true || Boolean(text(activeRun.taskId) || activeRun.submissionReservation)
    : useActiveShot
      ? paidTaskSubmitted(activeMonitorRunShot, monitorProjectShot, true)
      : selectedPaid;
  const startedAtMs = Date.parse(text(activeRun.startedAt) || text(activeRun.createdAt));
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const persistedElapsedMs = Number(monitorSource.elapsedMs);
  const elapsedMs = Number.isFinite(persistedElapsedMs) && persistedElapsedMs >= 0
    ? Math.round(persistedElapsedMs)
    : Number.isFinite(startedAtMs)
      ? Math.max(0, nowMs - startedAtMs)
      : 0;
  let monitorProgress = null;
  if (monitorShotId || useRunLevel) {
    if (useRunLevel) monitorProgress = numericProgress(activeRun.progress);
    else if (monitorHasRunShot) monitorProgress = numericProgress(monitorSource.progress);
    else monitorProgress = numericProgress(monitorProjectShot.videoTaskProgress);
  }
  const generationContext = plainObject(monitorSource.generationContext);
  const settings = plainObject(generationContext.settings);
  const monitorError = normalizedError(
    useRunLevel ? activeRun.error : monitorHasRunShot ? monitorSource.error : monitorProjectShot.error,
    monitorStatus,
    monitorPaid,
  );
  const completed = items.filter((item) => item.status === "completed").length;
  const currentText = useRunLevel && text(activeRun.stage)
    ? text(activeRun.stage)
    : monitorShotId
      ? `镜头 ${monitorShotId} · ${statusLabel(monitorStatus)}`
      : text(activeRun.stage);
  const monitorTaskId = (useRunLevel
    ? text(activeRun.taskId)
    : monitorHasRunShot
      ? text(monitorSource.taskId)
      : text(monitorProjectShot.videoTaskId)) || null;
  const requirements = stageRequirements(monitorSource, monitorProjectShot);

  const railItems = items.map(({ shot, runShot, hasRunShot, ...item }) => item);
  return {
    header: {
      title: text(project.title) || text(draft.title),
      completed,
      total: items.length,
      currentText,
      percent: monitorProgress,
    },
    rail: { items: railItems },
    editor: {
      shot: selected ? clone(selectedShot) : null,
      locked: selected ? selected.locked : true,
      lockReason: selected ? selected.lockReason : "请选择镜头",
      references: selected ? shotReferences(selectedShot, project) : [],
      timeline: selected ? legacyTimeline(selectedShot) : [],
      effectivePrompt: selected ? effectivePrompt(selectedShot, selectedRunShot, selected.locked) : "",
    },
    monitor: {
      shotId: monitorShotId,
      status: monitorStatus,
      paidTaskSubmitted: monitorPaid,
      model: text(settings.videoModel) || text(activeRun.videoModel) || text(project.videoModel) || text(draft.settings?.videoModel),
      taskId: monitorTaskId,
      taskIdAvailability: taskIdAvailability(monitorTaskId, monitorStatus, monitorPaid),
      elapsedMs,
      progress: monitorProgress,
      stages: monitorStages(monitorStatus, monitorSource.stage || monitorProjectShot.stage, requirements),
      error: monitorError,
    },
  };
}

module.exports = { deriveCockpitModel };
