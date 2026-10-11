const assert = require("assert");
const {
  buildVideoOptions,
  classifyModel,
  composeVideoPrompt,
  createGenerationFingerprint,
  eligibleModels,
  normalizeVideoDuration,
  referenceRequirements,
  resolveVideoPrompt,
  videoDurationRange,
} = require("../generation-policy.cjs");

const spokenPrompt = composeVideoPrompt({
  videoPrompt: "女孩举起白色耳机盒，镜头缓慢推进。",
  dialogue: "你们看，这次我们准备了一百台索尼耳机！",
  voiceProfile: "年轻清亮的中文女声，轻微四川口音，中高音色。",
  voiceDirection: "惊喜、兴奋，语速略快，句尾上扬。",
});
assert.match(spokenPrompt, /女孩举起白色耳机盒/);
assert.match(spokenPrompt, /你们看，这次我们准备了一百台索尼耳机/);
assert.match(spokenPrompt, /轻微四川口音/);
assert.match(spokenPrompt, /惊喜、兴奋/);
assert.match(spokenPrompt, /口型同步/);
assert.match(spokenPrompt, /不得添加.*改写台词/);
assert.match(spokenPrompt, /对白语言和口音严格遵循固定声音设定/);
assert.doesNotMatch(spokenPrompt, /对白使用中文/);
assert.strictEqual(composeVideoPrompt({
  videoPrompt: "港口空镜，海浪轻拍岸边。",
  dialogue: "",
  voiceProfile: "年轻女声",
  voiceDirection: "兴奋",
}), "港口空镜，海浪轻拍岸边。", "silent shots must not invent speech");

assert.strictEqual(resolveVideoPrompt({
  videoPrompt: "自动视觉描述",
  dialogue: "自动台词",
  voiceProfile: "自动声音",
  voiceDirection: "自动语气",
  videoPromptOverride: "用户编辑后的完整提示词",
}), "用户编辑后的完整提示词", "explicit complete prompt must bypass automatic composition");
assert.match(resolveVideoPrompt({
  videoPrompt: "自动视觉描述",
  dialogue: "自动台词",
  voiceProfile: "自动声音",
  voiceDirection: "自动语气",
  videoPromptOverride: "   ",
}), /自动台词/, "blank override must restore automatic composition");

assert.deepStrictEqual(
  eligibleModels([
    "MiniMax-H3",
    "seedance-2.5",
    "sd-2.0-fast",
    "KlingO3",
    "wan3.0-video-prime",
    "future-video-model",
  ]),
  ["MiniMax-H3", "seedance-2.5", "sd-2.0-fast"],
);

assert.strictEqual(classifyModel(" minimax-H3 "), "minimax-h3");
assert.strictEqual(classifyModel("vendor-seedance-preview"), null);
assert.strictEqual(classifyModel("sd-2.0-stable"), "seedance");
assert.strictEqual(classifyModel("seedance-2.5_unknown"), null);
assert.strictEqual(classifyModel("wan3.0-video-prime"), null);

assert.deepStrictEqual(videoDurationRange("MiniMax-H3"), { min: 4, max: 15, step: 1 });
assert.deepStrictEqual(videoDurationRange("seedance-2.5"), { min: 4, max: 30, step: 1 });
assert.strictEqual(normalizeVideoDuration(13.5, "MiniMax-H3"), 14);
assert.strictEqual(normalizeVideoDuration(14.2, "MiniMax-H3"), 15);
assert.strictEqual(normalizeVideoDuration(8.4, "MiniMax-H3"), 9);
assert.strictEqual(normalizeVideoDuration(2, "MiniMax-H3"), 4);
assert.strictEqual(normalizeVideoDuration(29.2, "seedance-2.5"), 30);

const firstImageFile = { name: "first.png" };
const lastImageFile = { name: "last.png" };
const common = {
  prompt: "人物向前走，镜头缓慢推进",
  duration: 4,
  ratio: "9:16",
};

assert.deepStrictEqual(buildVideoOptions({
  ...common,
  model: "MiniMax-H3",
  resolution: "768p",
  firstImageFile,
  lastImageFile,
}), {
  model: "MiniMax-H3",
  prompt: common.prompt,
  duration: 4,
  ratio: "9:16",
  resolution: "768p",
  firstImageFile,
  lastImageFile,
});

assert.deepStrictEqual(buildVideoOptions({
  ...common,
  model: "MiniMax-H3",
  resolution: "768p",
  firstImageFile,
}), {
  model: "MiniMax-H3",
  prompt: common.prompt,
  duration: 4,
  ratio: "9:16",
  resolution: "768p",
  firstImageFile,
});

assert.deepStrictEqual(buildVideoOptions({
  ...common,
  model: "seedance-2.5_k1",
  resolution: "720p",
  firstImageFile,
  lastImageFile,
}), {
  model: "seedance-2.5_k1",
  prompt: common.prompt,
  duration: 4,
  ratio: "9:16",
  resolution: "720p",
  referenceImageFiles: [firstImageFile, lastImageFile],
});

for (const model of ["KlingO3", "wan3.0-r2v-k1", "future-video-model"]) {
  assert.throws(
    () => buildVideoOptions({ ...common, model, resolution: "720p", firstImageFile }),
    /视频复刻不支持模型/,
  );
}

const fingerprintInput = {
  character: { id: "hero-v1", prompt: "短发女性，蓝色工装", contentHash: "sha256:character-a" },
  scene: { id: "harbor-v1", prompt: "海边集装箱码头", contentHash: "sha256:scene-a" },
  products: [{ id: "headphones-v1", prompt: "白色头戴式耳机", contentHash: "sha256:product-a" }],
  shot: {
    imagePrompt: "人物站在红色集装箱前",
    lastImagePrompt: "人物转身看海",
    videoPrompt: "人物转身，镜头缓慢推进",
    duration: 4,
  },
  model: "seedance-2.5",
  ratio: "9:16",
  resolution: "720p",
};
const baselineFingerprint = createGenerationFingerprint(fingerprintInput);
assert.match(baselineFingerprint, /^sha256:[a-f0-9]{64}$/);
for (const changed of [
  { character: { ...fingerprintInput.character, id: "hero-v2" } },
  { character: { ...fingerprintInput.character, prompt: "长发女性，白色外套" } },
  { character: { ...fingerprintInput.character, contentHash: "sha256:character-b" } },
  { scene: { ...fingerprintInput.scene, id: "studio-v1" } },
  { scene: { ...fingerprintInput.scene, prompt: "白色摄影棚" } },
  { scene: { ...fingerprintInput.scene, contentHash: "sha256:scene-b" } },
  { products: [{ ...fingerprintInput.products[0], contentHash: "sha256:product-b" }] },
  { shot: { ...fingerprintInput.shot, imagePrompt: "人物坐在集装箱前" } },
  { shot: { ...fingerprintInput.shot, lastImagePrompt: "" } },
  { shot: { ...fingerprintInput.shot, videoPrompt: "人物快步跑向镜头" } },
  { shot: { ...fingerprintInput.shot, duration: 5 } },
  { model: "MiniMax-H3", resolution: "768p" },
  { ratio: "16:9" },
  { resolution: "1080p" },
]) {
  assert.notStrictEqual(
    createGenerationFingerprint({ ...fingerprintInput, ...changed }),
    baselineFingerprint,
    `fingerprint must invalidate for ${JSON.stringify(changed)}`,
  );
}
const overriddenFingerprint = createGenerationFingerprint({
  ...fingerprintInput,
  shot: { ...fingerprintInput.shot, videoPromptOverride: "用户最终提示词 A" },
});
assert.notStrictEqual(overriddenFingerprint, baselineFingerprint);
assert.notStrictEqual(
  createGenerationFingerprint({
    ...fingerprintInput,
    shot: { ...fingerprintInput.shot, videoPromptOverride: "用户最终提示词 B" },
  }),
  overriddenFingerprint,
  "changing the complete prompt override must invalidate generated output",
);
assert.strictEqual(
  createGenerationFingerprint({
    ...fingerprintInput,
    character: { ...fingerprintInput.character, voiceProfile: "另一种声音" },
    shot: { ...fingerprintInput.shot, dialogue: "另一句台词", videoPromptOverride: "用户最终提示词 A" },
  }),
  overriddenFingerprint,
  "fields bypassed by an explicit complete prompt must not invalidate generated output",
);
assert.strictEqual(
  createGenerationFingerprint({ ...fingerprintInput, model: "MiniMax-H3", resolution: "768p", ratio: "9:16" }),
  createGenerationFingerprint({ ...fingerprintInput, model: "MiniMax-H3", resolution: "768p", ratio: "16:9" }),
  "MiniMax-H3 ratio is not effective when mandatory frame fields are used",
);
assert.deepStrictEqual(referenceRequirements("MiniMax-H3", ""), {
  mode: "frame-fields",
  firstImage: true,
  lastImage: false,
});
assert.deepStrictEqual(referenceRequirements("seedance-2.5", "人物停下"), {
  mode: "reference-images",
  firstImage: true,
  lastImage: true,
});

assert.deepStrictEqual(
  Object.keys(require("../generation-policy.cjs")).sort(),
  ["buildVideoOptions", "classifyModel", "composeVideoPrompt", "createGenerationFingerprint", "eligibleModels", "normalizeVideoDuration", "referenceRequirements", "resolveVideoPrompt", "videoDurationRange"],
);

console.log("generation-policy: ok");
