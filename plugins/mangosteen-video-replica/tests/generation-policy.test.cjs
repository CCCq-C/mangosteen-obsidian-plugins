const assert = require("assert");
const {
  buildVideoOptions,
  classifyModel,
  createGenerationFingerprint,
  eligibleModels,
  referenceRequirements,
} = require("../generation-policy.cjs");

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
  ["buildVideoOptions", "classifyModel", "createGenerationFingerprint", "eligibleModels", "referenceRequirements"],
);

console.log("generation-policy: ok");
