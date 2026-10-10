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

  if (text(project.finalVideoPath)) return { percent: 100, indeterminate: false, label: "成片完成" };
  if (generationState.currentStep === "拼接成片") return { percent: 95, indeterminate: true, label: "拼接成片" };

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

function deriveWorkbenchState(options = {}) {
  const input = plainObject(options);
  const project = plainObject(input.project);
  const request = plainObject(input.request);
  const generationState = plainObject(input.generationState);
  const empty = Object.keys(project).length === 0;
  const shots = records(project.shots);
  const processing = generationState.status === "processing";
  const locked = empty || request.confirmed === true || processing || project.status === "generating";
  const requestedSettings = plainObject(request.settings);
  const startedAtMs = Date.parse(text(generationState.startedAt));
  const currentNowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const elapsedMs = Number.isFinite(startedAtMs)
    ? Math.max(0, currentNowMs - startedAtMs)
    : 0;
  const stateError = text(generationState.error);
  const projectError = errorStatus(generationState.status) || errorStatus(project.status)
    ? text(project.statusText)
    : "";
  const shotError = shots.map((shot) => text(shot.error)).find(Boolean) || "";
  const characterAsset = plainObject(project.characterAsset);

  return {
    empty,
    folder: text(project.folder),
    title: text(project.title),
    status: text(project.status || generationState.status),
    statusText: text(project.statusText),
    locked,
    canConfirm: !locked && project.status === "analysis_ready" && request.confirmed === false,
    canStop: processing && !text(generationState.stopRequestedAt),
    progress: calculateStageProgress({ project, request, generationState }),
    current: {
      step: text(generationState.currentStep),
      model: text(generationState.model || project.videoModel || requestedSettings.videoModel || project.imageModel || requestedSettings.imageModel),
      elapsedMs,
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
    error: stateError || projectError || shotError || null,
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
    canStop: state.canStop,
    progress: state.progress,
    current: state.current,
    assets: state.assets,
    shots: state.shots,
    output: state.output,
    error: state.error,
  });
}

module.exports = {
  calculateStageProgress,
  deriveWorkbenchState,
  stateSignature,
};
