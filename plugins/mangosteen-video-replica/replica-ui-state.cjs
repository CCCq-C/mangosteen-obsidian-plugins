const { deriveCockpitModel } = require("./replica-cockpit-model.cjs");
const { lockedShotIds: queueLockedShotIds } = require("./generation-queue.cjs");

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : {};
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function records(value) {
  return Array.isArray(value) ? value.map((item) => ({ ...plainObject(item) })) : [];
}

function calculateStageProgress(options = {}) {
  const input = plainObject(options);
  const project = plainObject(input.project);
  const request = plainObject(input.request);
  const generationState = plainObject(input.generationState);
  const generationQueue = plainObject(input.generationQueue);

  if (text(project.finalVideoPath)) return { percent: 100, indeterminate: false, label: "成片完成" };
  if (generationState.currentStep === "拼接成片") return { percent: 95, indeterminate: true, label: "拼接成片" };

  const queueShots = records(generationQueue.shots);
  const queueActive = queueShots.some((shot) => shot.status === "queued" || shot.status === "processing")
    && ["idle", "processing"].includes(text(generationQueue.status));
  if (queueActive) {
    const terminal = queueShots.filter((shot) => ["completed", "failed", "stopped"].includes(text(shot.status))).length;
    return {
      percent: Math.round(45 + (terminal / Math.max(1, queueShots.length)) * 45),
      indeterminate: queueShots.some((shot) => shot.status === "processing"),
      label: "分镜队列",
    };
  }

  const shots = records(project.shots);
  const total = Math.max(shots.length, Array.isArray(request.shots) ? request.shots.length : 0);
  const completed = shots.filter((shot) => (
    shot.status !== "失败" && (text(shot.videoPath) || shot.status === "已完成")
  )).length;
  if (total > 0 && ["generating", "processing", "completed_with_errors"].includes(project.status || generationState.status)) {
    return {
      percent: Math.round(45 + (completed / total) * 45),
      indeterminate: generationState.status === "processing",
      label: "分镜视频",
    };
  }

  const expectedScenes = Array.isArray(request.scenes) ? request.scenes.length : 0;
  const readyScenes = records(project.sceneAssets).filter((asset) => text(asset.imagePath)).length;
  const assetsReady = Boolean(text(plainObject(project.characterAsset).imagePath))
    && expectedScenes > 0
    && readyScenes >= expectedScenes;
  if (assetsReady) return { percent: 45, indeterminate: false, label: "参考资产" };
  if (project.status === "analysis_ready" || request.confirmed === false) {
    return { percent: 30, indeterminate: false, label: "AI 分析" };
  }
  if (["prepared", "analyzing", "analysis_failed", "analysis_model_error"].includes(project.status)) {
    return {
      percent: project.status === "prepared" ? 15 : 30,
      indeterminate: project.status === "analyzing",
      label: "AI 分析",
    };
  }
  return { percent: 0, indeterminate: false, label: "等待开始" };
}

function errorStatus(status) {
  return status === "failed" || status === "completed_with_errors" || /_failed$|_error$/.test(text(status));
}

function activeRunQueueShots(activeRun) {
  const run = plainObject(activeRun);
  const shots = plainObject(run.shots);
  const queue = Array.isArray(run.queue) ? run.queue : Object.keys(shots);
  return queue.map((id) => {
    const shot = plainObject(shots[String(id)]);
    const status = text(shot.status);
    return {
      ...plainObject(shot.confirmedPayload),
      ...shot,
      id: text(shot.id) || String(id),
      status: ["queued", "completed", "failed", "stopped"].includes(status) ? status : "processing",
      error: typeof shot.error === "object" && shot.error ? text(shot.error.message) : text(shot.error),
    };
  });
}

function deriveWorkbenchState(options = {}) {
  const input = plainObject(options);
  const project = plainObject(input.project);
  const request = plainObject(input.request);
  const suppliedActiveRun = plainObject(input.activeRun);
  const suppliedCurrentRun = plainObject(input.currentRun);
  const activeRun = suppliedActiveRun.runId
    ? suppliedActiveRun
    : suppliedCurrentRun.runId
      ? suppliedCurrentRun
      : {};
  const hasActiveRun = Boolean(activeRun.runId);
  const loadedGenerationState = plainObject(input.generationState);
  const generationQueue = plainObject(input.generationQueue);
  const requestMtimeMs = typeof input.requestMtimeMs === "number" ? input.requestMtimeMs : Number.NaN;
  const generationRequestMtimeMs = typeof loadedGenerationState.requestMtimeMs === "number"
    ? loadedGenerationState.requestMtimeMs
    : Number.NaN;
  const generationState = !hasActiveRun && Number.isFinite(requestMtimeMs)
    && Number.isFinite(generationRequestMtimeMs)
    && generationRequestMtimeMs === requestMtimeMs
    ? loadedGenerationState
    : {};
  const empty = Object.keys(project).length === 0;
  const shots = records(project.shots);
  const processing = generationState.status === "processing";
  const cockpit = deriveCockpitModel({
    project,
    draft: request,
    activeRun,
    selectedShotId: input.selectedShotId,
    nowMs: input.nowMs,
  });
  const queueShots = hasActiveRun ? activeRunQueueShots(activeRun) : records(generationQueue.shots);
  const lockedShotIds = queueLockedShotIds(hasActiveRun ? activeRun : generationQueue);
  const queueActive = hasActiveRun
    ? ["queued", "processing", "stopping"].includes(text(activeRun.status))
    : lockedShotIds.length > 0 && ["idle", "processing"].includes(text(generationQueue.status));
  const queueKnown = hasActiveRun || Object.keys(generationQueue).length > 0;
  const locked = empty || (!hasActiveRun && (request.confirmed === true || processing
    || (!queueKnown && !generationState.status && project.status === "generating")));
  const requestedSettings = plainObject(request.settings);
  const processingQueueShot = queueShots.find((shot) => shot.status === "processing");
  const processingProjectShot = processingQueueShot
    ? shots.find((shot) => text(shot.id) === text(processingQueueShot.id))
    : null;
  const legacyQueueStep = processingQueueShot
    ? `镜头 ${text(processingQueueShot.id, "-")} · ${text(processingProjectShot?.status, "生成中")}`
    : queueShots.some((shot) => shot.status === "queued")
      ? "等待生成下一个镜头"
      : "";
  const queueStep = hasActiveRun ? cockpit.header.currentText : legacyQueueStep;
  const currentStep = hasActiveRun ? text(activeRun.stage) || queueStep : queueStep || text(generationState.currentStep);
  const startedAtMs = Date.parse(text(generationState.startedAt) || text(generationQueue.startedAt) || text(generationQueue.createdAt));
  const currentNowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const elapsedMs = Number.isFinite(startedAtMs)
    ? Math.max(0, currentNowMs - startedAtMs)
    : 0;
  const stateError = text(generationState.error);
  const projectError = errorStatus(generationState.status) || errorStatus(project.status)
    ? text(project.statusText)
    : "";
  const shotError = [...shots, ...queueShots].map((shot) => text(shot.error)).find(Boolean) || "";
  const characterAsset = plainObject(project.characterAsset);
  const authoritativeStatusText = text(generationState.statusText)
    || (["stopped", "failed"].includes(generationState.status) ? stateError : "");
  const progressProject = generationState.status ? { ...project, status: generationState.status } : project;
  const progress = hasActiveRun
    ? {
      percent: cockpit.monitor.progress,
      indeterminate: queueActive && cockpit.monitor.progress === null,
      label: "分镜队列",
    }
    : calculateStageProgress({ project: progressProject, request, generationState, generationQueue });
  const activeError = hasActiveRun ? cockpit.monitor.error?.message || "" : "";
  const activeModel = hasActiveRun ? cockpit.monitor.model : "";
  const activeElapsedMs = hasActiveRun ? cockpit.monitor.elapsedMs : elapsedMs;
  const queueStatus = hasActiveRun ? text(activeRun.status) : text(generationQueue.status);
  const stopRequested = hasActiveRun ? activeRun.stopRequested === true : generationQueue.stopRequested === true;
  const activeErrorStatus = ["failed", "stopped", "recovery-pending"].includes(cockpit.monitor.status);

  return {
    empty,
    folder: text(project.folder),
    title: text(project.title),
    status: text(hasActiveRun ? activeRun.status : queueActive ? generationQueue.status : generationState.status || project.status),
    statusText: (hasActiveRun && activeErrorStatus ? activeError : "")
      || queueStep
      || (hasActiveRun ? activeError : authoritativeStatusText)
      || text(project.statusText),
    locked,
    canConfirm: !locked && project.status === "analysis_ready" && request.confirmed === false,
    canGenerate: !locked
      && !stopRequested
      && request.confirmed !== true
      && ["analysis_ready", "generating", "completed", "completed_with_errors"].includes(text(project.status)),
    canStop: (queueActive && !stopRequested)
      || (processing && !text(generationState.stopRequestedAt)),
    queueStatus,
    queueShots,
    lockedShotIds,
    progress,
    current: {
      step: currentStep,
      model: text(activeModel || generationState.model || project.videoModel || requestedSettings.videoModel || project.imageModel || requestedSettings.imageModel),
      elapsedMs: activeElapsedMs,
    },
    assets: {
      character: Object.keys(characterAsset).length ? { ...characterAsset } : null,
      products: records(project.productAssets),
      scenes: records(project.sceneAssets),
    },
    shots,
    output: {
      finalVideoPath: text(project.finalVideoPath),
      concatError: text(project.concatError),
    },
    error: activeError || stateError || projectError || shotError || null,
    cockpit,
  };
}

function stateSignature(viewModel) {
  const state = plainObject(viewModel);
  return JSON.stringify({
    empty: state.empty,
    folder: state.folder,
    title: state.title,
    status: state.status,
    statusText: state.statusText,
    locked: state.locked,
    canConfirm: state.canConfirm,
    canGenerate: state.canGenerate,
    canStop: state.canStop,
    queueStatus: state.queueStatus,
    queueShots: state.queueShots,
    lockedShotIds: state.lockedShotIds,
    progress: state.progress,
    current: state.current,
    assets: state.assets,
    shots: state.shots,
    output: state.output,
    error: state.error,
    cockpit: state.cockpit,
  });
}

module.exports = {
  calculateStageProgress,
  deriveWorkbenchState,
  stateSignature,
};
