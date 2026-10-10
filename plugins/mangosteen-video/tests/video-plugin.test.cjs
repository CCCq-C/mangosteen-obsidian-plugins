const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Modal: class Modal {},
      Notice: class Notice {},
      Plugin: class Plugin {},
      requestUrl: async () => ({ status: 200 }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const VideoPlugin = require("../main.js");
const videoApi = require("../video-api.cjs");
Module._load = originalLoad;

const makeFile = (name, type, contents) => {
  const bytes = Uint8Array.from(Buffer.from(contents));
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  };
};

const makePlugin = (uploadTemporaryImage) => {
  const plugin = new VideoPlugin();
  plugin.api = videoApi;
  plugin.settings = { resolutionsByModel: {}, videoTasks: [] };
  plugin.app = {
    plugins: {
      getPlugin: (id) => id === "mangosteen-agent"
        ? { getAccountBridge: () => ({ uploadTemporaryImage }) }
        : null,
    },
  };
  plugin.getRawQuota = async () => 100;
  plugin.rememberVideoTask = async (task) => task;
  return plugin;
};

const baseOptions = {
  model: "seedance-2.5",
  prompt: "keep the same character",
  duration: 5,
  ratio: "16:9",
  resolution: "720p",
};

(async () => {
  const files = [
    makeFile("character-front.png", "image/png", "front"),
    makeFile("character-side.webp", "image/webp", "side"),
  ];
  const uploads = [];
  const sentPayloads = [];
  const plugin = makePlugin(async (upload) => {
    uploads.push(upload);
    return { ok: true, url: `https://uploads.example/${upload.name}` };
  });
  plugin.sendVideoPayload = async (payload) => {
    sentPayloads.push(payload);
    return { status: 200, json: { id: "video-task-1" } };
  };

  await plugin.submitVideo({ ...baseOptions, referenceImageFiles: files });

  assert.deepStrictEqual(uploads.map((upload) => upload.name), files.map((file) => file.name));
  assert.strictEqual(uploads.length, 2);
  assert.strictEqual(sentPayloads.length, 1);
  assert.deepStrictEqual(sentPayloads[0].referenceImages, [
    "https://uploads.example/character-front.png",
    "https://uploads.example/character-side.webp",
  ]);
  assert.strictEqual(Object.hasOwn(sentPayloads[0], "referenceImageFiles"), false);
  assert.strictEqual(sentPayloads[0].referenceImages.some((item) => typeof item !== "string"), false);

  const mixedReferenceUploads = [];
  const mixedReferencePayloads = [];
  const mixedReferencePlugin = makePlugin(async (upload) => {
    mixedReferenceUploads.push(upload.name);
    return { ok: true, url: `https://uploads.example/${upload.name}` };
  });
  mixedReferencePlugin.sendVideoPayload = async (payload) => {
    mixedReferencePayloads.push(payload);
    return { status: 200, json: { id: "video-task-2" } };
  };
  await mixedReferencePlugin.submitVideo({
    ...baseOptions,
    referenceImages: ["https://assets.example/existing.png"],
    referenceImageFiles: files,
  });
  assert.deepStrictEqual(mixedReferenceUploads, ["character-front.png", "character-side.webp"]);
  assert.deepStrictEqual(mixedReferencePayloads[0].referenceImages, [
    "https://assets.example/existing.png",
    "https://uploads.example/character-front.png",
    "https://uploads.example/character-side.webp",
  ]);

  let httpQuotaLookups = 0;
  let httpPaidRequests = 0;
  const httpPlugin = makePlugin(async () => ({ ok: true, url: "http://uploads.example/insecure.png" }));
  httpPlugin.getRawQuota = async () => {
    httpQuotaLookups += 1;
    return 100;
  };
  httpPlugin.sendVideoPayload = async () => {
    httpPaidRequests += 1;
    return { status: 200, json: { id: "must-not-exist" } };
  };
  await assert.rejects(
    httpPlugin.submitVideo({ ...baseOptions, referenceImageFiles: [files[0]] }),
    /参考图片上传失败/
  );
  assert.strictEqual(httpQuotaLookups, 0);
  assert.strictEqual(httpPaidRequests, 0);

  let limitUploads = 0;
  let limitQuotaLookups = 0;
  let limitPaidRequests = 0;
  const limitPlugin = makePlugin(async () => {
    limitUploads += 1;
    return { ok: true, url: "https://uploads.example/must-not-upload.png" };
  });
  limitPlugin.getRawQuota = async () => {
    limitQuotaLookups += 1;
    return 100;
  };
  limitPlugin.sendVideoPayload = async () => {
    limitPaidRequests += 1;
    return { status: 200, json: { id: "must-not-exist" } };
  };
  await assert.rejects(
    limitPlugin.submitVideo({
      ...baseOptions,
      referenceImages: Array.from({ length: 29 }, (_, index) => `https://assets.example/reference-${index + 1}.png`),
      referenceImageFiles: files,
    }),
    /最多填写 30 个/
  );
  assert.strictEqual(limitUploads, 0);
  assert.strictEqual(limitQuotaLookups, 0);
  assert.strictEqual(limitPaidRequests, 0);

  let paidRequests = 0;
  const failingPlugin = makePlugin(async () => ({ ok: false, code: "NETWORK_UNAVAILABLE" }));
  failingPlugin.sendVideoPayload = async () => {
    paidRequests += 1;
    return { status: 200, json: { id: "must-not-exist" } };
  };
  await assert.rejects(
    failingPlugin.submitVideo({ ...baseOptions, referenceImageFiles: [files[0]] }),
    /参考图片上传失败.*NETWORK_UNAVAILABLE/
  );
  assert.strictEqual(paidRequests, 0);

  console.log("video-plugin: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
