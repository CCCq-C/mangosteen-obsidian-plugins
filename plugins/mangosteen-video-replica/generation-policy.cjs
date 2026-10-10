function classifyModel(modelId) {
  const id = String(modelId || "").trim().toLowerCase();
  if (id === "minimax-h3") return "minimax-h3";
  if (id.includes("seedance") || ["sd-2.0-fast", "sd-2.0-mini", "sd-2.0-stable"].includes(id)) return "seedance";
  return null;
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
  eligibleModels,
};
