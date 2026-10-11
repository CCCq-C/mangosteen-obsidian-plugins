const crypto = require("crypto");
const { resolveVideoPrompt } = require("./generation-policy.cjs");
const { normalizeGenerationRequest } = require("./replica-core.cjs");

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
    }),
  }));
  const sceneIds = new Set(shots.map((shot) => shot.sceneId));
  const productIds = new Set(shots.flatMap((shot) => shot.productIds || []));
  const snapshot = {
    version: 1,
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
  if (!queue || !Array.isArray(queue.shots)) return [];
  return queue.shots
    .filter((shot) => shot?.status === "queued" || shot?.status === "processing")
    .map((shot) => String(shot.id));
}

function generationContext(plan) {
  return {
    planId: String(plan.planId),
    character: clone(plan.character),
    products: clone(plan.products || []),
    scenes: clone(plan.scenes || []),
    settings: clone(plan.settings),
  };
}

function queuedShots(plan) {
  const context = generationContext(plan);
  return clone(plan.shots).map((shot) => ({
    ...shot,
    generationContext: clone(context),
    status: "queued",
    error: "",
    result: null,
  }));
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
  const queue = {
    version: 1,
    queueId: sha256({ planId: confirmedPlan.planId, createdAt }),
    planId: confirmedPlan.planId,
    createdAt,
    updatedAt: createdAt,
    status: "idle",
    stopRequested: false,
    character: clone(confirmedPlan.character),
    products: clone(confirmedPlan.products || []),
    scenes: clone(confirmedPlan.scenes || []),
    settings: clone(confirmedPlan.settings),
    selectedShotIds: clone(confirmedPlan.selectedShotIds),
    shots: queuedShots(confirmedPlan),
  };
  return queue;
}

function appendGenerationPlan(queue, confirmedPlan) {
  if (!queue || !Array.isArray(queue.shots)) throw new Error("生成队列格式错误。");
  if (!["idle", "processing"].includes(String(queue.status)) || queue.stopRequested === true) {
    throw new Error(`生成队列当前状态不能追加镜头：${String(queue.status)}`);
  }
  if (!confirmedPlan || confirmedPlan.confirmed !== true) throw new Error("生成计划尚未确认，不能加入队列。");
  if (sha256(planSnapshot(confirmedPlan)) !== confirmedPlan.planId) throw new Error("生成计划内容已变化，请重新预览并确认生成。");
  const existingIds = new Set(queue.shots.map((shot) => String(shot.id)));
  for (const id of confirmedPlan.selectedShotIds || []) {
    if (existingIds.has(String(id))) throw new Error(`镜头 ${id} 已经在当前队列中，请勿重复提交。`);
  }
  const additions = queuedShots(confirmedPlan);
  queue.shots.push(...additions);
  queue.selectedShotIds = [...(queue.selectedShotIds || []), ...additions.map((shot) => String(shot.id))];
  queue.updatedAt = new Date().toISOString();
  return queue;
}

function requestQueueStop(queue) {
  if (!queue || typeof queue !== "object") throw new Error("生成队列格式错误。");
  queue.stopRequested = true;
  queue.updatedAt = new Date().toISOString();
  if (queue.status === "idle") {
    for (const shot of queue.shots || []) {
      if (shot.status === "queued") shot.status = "stopped";
    }
    queue.status = "stopped";
  }
  return queue;
}

async function runGenerationQueue(queue, runShot, { onUpdate = null } = {}) {
  if (!queue || !Array.isArray(queue.shots)) throw new Error("生成队列格式错误。");
  if (typeof runShot !== "function") throw new Error("缺少单镜头运行器。");
  if (queue.status !== "idle") throw new Error(`生成队列当前状态不能运行：${String(queue.status)}`);

  const notify = async () => {
    queue.updatedAt = new Date().toISOString();
    if (typeof onUpdate === "function") await onUpdate(clone(queue));
  };
  queue.status = "processing";
  queue.startedAt = new Date().toISOString();
  await notify();
  for (const shot of queue.shots) {
    if (shot.status !== "queued") continue;
    if (queue.stopRequested) {
      shot.status = "stopped";
      continue;
    }
    shot.status = "processing";
    await notify();
    try {
      const shotContext = shot.generationContext || {
        planId: queue.planId,
        character: queue.character,
        products: queue.products || [],
        scenes: queue.scenes || [],
        settings: queue.settings,
      };
      const context = deepFreeze({ queueId: queue.queueId, ...clone(shotContext) });
      const runnableShot = clone(shot);
      delete runnableShot.generationContext;
      const result = await runShot(deepFreeze(runnableShot), context);
      shot.result = clone(result ?? null);
      shot.status = "completed";
      shot.error = "";
    } catch (error) {
      shot.result = null;
      shot.status = "failed";
      shot.error = String(error?.message || error);
    }
    await notify();
  }

  if (queue.stopRequested) {
    for (const shot of queue.shots) {
      if (shot.status === "queued") shot.status = "stopped";
    }
    queue.status = "stopped";
  } else {
    queue.status = queue.shots.some((shot) => shot.status === "failed") ? "completed_with_errors" : "completed";
  }
  queue.completedAt = new Date().toISOString();
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
};
