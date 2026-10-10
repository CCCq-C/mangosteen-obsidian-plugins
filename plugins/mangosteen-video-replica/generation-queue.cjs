const crypto = require("crypto");
const { resolveVideoPrompt } = require("./generation-policy.cjs");
const { normalizeGenerationRequest } = require("./replica-core.cjs");

const CONFIRMATION_WARNING = "点击生成后，所选镜头的提示词将无法修改，请确认生成。";

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
  const current = prepareGenerationPlan(currentRequest, plan.selectedShotIds);
  if (current.planId !== plan.planId) throw new Error("所选镜头的草案已变化，请重新确认生成。");
  return deepFreeze({ ...clone(plan), confirmed: true });
}

module.exports = {
  CONFIRMATION_WARNING,
  confirmGenerationPlan,
  prepareGenerationPlan,
};
