const crypto = require("crypto");
const { resolveVideoPrompt } = require("./generation-policy.cjs");
const { normalizeGenerationRequest } = require("./replica-core.cjs");
const {
  createActiveRun,
  normalizeGenerationError,
  updateShotState,
} = require("./run-state.cjs");

const CONFIRMATION_WARNING = "确认后，所选分镜在本次生成期间将无法更改。";

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

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function planSnapshot(plan) {
  return {
    version: Number(plan?.version),
    requestVersion: Number(plan?.requestVersion),
    visualStyle: clone(plan?.visualStyle),
    character: clone(plan?.character),
    products: clone(plan?.products || []),
    scenes: clone(plan?.scenes || []),
    settings: clone(plan?.settings),
    selectedShotIds: clone(plan?.selectedShotIds || []),
    shots: clone(plan?.shots || []),
  };
}

function normalizedSelection(selectedShotIds) {
  if (!Array.isArray(selectedShotIds) || !selectedShotIds.length) throw new Error("至少选择一个镜头后才能生成。");
  const output = selectedShotIds.map((id) => String(id || "").trim());
  const seen = new Set();
  for (const id of output) {
    if (seen.has(id)) throw new Error(`重复选择镜头：${id}`);
    seen.add(id);
  }
  return output;
}

function prepareGenerationPlan(request, selectedShotIds) {
  const selected = normalizedSelection(selectedShotIds);
  const normalized = normalizeGenerationRequest({ ...clone(request), confirmed: true });
  const available = new Set(normalized.shots.map((shot) => shot.id));
  for (const id of selected) {
    if (!available.has(id)) throw new Error(`找不到镜头：${id}`);
  }

  const selectedSet = new Set(selected);
  const shots = normalized.shots.filter((shot) => selectedSet.has(shot.id)).map((shot) => ({
    ...shot,
    effectiveVideoPrompt: resolveVideoPrompt({
      timeline: shot.timeline,
      duration: shot.duration,
      videoPrompt: shot.videoPrompt,
      videoPromptOverride: shot.videoPromptOverride,
      dialogue: shot.dialogue,
      voiceProfile: normalized.character.voiceProfile,
      voiceDirection: shot.voiceDirection,
      visualStyle: normalized.visualStyle,
    }),
  }));
  const sceneIds = new Set(shots.map((shot) => shot.sceneId));
  const productIds = new Set(shots.flatMap((shot) => shot.productIds || []));
  const snapshot = {
    version: 1,
    requestVersion: normalized.version,
    visualStyle: clone(normalized.visualStyle),
    character: clone(normalized.character),
    products: clone((normalized.products || []).filter((product) => productIds.has(product.id))),
    scenes: clone((normalized.scenes || []).filter((scene) => sceneIds.has(scene.id))),
    settings: clone(normalized.settings),
    selectedShotIds: shots.map((shot) => shot.id),
    shots: clone(shots),
  };
  const planId = sha256(snapshot);
  return deepFreeze({
    ...snapshot,
    planId,
    requestSignature: planId,
    confirmed: false,
    warning: CONFIRMATION_WARNING,
  });
}

function confirmGenerationPlan(plan, currentRequest) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.selectedShotIds)) throw new Error("生成计划格式错误，请重新预览确认。");
  if (sha256(planSnapshot(plan)) !== plan.planId) throw new Error("生成计划内容已变化，请重新预览并确认生成。");
  const current = prepareGenerationPlan(currentRequest, plan.selectedShotIds);
  if (current.planId !== plan.planId) throw new Error("所选镜头的草案已变化，请重新确认生成。");
  return deepFreeze({ ...clone(plan), confirmed: true });
}

function lockedShotIds(queue) {
  if (!queue || typeof queue !== "object") return [];
  if (Array.isArray(queue.shots)) {
    return queue.shots
      .filter((shot) => shot?.status === "queued" || shot?.status === "processing")
      .map((shot) => String(shot.id));
  }
  const ids = Array.isArray(queue.queue) ? queue.queue : Object.keys(queue.shots || {});
  return ids.filter((id) => {
    const status = String(queue.shots?.[id]?.status || "");
    return !["completed", "failed", "stopped"].includes(status);
  }).map(String);
}

function generationContext(plan) {
  return {
    planId: String(plan.planId),
    requestVersion: Number(plan.requestVersion),
    visualStyle: clone(plan.visualStyle),
    character: clone(plan.character),
    products: clone(plan.products || []),
    scenes: clone(plan.scenes || []),
    settings: clone(plan.settings),
  };
}

function queuedShot(plan, shot) {
  const context = generationContext(plan);
  const confirmedPayload = clone(shot);
  const generationContextSnapshot = clone(context);
  return {
    id: String(shot.id),
    status: "queued",
    stage: "queued",
    taskId: null,
    progress: null,
    elapsedMs: 0,
    error: null,
    paidTaskSubmitted: false,
    result: null,
    confirmedPayload,
    generationContext: generationContextSnapshot,
    confirmedPayloadSignature: sha256({ shot: confirmedPayload, context: generationContextSnapshot }),
  };
}

function verifyQueuedShot(shot) {
  const signature = String(shot?.confirmedPayloadSignature || "");
  if (!signature) {
    throw new Error("队列缺少确认签名；系统不会提交付费任务，请重新预览并确认。");
  }
  const payload = clone(shot.confirmedPayload || shot);
  const context = clone(shot.generationContext);
  if (!shot.confirmedPayload) {
    delete payload.generationContext;
    delete payload.confirmedPayloadSignature;
    delete payload.status;
    delete payload.stage;
    delete payload.taskId;
    delete payload.progress;
    delete payload.elapsedMs;
    delete payload.error;
    delete payload.paidTaskSubmitted;
    delete payload.result;
    delete payload.updatedAt;
  }
  if (sha256({ shot: payload, context }) !== signature) {
    throw new Error("队列内容已变化，与确认内容不一致；系统不会提交付费任务，请重新预览并确认。");
  }
}

function createGenerationQueue(confirmedPlan, { activeQueues = [], now = new Date().toISOString() } = {}) {
  if (!confirmedPlan || confirmedPlan.confirmed !== true) throw new Error("生成计划尚未确认，不能加入队列。");
  if (sha256(planSnapshot(confirmedPlan)) !== confirmedPlan.planId) throw new Error("生成计划内容已变化，请重新预览并确认生成。");
  const requestedIds = new Set(confirmedPlan.selectedShotIds || []);
  for (const activeQueue of activeQueues) {
    const conflict = lockedShotIds(activeQueue).find((id) => requestedIds.has(id));
    if (conflict) throw new Error(`镜头 ${conflict} 已经在生成队列中，请等待完成或停止后再试。`);
  }
  const createdAt = String(now || new Date().toISOString());
  const runId = `run_${sha256({ planId: confirmedPlan.planId, createdAt }).slice("sha256:".length)}`;
  const queue = createActiveRun({ runId, plan: confirmedPlan, now: createdAt });
  Object.assign(queue, {
    character: clone(confirmedPlan.character),
    visualStyle: clone(confirmedPlan.visualStyle),
    products: clone(confirmedPlan.products || []),
    scenes: clone(confirmedPlan.scenes || []),
    settings: clone(confirmedPlan.settings),
  });
  for (const shot of confirmedPlan.shots) queue.shots[String(shot.id)] = queuedShot(confirmedPlan, shot);
  return queue;
}

function appendGenerationPlan(queue, confirmedPlan) {
  if (!queue || !Array.isArray(queue.queue) || !queue.shots || Array.isArray(queue.shots)) throw new Error("生成队列格式错误。");
  if (!["queued", "processing"].includes(String(queue.status)) || queue.stopRequested === true) {
    throw new Error(`生成队列当前状态不能追加镜头：${String(queue.status)}`);
  }
  if (!confirmedPlan || confirmedPlan.confirmed !== true) throw new Error("生成计划尚未确认，不能加入队列。");
  if (sha256(planSnapshot(confirmedPlan)) !== confirmedPlan.planId) throw new Error("生成计划内容已变化，请重新预览并确认生成。");
  const existingIds = new Set(queue.queue.map(String));
  for (const id of confirmedPlan.selectedShotIds || []) {
    if (existingIds.has(String(id))) throw new Error(`镜头 ${id} 已经在当前队列中，请勿重复提交。`);
  }
  const additions = confirmedPlan.shots.map((shot) => queuedShot(confirmedPlan, shot));
  for (const shot of additions) {
    queue.queue.push(shot.id);
    queue.shots[shot.id] = shot;
  }
  queue.selectedShotIds = [...(queue.selectedShotIds || []), ...additions.map((shot) => shot.id)];
  queue.updatedAt = new Date().toISOString();
  return queue;
}

function requestQueueStop(queue) {
  if (!queue || typeof queue !== "object") throw new Error("生成队列格式错误。");
  queue.stopRequested = true;
  queue.updatedAt = new Date().toISOString();
  if (queue.status === "queued") {
    for (const id of queue.queue || []) {
      if (queue.shots?.[id]?.status === "queued") replaceRun(queue, updateShotState(queue, id, {
        status: "stopped",
        stage: "stopped",
        now: queue.updatedAt,
      }));
    }
    queue.status = "stopped";
    queue.activeShotId = null;
    queue.completedAt ||= queue.updatedAt;
  } else if (queue.status === "processing") {
    queue.status = "stopping";
  }
  return queue;
}

function replaceRun(target, replacement) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
  return target;
}

async function runGenerationQueue(queue, runShot, { onUpdate = null } = {}) {
  if (!queue || !Array.isArray(queue.queue) || !queue.shots || Array.isArray(queue.shots)) throw new Error("生成队列格式错误。");
  if (typeof runShot !== "function") throw new Error("缺少单镜头运行器。");
  if (queue.status !== "queued") throw new Error(`生成队列当前状态不能运行：${String(queue.status)}`);

  const notify = async () => {
    queue.updatedAt = new Date().toISOString();
    if (typeof onUpdate === "function") await onUpdate(clone(queue));
  };
  queue.status = "processing";
  queue.startedAt = new Date().toISOString();
  await notify();
  for (let index = 0; index < queue.queue.length; index += 1) {
    const shotId = String(queue.queue[index]);
    let shot = queue.shots[shotId];
    if (!shot) continue;
    if (shot.status !== "queued") continue;
    if (queue.stopRequested && shot.paidTaskSubmitted !== true && !String(shot.taskId || "").trim()) {
      replaceRun(queue, updateShotState(queue, shotId, { status: "stopped", stage: "stopped", now: new Date().toISOString() }));
      continue;
    }
    replaceRun(queue, updateShotState(queue, shotId, {
      status: "processing",
      stage: "preflight",
      progress: null,
      error: null,
      now: new Date().toISOString(),
    }));
    await notify();
    try {
      shot = queue.shots[shotId];
      verifyQueuedShot(shot);
      const shotContext = shot.generationContext || {
        planId: queue.planId,
        visualStyle: queue.visualStyle,
        character: queue.character,
        products: queue.products || [],
        scenes: queue.scenes || [],
        settings: queue.settings,
      };
      const updateState = async (patch = {}) => {
        replaceRun(queue, updateShotState(queue, shotId, { ...patch, now: patch.now || new Date().toISOString() }));
        await notify();
        return clone(queue.shots[shotId]);
      };
      const assertPaidSubmissionAllowed = () => {
        if (queue.stopRequested !== true) return true;
        const stopped = new Error("用户已停止生成；不会再提交新的付费任务。");
        stopped.code = "GENERATION_STOPPED";
        throw stopped;
      };
      const context = deepFreeze({
        queueId: queue.queueId,
        runId: queue.runId,
        ...clone(shotContext),
        updateState,
        assertPaidSubmissionAllowed,
      });
      const runnableShot = clone(shot.confirmedPayload || shot);
      const result = await runShot(deepFreeze(runnableShot), context);
      replaceRun(queue, updateShotState(queue, shotId, {
        status: "completed",
        stage: "completed",
        result: clone(result ?? null),
        error: null,
        now: new Date().toISOString(),
      }));
    } catch (error) {
      shot = queue.shots[shotId];
      if (error?.code === "GENERATION_STOPPED" && queue.stopRequested === true) {
        replaceRun(queue, updateShotState(queue, shotId, {
          status: "stopped",
          stage: "stopped",
          result: null,
          error: null,
          now: new Date().toISOString(),
        }));
      } else {
        const errorTaskId = String(error?.taskId || error?.videoTaskId || "").trim();
        replaceRun(queue, updateShotState(queue, shotId, {
          status: "failed",
          result: null,
          ...(errorTaskId ? { taskId: errorTaskId } : {}),
          ...(error?.paidTaskSubmitted === true ? { paidTaskSubmitted: true } : {}),
          error: normalizeGenerationError(error, {
            source: error?.source || "video-replica",
            stage: shot?.stage || "preflight",
            taskId: shot?.taskId,
            paidTaskSubmitted: shot?.paidTaskSubmitted === true,
            retryable: error?.retryable === true,
            now: new Date().toISOString(),
          }),
          now: new Date().toISOString(),
        }));
      }
    }
    await notify();
  }

  if (queue.stopRequested) {
    for (const id of queue.queue) {
      if (queue.shots[id]?.status === "queued") replaceRun(queue, updateShotState(queue, id, {
        status: "stopped",
        stage: "stopped",
        now: new Date().toISOString(),
      }));
    }
  }
  queue.completedAt = new Date().toISOString();
  queue.activeShotId = null;
  await notify();
  return queue;
}

module.exports = {
  CONFIRMATION_WARNING,
  appendGenerationPlan,
  confirmGenerationPlan,
  createGenerationQueue,
  lockedShotIds,
  prepareGenerationPlan,
  requestQueueStop,
  runGenerationQueue,
  verifyQueuedShot,
};
