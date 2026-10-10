const assert = require("assert");
const api = require("../video-api.cjs");

const imageUrls = (count) => Array.from({ length: count }, (_, index) => `https://assets.example/image-${index + 1}.png`);

assert.deepStrictEqual(api.createVideoPayload({
  model: "MiniMax-H3", prompt: "move", duration: 4,
  ratio: "9:16", resolution: "768p", firstImage: "https://assets.example/first.png"
}), {
  model: "MiniMax-H3", prompt: "move", duration: 4,
  resolution: "768p", first_image: "https://assets.example/first.png"
});

assert.throws(() => api.createVideoPayload({
  model: "MiniMax-H3", prompt: "move", duration: 4, resolution: "768p",
  firstImage: "https://assets.example/first.png", referenceImages: ["https://assets.example/person.png"]
}), /不能同时使用/);

assert.throws(() => api.createVideoPayload({
  model: "seedance-2.5", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p",
  firstImage: "https://assets.example/first.png"
}), /Seedance.*参考图片/);

const seedance20Payload = api.createVideoPayload({
  model: "sd-2.0-fast", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p",
  referenceImages: imageUrls(9)
});
assert.strictEqual(seedance20Payload.referenceImages.length, 9);
assert.throws(() => api.createVideoPayload({
  model: "sd-2.0-fast", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p",
  referenceImages: imageUrls(10)
}), /最多填写 9 个/);

const seedance25Payload = api.createVideoPayload({
  model: "seedance-2.5", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p",
  referenceImages: imageUrls(30)
});
assert.strictEqual(seedance25Payload.referenceImages.length, 30);
assert.throws(() => api.createVideoPayload({
  model: "seedance-2.5", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p",
  referenceImages: imageUrls(31)
}), /最多填写 30 个/);

for (const [field, label] of [
  ["referenceImages", "参考图片"],
  ["referenceVideos", "参考视频"],
  ["referenceAudios", "参考音频"],
]) {
  assert.throws(() => api.createVideoPayload({
    model: "MiniMax-H3", prompt: "move", duration: 4, resolution: "768p",
    [field]: ["https://assets.example/reference.png"]
  }), new RegExp(`MiniMax-H3.*不支持.*${label}`));
}

assert.strictEqual(api.resolveVideoModelFamily(" MiniMax-H3 "), "minimax-h3");
assert.strictEqual(api.resolveVideoModelFamily("sd-2.0-stable"), "seedance-2.0");
assert.strictEqual(api.resolveVideoModelFamily("seedance-2.5_k1"), "seedance-2.5");
assert.strictEqual(api.resolveVideoModelFamily("wan3.0-video-prime"), "generic");
assert.strictEqual(api.VIDEO_INPUT_CAPABILITIES["minimax-h3"].mode, "frame");
assert.strictEqual(api.VIDEO_INPUT_CAPABILITIES["seedance-2.0"].maxReferenceImages, 9);
assert.strictEqual(api.VIDEO_INPUT_CAPABILITIES["seedance-2.5"].maxReferenceImages, 30);

assert.deepStrictEqual(api.createVideoPayload({
  model: "generic-model", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p",
  firstImage: "https://assets.example/first.png", referenceImages: ["https://assets.example/person.png"]
}), {
  model: "generic-model", prompt: "move", duration: 4, resolution: "720p",
  referenceImages: ["https://assets.example/person.png"], first_image: "https://assets.example/first.png"
});

const h3RequestShape = api.createVideoRequestShape(api.createVideoPayload({
  model: "MiniMax-H3", prompt: "move", duration: 4,
  ratio: "9:16", resolution: "768p",
  firstImage: "https://signed.example/first.png?secret=one",
  lastImage: "https://signed.example/last.png?secret=two",
}));
assert.deepStrictEqual(h3RequestShape, {
  version: 1,
  fields: ["duration", "first_image", "last_image", "model", "prompt", "resolution"],
  hasFirstImage: true,
  hasLastImage: true,
  hasRatio: false,
  hasGenerateAudio: false,
  referenceImageCount: 0,
  referenceVideoCount: 0,
  referenceAudioCount: 0,
});
assert.strictEqual(JSON.stringify(h3RequestShape).includes("signed.example"), false);

const seedanceRequestShape = api.createVideoRequestShape(seedance25Payload);
assert.strictEqual(seedanceRequestShape.hasFirstImage, false);
assert.strictEqual(seedanceRequestShape.hasLastImage, false);
assert.strictEqual(seedanceRequestShape.hasRatio, true);
assert.strictEqual(seedanceRequestShape.referenceImageCount, 30);

assert.throws(() => api.createVideoPayload({
  model: "MiniMax-H3", prompt: "move", duration: 4, resolution: "768p",
  firstImage: "http://assets.example/first.png"
}), /HTTPS/);
assert.throws(() => api.createVideoPayload({
  model: "seedance-2.5", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p",
  referenceImages: ["https://127.0.0.1/private.png"]
}), /公网 HTTPS/);
assert.throws(() => api.createVideoPayload({
  model: "MiniMax-H3", prompt: "move", duration: 4, resolution: "768p", generateAudio: true
}), /MiniMax-H3.*音频/);
assert.throws(() => api.createVideoPayload({
  model: "vendor-seedance-preview", prompt: "move", duration: 4, ratio: "9:16", resolution: "720p"
}), /不支持的 Seedance/);
assert.strictEqual(api.resolveVideoModelFamily("vendor-seedance-preview"), "unsupported-seedance");

const submissionFingerprint = api.createSubmissionFingerprint({
  model: "MiniMax-H3", prompt: "move", frame: Buffer.from("first-frame"),
});
assert.match(submissionFingerprint, /^sha256:[a-f0-9]{64}$/);
assert.strictEqual(submissionFingerprint, api.createSubmissionFingerprint({
  prompt: "move", frame: Buffer.from("first-frame"), model: "MiniMax-H3",
}));
assert.notStrictEqual(submissionFingerprint, api.createSubmissionFingerprint({
  model: "MiniMax-H3", prompt: "move", frame: Buffer.from("changed-frame"),
}));

console.log("video-api: ok");
