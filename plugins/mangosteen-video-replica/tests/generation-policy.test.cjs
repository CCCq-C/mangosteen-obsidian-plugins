const assert = require("assert");
const {
  buildVideoOptions,
  classifyModel,
  eligibleModels,
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
assert.strictEqual(classifyModel("vendor-seedance-preview"), "seedance");
assert.strictEqual(classifyModel("sd-2.0-stable"), "seedance");
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

assert.deepStrictEqual(
  Object.keys(require("../generation-policy.cjs")).sort(),
  ["buildVideoOptions", "classifyModel", "eligibleModels"],
);

console.log("generation-policy: ok");
