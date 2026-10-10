const crypto = require("crypto");

const clean = (value) => String(value || "").trim();

function classifyModel(modelId) {
  const id = clean(modelId).toLowerCase();
  if (id === "minimax-h3") return "minimax-h3";
  if (id.includes("seedance") || ["sd-2.0-fast", "sd-2.0-mini", "sd-2.0-stable"].includes(id)) return "seedance";
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

function createGenerationFingerprint({ character = {}, scene = {}, shot = {}, model, ratio, resolution } = {}) {
  const requirements = referenceRequirements(model, shot.lastImagePrompt);
  const canonical = {
    version: 1,
    character: { id: clean(character.id), prompt: clean(character.prompt) },
    scene: { id: clean(scene.id), prompt: clean(scene.prompt) },
    imagePrompt: clean(shot.imagePrompt),
    lastImagePrompt: clean(shot.lastImagePrompt),
    videoPrompt: clean(shot.videoPrompt),
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
  createGenerationFingerprint,
  eligibleModels,
  referenceRequirements,
};
