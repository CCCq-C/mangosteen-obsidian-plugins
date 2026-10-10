const crypto = require("crypto");

const clean = (value) => String(value || "").trim();

function classifyModel(modelId) {
  const id = clean(modelId).toLowerCase();
  if (id === "minimax-h3") return "minimax-h3";
  if (["seedance-2.0", "sd-2.0-fast", "sd-2.0-mini", "sd-2.0-stable", "seedance-2.5", "seedance-2.5_k1", "seedance-2.5_y2"].includes(id)) return "seedance";
  return null;
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

function composeVideoPrompt({ videoPrompt, dialogue, voiceProfile, voiceDirection } = {}) {
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

function createGenerationFingerprint({ character = {}, scene = {}, products = [], shot = {}, model, ratio, resolution } = {}) {
  const requirements = referenceRequirements(model, shot.lastImagePrompt);
  const canonical = {
    version: 2,
    character: { id: clean(character.id), prompt: clean(character.prompt), contentHash: clean(character.contentHash) },
    scene: { id: clean(scene.id), prompt: clean(scene.prompt), contentHash: clean(scene.contentHash) },
    products: (Array.isArray(products) ? products : []).map((product) => ({
      id: clean(product?.id),
      prompt: clean(product?.prompt),
      contentHash: clean(product?.contentHash),
    })),
    imagePrompt: clean(shot.imagePrompt),
    lastImagePrompt: clean(shot.lastImagePrompt),
    videoPrompt: clean(shot.videoPrompt),
    dialogue: clean(shot.dialogue),
    voiceProfile: clean(character.voiceProfile),
    voiceDirection: clean(shot.voiceDirection),
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

function buildVideoOptions({ model, prompt, duration, ratio, resolution, firstImageFile, lastImageFile } = {}) {
  const family = classifyModel(model);
  if (!family) throw new Error(`视频复刻不支持模型：${String(model || "未选择")}`);

  const options = { model, prompt, duration, ratio, resolution };
  if (family === "minimax-h3") {
    if (firstImageFile) options.firstImageFile = firstImageFile;
    if (lastImageFile) options.lastImageFile = lastImageFile;
    return options;
  }

  options.referenceImageFiles = [firstImageFile, lastImageFile].filter(Boolean);
  return options;
}

module.exports = {
  buildVideoOptions,
  classifyModel,
  composeVideoPrompt,
  createGenerationFingerprint,
  eligibleModels,
  referenceRequirements,
};
