const crypto = require("crypto");
const { compileTimelinePrompt } = require("./shot-timeline.cjs");

const clean = (value) => String(value || "").trim();

function classifyModel(modelId) {
  const id = clean(modelId).toLowerCase();
  if (id === "minimax-h3") return "minimax-h3";
  if (["seedance-2.0", "sd-2.0-fast", "sd-2.0-mini", "sd-2.0-stable", "seedance-2.5", "seedance-2.5_k1", "seedance-2.5_y2"].includes(id)) return "seedance";
  return null;
}

function videoDurationRange(model) {
  const id = clean(model).toLowerCase();
  const max = ["seedance-2.5", "seedance-2.5_k1", "seedance-2.5_y2"].includes(id) ? 30 : 15;
  return { min: 4, max, step: 1 };
}

function normalizeVideoDuration(value, model) {
  const { min, max } = videoDurationRange(model);
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric) && numeric > 0 ? Math.ceil(numeric) : min;
  return Math.max(min, Math.min(max, seconds));
}

function referenceRequirements(model, lastImagePrompt = "") {
  const family = classifyModel(model);
  if (!family) throw new Error(`视频复刻不支持模型：${String(model || "未选择")}`);
  return {
    mode: family === "minimax-h3" ? "frame-fields" : "reference-images",
    firstImage: true,
    lastImage: Boolean(clean(lastImagePrompt)),
  };
}

function composeVideoPrompt({ timeline, duration, videoPrompt, dialogue, voiceProfile, voiceDirection } = {}) {
  if (Array.isArray(timeline) && timeline.length) {
    return compileTimelinePrompt(timeline, { duration, voiceProfile });
  }
  const visualPrompt = clean(videoPrompt);
  const spokenText = clean(dialogue);
  if (!spokenText) return visualPrompt;
  const stableVoice = clean(voiceProfile) || "中文普通话，声音自然清晰，符合人物年龄与形象。";
  const delivery = clean(voiceDirection) || "根据当前剧情自然表达，语速适中，停顿自然。";
  return [
    visualPrompt,
    "",
    "【角色对白】",
    `画面中的角色完整说出：“${spokenText}”`,
    "【声音要求】",
    `固定声音设定：${stableVoice}`,
    `本镜头情绪与语调：${delivery}`,
    "对白语言和口音严格遵循固定声音设定，并与人物口型同步，吐字清楚；不得添加、删减或改写台词；背景音乐和环境音不得盖过对白。",
  ].filter(Boolean).join("\n");
}

function resolveVideoPrompt({ videoPromptOverride, ...parts } = {}) {
  const override = clean(videoPromptOverride);
  return override || composeVideoPrompt(parts);
}

function createGenerationFingerprint({ character = {}, scene = {}, products = [], shot = {}, model, ratio, resolution } = {}) {
  const requirements = referenceRequirements(model, shot.lastImagePrompt);
  const canonical = {
    version: 3,
    character: { id: clean(character.id), prompt: clean(character.prompt), contentHash: clean(character.contentHash) },
    scene: { id: clean(scene.id), prompt: clean(scene.prompt), contentHash: clean(scene.contentHash) },
    products: (Array.isArray(products) ? products : []).map((product) => ({
      id: clean(product?.id),
      prompt: clean(product?.prompt),
      contentHash: clean(product?.contentHash),
    })),
    imagePrompt: clean(shot.imagePrompt),
    lastImagePrompt: clean(shot.lastImagePrompt),
    legacyFrameMode: shot.legacyFrameMode === true,
    effectiveVideoPrompt: resolveVideoPrompt({
      timeline: shot.timeline,
      duration: shot.duration,
      videoPrompt: shot.videoPrompt,
      videoPromptOverride: shot.videoPromptOverride,
      dialogue: shot.dialogue,
      voiceProfile: character.voiceProfile,
      voiceDirection: shot.voiceDirection,
    }),
    timeline: (Array.isArray(shot.timeline) ? shot.timeline : []).map((segment) => ({
      start: Number(segment?.start),
      end: Number(segment?.end),
      action: clean(segment?.action),
      dialogue: clean(segment?.dialogue),
      performance: clean(segment?.performance),
      camera: clean(segment?.camera),
      environment: clean(segment?.environment),
    })),
    model: clean(model),
    duration: Number(shot.duration),
    ratio: requirements.mode === "frame-fields" ? "omitted-with-frames" : clean(ratio),
    resolution: clean(resolution),
    referenceMode: requirements.mode,
    mandatoryArtifacts: {
      firstImage: requirements.firstImage,
      lastImage: requirements.lastImage,
    },
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function eligibleModels(modelIds) {
  return (Array.isArray(modelIds) ? modelIds : []).filter((modelId) => classifyModel(modelId));
}

function buildVideoOptions({ model, prompt, duration, ratio, resolution, firstImageFile, lastImageFile, referenceImageFiles } = {}) {
  const family = classifyModel(model);
  if (!family) throw new Error(`视频复刻不支持模型：${String(model || "未选择")}`);

  const options = { model, prompt, duration, ratio, resolution };
  if (family === "minimax-h3") {
    if (firstImageFile) options.firstImageFile = firstImageFile;
    if (lastImageFile) options.lastImageFile = lastImageFile;
    return options;
  }

  options.referenceImageFiles = Array.isArray(referenceImageFiles)
    ? referenceImageFiles.filter(Boolean)
    : [firstImageFile, lastImageFile].filter(Boolean);
  return options;
}

module.exports = {
  buildVideoOptions,
  classifyModel,
  composeVideoPrompt,
  createGenerationFingerprint,
  eligibleModels,
  normalizeVideoDuration,
  referenceRequirements,
  resolveVideoPrompt,
  videoDurationRange,
};
