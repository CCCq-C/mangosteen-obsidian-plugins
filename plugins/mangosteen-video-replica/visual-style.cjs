const STYLE_HEADER = "【项目视觉风格】";

const DEFAULT_VISUAL_STYLE = Object.freeze({
  category: "继承参考资产",
  prompt: "保持现有人物、场景和产品参考图的既有视觉风格；媒介、写实度、材质、色彩、光线和镜头质感全片一致。",
});

const clean = (value) => String(value ?? "").trim();

function normalizeVisualStyle(value, { required = false } = {}) {
  const source = typeof value === "string" ? { category: "自定义风格", prompt: value } : value;
  const category = clean(source?.category);
  const prompt = clean(source?.prompt);
  if (required && !category) throw new Error("缺少视觉风格分类。");
  if (required && !prompt) throw new Error("缺少视觉风格描述。");
  return {
    category: category || DEFAULT_VISUAL_STYLE.category,
    prompt: prompt || DEFAULT_VISUAL_STYLE.prompt,
  };
}

function visualStyleBlock(value) {
  const style = normalizeVisualStyle(value);
  return [STYLE_HEADER, `类型：${style.category}`, style.prompt].join("\n");
}

function withoutLeadingVisualStyle(value) {
  const prompt = clean(value);
  if (!prompt.startsWith(STYLE_HEADER)) return prompt;
  const blockEnd = prompt.indexOf("\n\n");
  return blockEnd >= 0 ? prompt.slice(blockEnd + 2).trim() : "";
}

function applyVisualStyle(prompt, style) {
  const body = withoutLeadingVisualStyle(prompt);
  return [visualStyleBlock(style), body].filter(Boolean).join("\n\n");
}

module.exports = {
  DEFAULT_VISUAL_STYLE,
  STYLE_HEADER,
  applyVisualStyle,
  normalizeVisualStyle,
  visualStyleBlock,
};
