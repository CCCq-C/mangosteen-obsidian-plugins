const RUN_STATUSES = new Set([
  "queued",
  "processing",
  "stopping",
  "completed",
  "partial-failure",
  "failed",
  "stopped",
]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "processing", "stopping"]);
const TERMINAL_SHOT_STATUSES = new Set(["completed", "failed", "stopped"]);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = clone(item);
  return output;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function timestamp(value) {
  const raw = String(value ?? "").trim();
  return Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : "";
}

function normalizeProgress(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function normalizeElapsedMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

function normalizeGenerationError(error, context = {}) {
  const source = error && typeof error === "object" ? error : {};
  const detail = context && typeof context === "object" ? context : {};
  const message = String(source.message || detail.message || error || "生成失败").trim() || "生成失败";
  const retryable = typeof detail.retryable === "boolean"
    ? detail.retryable
    : typeof source.retryable === "boolean"
      ? source.retryable
      : false;
  const paidTaskSubmitted = source.paidTaskSubmitted === true
    || detail.paidTaskSubmitted === true
    || Boolean(String(source.taskId || detail.taskId || "").trim());
  return {
    code: String(source.code || detail.code || "GENERATION_FAILED").trim() || "GENERATION_FAILED",
    source: String(source.source || detail.source || "video-replica").trim() || "video-replica",
    stage: String(source.stage || detail.stage || "unknown").trim() || "unknown",
    message,
    action: String(source.action || detail.action || (retryable ? "重试当前步骤" : "检查任务记录")).trim(),
    retryable,
    paidTaskSubmitted,
    at: timestamp(source.at || detail.at || detail.now),
  };
}

function normalizeRunId(runId) {
  const value = String(runId ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("运行 ID 不安全。");
  return value;
}

function selectedShotIds(plan) {
  const requested = Array.isArray(plan?.selectedShotIds) && plan.selectedShotIds.length
    ? plan.selectedShotIds
    : Array.isArray(plan?.shots)
      ? plan.shots.map((shot) => shot?.id)
      : [];
  const ids = requested.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (!ids.length) throw new Error("活动运行至少需要一个镜头。");
  if (new Set(ids).size !== ids.length) throw new Error("活动运行包含重复镜头。");
  return ids;
}

function createActiveRun({ runId, plan, now } = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("缺少已确认生成计划。");
  if (plan.confirmed !== true) throw new Error("生成计划尚未确认，不能创建活动运行。");
  const normalizedRunId = normalizeRunId(runId);
  const createdAt = timestamp(now) || new Date().toISOString();
  const queue = selectedShotIds(plan);
  const planShots = new Map((Array.isArray(plan.shots) ? plan.shots : []).map((shot) => [String(shot?.id ?? ""), shot]));
  const generationContext = {
    planId: String(plan.planId || ""),
    requestVersion: Number(plan.requestVersion),
    visualStyle: clone(plan.visualStyle),
    character: clone(plan.character),
    products: clone(plan.products || []),
    scenes: clone(plan.scenes || []),
    settings: clone(plan.settings),
  };
  const shots = {};
  for (const id of queue) {
    const confirmedPayload = planShots.get(id);
    if (!confirmedPayload) throw new Error(`已确认生成计划缺少镜头：${id}`);
    shots[id] = {
      id,
      status: "queued",
      stage: "queued",
      taskId: null,
      progress: null,
      elapsedMs: 0,
      error: null,
      paidTaskSubmitted: false,
      result: null,
      confirmedPayload: clone(confirmedPayload),
      generationContext: clone(generationContext),
      confirmedPayloadSignature: null,
      updatedAt: createdAt,
    };
  }
  return {
    version: 3,
    revision: 0,
    runId: normalizedRunId,
    queueId: normalizedRunId,
    planId: String(plan.planId || ""),
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    status: "queued",
    stopRequested: false,
    activeShotId: null,
    queue,
    selectedShotIds: [...queue],
    shots,
  };
}

function deriveRunStatus(run) {
  const shots = Object.values(run.shots || {});
  if (!shots.length) return RUN_STATUSES.has(run.status) ? run.status : "failed";
  const statuses = shots.map((shot) => String(shot?.status || ""));
  const terminalCount = statuses.filter((status) => TERMINAL_SHOT_STATUSES.has(status)).length;
  if (terminalCount < statuses.length) {
    if (run.stopRequested === true || run.status === "stopping") return "stopping";
    return statuses.every((status) => status === "queued") ? "queued" : "processing";
  }
  const failed = statuses.filter((status) => status === "failed").length;
  const completed = statuses.filter((status) => status === "completed").length;
  const stopped = statuses.filter((status) => status === "stopped").length;
  if (failed && (completed || stopped)) return "partial-failure";
  if (failed) return "failed";
  if (stopped) return "stopped";
  return "completed";
}

function requestRunStop(activeRun, now) {
  if (!activeRun || typeof activeRun !== "object" || Array.isArray(activeRun)) throw new Error("活动运行格式错误。");
  const next = clone(activeRun);
  const stoppedAt = timestamp(now) || new Date().toISOString();
  next.stopRequested = true;
  next.updatedAt = stoppedAt;
  if (next.status === "queued") {
    for (const id of next.queue || []) {
      const shot = next.shots?.[id];
      if (!shot || shot.status !== "queued" || shot.paidTaskSubmitted === true || String(shot.taskId || "").trim()) continue;
      shot.status = "stopped";
      shot.stage = "stopped";
      shot.updatedAt = stoppedAt;
    }
  }
  next.status = deriveRunStatus(next);
  if (ACTIVE_RUN_STATUSES.has(next.status)) {
    next.status = "stopping";
    next.completedAt = null;
  } else {
    next.activeShotId = null;
    next.completedAt ||= stoppedAt;
  }
  return next;
}

function mergeRunState(authoritative, candidate, now) {
  if (!authoritative || typeof authoritative !== "object" || Array.isArray(authoritative)) throw new Error("权威活动运行格式错误。");
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("待保存活动运行格式错误。");
  const authoritativeId = String(authoritative.runId || authoritative.queueId || "");
  const candidateId = String(candidate.runId || candidate.queueId || "");
  if (!authoritativeId || authoritativeId !== candidateId) throw new Error("活动运行已变化，已拒绝保存旧状态。");
  const authoritativeRevision = Number.isSafeInteger(authoritative.revision) && authoritative.revision >= 0 ? authoritative.revision : 0;
  const candidateRevision = Number.isSafeInteger(candidate.revision) && candidate.revision >= 0 ? candidate.revision : 0;

  let next = clone(candidate);
  next.shots ||= {};
  for (const [id, authoritativeShot] of Object.entries(authoritative.shots || {})) {
    const candidateShot = next.shots[id];
    if (!candidateShot) {
      next.shots[id] = clone(authoritativeShot);
      continue;
    }
    const authoritativeTaskId = String(authoritativeShot?.taskId || "").trim();
    const candidateTaskId = String(candidateShot?.taskId || "").trim();
    const conflictingAcceptedTask = authoritativeTaskId && authoritativeTaskId !== candidateTaskId;
    const authoritativeUpdatedAt = Date.parse(authoritativeShot?.updatedAt || "");
    const candidateUpdatedAt = Date.parse(candidateShot?.updatedAt || "");
    const authoritativeNewer = authoritativeUpdatedAt > candidateUpdatedAt
      || (candidateRevision < authoritativeRevision
        && (!Number.isFinite(candidateUpdatedAt) || !Number.isFinite(authoritativeUpdatedAt) || authoritativeUpdatedAt >= candidateUpdatedAt));
    const candidateTerminal = TERMINAL_SHOT_STATUSES.has(String(candidateShot?.status || ""));
    if (conflictingAcceptedTask) {
      next.shots[id] = clone(authoritativeShot);
      continue;
    }
    if (authoritativeNewer && !candidateTerminal) {
      for (const key of ["status", "stage", "progress", "elapsedMs", "error", "result", "recoveryContext", "updatedAt"]) {
        if (Object.prototype.hasOwnProperty.call(authoritativeShot, key)) next.shots[id][key] = clone(authoritativeShot[key]);
      }
    } else if (next.shots[id].recoveryContext === undefined && authoritativeShot.recoveryContext !== undefined) {
      next.shots[id].recoveryContext = clone(authoritativeShot.recoveryContext);
    }
    if (!candidateTaskId && authoritativeTaskId) next.shots[id].taskId = authoritativeTaskId;
    if (authoritativeShot.paidTaskSubmitted === true || authoritativeTaskId) next.shots[id].paidTaskSubmitted = true;
  }

  if (authoritative.stopRequested === true || candidate.stopRequested === true) {
    next = requestRunStop(next, now);
  } else {
    next.updatedAt = timestamp(now) || timestamp(candidate.updatedAt) || timestamp(authoritative.updatedAt) || new Date().toISOString();
  }
  next.revision = Math.max(authoritativeRevision, candidateRevision) + 1;
  return next;
}

function updateShotState(activeRun, shotId, patch = {}) {
  if (!activeRun || typeof activeRun !== "object" || Array.isArray(activeRun)) throw new Error("活动运行格式错误。");
  const id = String(shotId ?? "").trim();
  if (!id || !activeRun.shots?.[id]) throw new Error(`活动运行找不到镜头：${id || "(empty)"}`);
  const changes = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const next = clone(activeRun);
  const current = next.shots[id];
  const has = (key) => Object.prototype.hasOwnProperty.call(changes, key);
  const resultTaskId = changes.result && typeof changes.result === "object"
    ? String(changes.result.taskId || changes.result.videoTaskId || "").trim()
    : "";
  const nextTaskId = (has("taskId") ? String(changes.taskId ?? "").trim() : "") || resultTaskId;
  const retainedTaskId = String(current.taskId || "").trim();
  const taskId = nextTaskId || retainedTaskId || null;
  const paidTaskSubmitted = current.paidTaskSubmitted === true
    || changes.paidTaskSubmitted === true
    || Boolean(taskId);
  const status = has("status") ? String(changes.status || current.status) : current.status;
  const error = has("error")
    ? changes.error == null || changes.error === ""
      ? null
      : normalizeGenerationError(changes.error, {
        stage: changes.stage || current.stage,
        paidTaskSubmitted,
        taskId,
        now: changes.now || activeRun.updatedAt,
      })
    : current.error;
  next.shots[id] = {
    ...current,
    ...clone(changes),
    id,
    status,
    stage: has("stage") ? String(changes.stage || "") : current.stage,
    taskId,
    progress: has("progress") ? normalizeProgress(changes.progress) : current.progress,
    elapsedMs: has("elapsedMs") ? normalizeElapsedMs(changes.elapsedMs) : current.elapsedMs,
    error,
    paidTaskSubmitted,
    updatedAt: timestamp(changes.now) || timestamp(activeRun.updatedAt) || new Date().toISOString(),
  };
  if (TERMINAL_SHOT_STATUSES.has(status) || status === "queued") {
    if (next.activeShotId === id) next.activeShotId = null;
  } else {
    next.activeShotId = id;
  }
  if (changes.stopRequested === true) next.stopRequested = true;
  next.status = deriveRunStatus(next);
  next.updatedAt = next.shots[id].updatedAt;
  if (ACTIVE_RUN_STATUSES.has(next.status)) {
    if (next.status !== "queued") next.startedAt ||= next.updatedAt;
    next.completedAt = null;
  } else {
    next.activeShotId = null;
    next.completedAt ||= next.updatedAt;
  }
  return next;
}

function isRunActive(activeRun) {
  return Boolean(activeRun && typeof activeRun === "object" && ACTIVE_RUN_STATUSES.has(String(activeRun.status)));
}

function archiveRun(activeRun, now) {
  if (!activeRun || typeof activeRun !== "object" || Array.isArray(activeRun)) throw new Error("活动运行格式错误。");
  if (isRunActive(activeRun)) throw new Error("活动运行不能归档，请等待运行进入终态。");
  const archivedAt = timestamp(now) || new Date().toISOString();
  return deepFreeze({
    ...clone(activeRun),
    activeShotId: null,
    updatedAt: timestamp(activeRun.updatedAt) || archivedAt,
    completedAt: timestamp(activeRun.completedAt) || archivedAt,
    archivedAt,
  });
}

function mapLegacyRunStatus(status) {
  const value = String(status || "");
  if (value === "idle" || value === "queued") return "queued";
  if (value === "processing") return "processing";
  if (value === "stopping") return "stopping";
  if (value === "completed_with_errors" || value === "partial-failure") return "partial-failure";
  if (value === "completed") return "completed";
  if (value === "stopped") return "stopped";
  if (value === "failed" || /_failed$|_error$/.test(value)) return "failed";
  return "failed";
}

function fromLegacyQueue(legacyQueue) {
  if (!legacyQueue || typeof legacyQueue !== "object" || Array.isArray(legacyQueue)) return null;
  if (Array.isArray(legacyQueue.queue) && legacyQueue.shots && !Array.isArray(legacyQueue.shots)) {
    return {
      ...clone(legacyQueue),
      compatibilitySource: "legacy-queue",
    };
  }
  const queueShots = Array.isArray(legacyQueue.shots) ? legacyQueue.shots : [];
  const queue = queueShots.map((shot) => String(shot?.id ?? "").trim()).filter(Boolean);
  const shots = {};
  for (const shot of queueShots) {
    const id = String(shot?.id ?? "").trim();
    if (!id) continue;
    const payload = clone(shot);
    for (const key of [
      "generationContext", "confirmedPayloadSignature", "status", "stage", "taskId", "progress",
      "elapsedMs", "error", "paidTaskSubmitted", "result", "updatedAt",
    ]) delete payload[key];
    const taskId = String(shot.taskId || shot.result?.taskId || "").trim() || null;
    shots[id] = {
      id,
      status: String(shot.status || "queued"),
      stage: String(shot.stage || shot.status || "queued"),
      taskId,
      progress: normalizeProgress(shot.progress),
      elapsedMs: normalizeElapsedMs(shot.elapsedMs),
      error: shot.error ? normalizeGenerationError(shot.error, { stage: shot.stage, taskId }) : null,
      paidTaskSubmitted: shot.paidTaskSubmitted === true || Boolean(taskId),
      result: clone(shot.result ?? null),
      confirmedPayload: payload,
      generationContext: clone(shot.generationContext || {}),
      confirmedPayloadSignature: shot.confirmedPayloadSignature || null,
      updatedAt: timestamp(shot.updatedAt || legacyQueue.updatedAt || legacyQueue.createdAt),
    };
  }
  const status = mapLegacyRunStatus(legacyQueue.status);
  return {
    version: 3,
    runId: String(legacyQueue.runId || legacyQueue.queueId || "legacy-queue"),
    queueId: String(legacyQueue.queueId || legacyQueue.runId || "legacy-queue"),
    planId: String(legacyQueue.planId || ""),
    createdAt: timestamp(legacyQueue.createdAt),
    updatedAt: timestamp(legacyQueue.updatedAt || legacyQueue.createdAt),
    startedAt: timestamp(legacyQueue.startedAt) || null,
    completedAt: timestamp(legacyQueue.completedAt) || null,
    status,
    stopRequested: legacyQueue.stopRequested === true,
    activeShotId: Object.values(shots).find((shot) => !TERMINAL_SHOT_STATUSES.has(shot.status) && shot.status !== "queued")?.id || null,
    queue,
    selectedShotIds: [...queue],
    shots,
    legacyQueue: clone(legacyQueue),
    compatibilitySource: "legacy-queue",
  };
}

function fromLegacyState(legacyState) {
  if (!legacyState || typeof legacyState !== "object" || Array.isArray(legacyState) || !legacyState.status) return null;
  const updatedAt = timestamp(legacyState.updatedAt || legacyState.completedAt || legacyState.startedAt);
  return {
    version: 3,
    runId: `legacy-state-${Number(legacyState.requestMtimeMs) || 0}`,
    queueId: "",
    planId: "",
    createdAt: timestamp(legacyState.startedAt),
    updatedAt,
    startedAt: timestamp(legacyState.startedAt) || null,
    completedAt: timestamp(legacyState.completedAt) || null,
    status: mapLegacyRunStatus(legacyState.status),
    stopRequested: Boolean(legacyState.stopRequestedAt),
    activeShotId: null,
    queue: [],
    selectedShotIds: [],
    shots: {},
    stage: String(legacyState.currentStep || ""),
    error: legacyState.error ? normalizeGenerationError(legacyState.error, {
      code: legacyState.errorCode,
      stage: legacyState.currentStep,
      now: updatedAt,
    }) : null,
    legacyState: clone(legacyState),
    compatibilitySource: "legacy-state",
  };
}

function selectCurrentRun({ activeRun, legacyQueue, legacyState, requestMtimeMs } = {}) {
  if (activeRun && typeof activeRun === "object" && !Array.isArray(activeRun) && activeRun.runId) return clone(activeRun);
  const queueRun = fromLegacyQueue(legacyQueue);
  const queueHasLock = queueRun && isRunActive(queueRun)
    && Object.values(queueRun.shots).some((shot) => !TERMINAL_SHOT_STATUSES.has(shot.status));
  if (queueHasLock) return queueRun;
  const stateMatchesRequest = legacyState && typeof legacyState === "object"
    && Number.isFinite(Number(requestMtimeMs))
    && Number(legacyState.requestMtimeMs) === Number(requestMtimeMs);
  const stateRun = stateMatchesRequest ? fromLegacyState(legacyState) : null;
  if (stateRun) return stateRun;
  return queueRun;
}

module.exports = {
  archiveRun,
  createActiveRun,
  isRunActive,
  mergeRunState,
  normalizeGenerationError,
  requestRunStop,
  selectCurrentRun,
  updateShotState,
};
