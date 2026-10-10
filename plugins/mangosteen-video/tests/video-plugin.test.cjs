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

  const existingUrlPayloads = [];
  const existingUrlPlugin = makePlugin(async () => {
    throw new Error("URL-only callers must not upload");
  });
  existingUrlPlugin.sendVideoPayload = async (payload) => {
    existingUrlPayloads.push(payload);
    return { status: 200, json: { id: "video-task-2" } };
  };
  await existingUrlPlugin.submitVideo({
    ...baseOptions,
    referenceImages: ["https://assets.example/existing.png"],
  });
  assert.deepStrictEqual(existingUrlPayloads[0].referenceImages, ["https://assets.example/existing.png"]);

  let paidRequests = 0;
  const failingPlugin = makePlugin(async () => ({ ok: false }));
  failingPlugin.sendVideoPayload = async () => {
    paidRequests += 1;
    return { status: 200, json: { id: "must-not-exist" } };
  };
  await assert.rejects(
    failingPlugin.submitVideo({ ...baseOptions, referenceImageFiles: [files[0]] }),
    /参考图片上传失败/
  );
  assert.strictEqual(paidRequests, 0);

  console.log("video-plugin: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
