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

  const submittedTask = await plugin.submitVideo({ ...baseOptions, referenceImageFiles: files });

  assert.deepStrictEqual(uploads.map((upload) => upload.name), files.map((file) => file.name));
  assert.strictEqual(uploads.length, 2);
  assert.strictEqual(sentPayloads.length, 1);
  assert.deepStrictEqual(sentPayloads[0].referenceImages, [
    "https://uploads.example/character-front.png",
    "https://uploads.example/character-side.webp",
  ]);
  assert.strictEqual(Object.hasOwn(sentPayloads[0], "referenceImageFiles"), false);
  assert.strictEqual(sentPayloads[0].referenceImages.some((item) => typeof item !== "string"), false);
  assert.deepStrictEqual(submittedTask.requestShape, {
    version: 1,
    fields: ["duration", "model", "prompt", "ratio", "referenceImages", "resolution"],
    hasFirstImage: false,
    hasLastImage: false,
    hasRatio: true,
    hasGenerateAudio: false,
    referenceImageCount: 2,
    referenceVideoCount: 0,
    referenceAudioCount: 0,
  });

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

  const persistencePlugin = new VideoPlugin();
  persistencePlugin.api = videoApi;
  persistencePlugin.videoAccess = { accountUserId: "user-1" };
  persistencePlugin.settings = { videoTasks: [] };
  persistencePlugin.saveSettings = async () => {};
  const persisted = await persistencePlugin.rememberVideoTask({
    id: "persisted-task",
    payload: {
      model: "seedance-2.5",
      prompt: "safe prompt",
      duration: 4,
      ratio: "9:16",
      resolution: "720p",
      first_image: "https://signed.example/first.png?secret=one",
      last_image: "https://signed.example/last.png?secret=two",
      referenceImages: ["https://signed.example/reference.png?secret=three"],
      referenceVideos: ["https://signed.example/reference.mp4?secret=four"],
      referenceAudios: ["https://signed.example/reference.mp3?secret=five"],
    },
    requestShape: {
      version: 1,
      fields: ["first_image", "last_image", "referenceImages", "referenceVideos", "referenceAudios"],
      hasFirstImage: true,
      hasLastImage: true,
      hasRatio: true,
      hasGenerateAudio: false,
      referenceImageCount: 1,
      referenceVideoCount: 1,
      referenceAudioCount: 1,
    },
  });
  for (const field of ["first_image", "last_image", "referenceImages", "referenceVideos", "referenceAudios"]) {
    assert.strictEqual(Object.hasOwn(persisted.payload, field), false, `${field} must not persist signed media URLs`);
  }
  assert.strictEqual(persisted.requestShape.referenceImageCount, 1);
  assert.strictEqual(JSON.stringify(persisted).includes("signed.example"), false);

  const successPlugin = new VideoPlugin();
  successPlugin.api = videoApi;
  successPlugin.settings = { resolutionsByModel: {}, videoTasks: [], submissionMarkers: [] };
  successPlugin.videoAccess = { accountUserId: "user-1" };
  successPlugin.getRawQuota = async () => 100;
  successPlugin.saveSettings = async () => {};
  successPlugin.sendVideoPayload = async () => ({ status: 200, json: { id: "normal-video-task" } });
  const normalTask = await successPlugin.submitVideo(baseOptions);
  assert.strictEqual(normalTask.id, "normal-video-task");
  assert.strictEqual(successPlugin.settings.submissionMarkers[0].status, "accepted");
  assert.deepStrictEqual(successPlugin.settings.submissionMarkers[0].requestShape, normalTask.requestShape);
  successPlugin.fetchVideoTask = async () => ({ id: normalTask.id, status: "completed" });
  successPlugin.saveCompletedVideo = async () => "山竹视频/normal-video-task/output.mp4";
  successPlugin.refreshTaskUsageRecords = async () => {};
  await successPlugin.refreshVideoTasksNow();
  assert.strictEqual(successPlugin.settings.videoTasks[0].status, "completed");
  assert.strictEqual(successPlugin.settings.submissionMarkers.length, 0, "terminal success reconciles the paid submission marker");

  const unavailablePlugin = new VideoPlugin();
  unavailablePlugin.api = videoApi;
  unavailablePlugin.settings = { resolutionsByModel: {}, videoTasks: [], submissionMarkers: [] };
  unavailablePlugin.videoAccess = { accountUserId: "user-1" };
  unavailablePlugin.getRawQuota = async () => 100;
  unavailablePlugin.saveSettings = async () => {};
  unavailablePlugin.sendVideoPayload = async () => ({ status: 404, json: { error: { message: "model not found" } } });
  await assert.rejects(
    unavailablePlugin.submitVideo({ ...baseOptions, model: "MiniMax-H3", resolution: "768p" }),
    (error) => error?.status === 404 && error?.model === "MiniMax-H3" && error?.changeModel === true,
  );

  const responseLostPlugin = new VideoPlugin();
  responseLostPlugin.api = videoApi;
  responseLostPlugin.settings = { resolutionsByModel: {}, videoTasks: [], submissionMarkers: [] };
  responseLostPlugin.videoAccess = { accountUserId: "user-1" };
  responseLostPlugin.getRawQuota = async () => 100;
  responseLostPlugin.saveSettings = async () => {};
  let responseLostPosts = 0;
  responseLostPlugin.sendVideoPayload = async () => {
    responseLostPosts += 1;
    throw new Error("socket closed after upload");
  };
  await assert.rejects(
    responseLostPlugin.submitVideo(baseOptions),
    /提交结果待核对.*不会自动重复提交/,
  );
  assert.strictEqual(responseLostPosts, 1);
  assert.strictEqual(responseLostPlugin.settings.submissionMarkers[0].status, "uncertain");
  await assert.rejects(
    responseLostPlugin.submitVideo(baseOptions),
    /已阻止重复提交/,
  );
  assert.strictEqual(responseLostPosts, 1, "response-lost retry must not issue another paid POST");

  const saveFailurePlugin = new VideoPlugin();
  saveFailurePlugin.api = videoApi;
  saveFailurePlugin.settings = { resolutionsByModel: {}, videoTasks: [], submissionMarkers: [] };
  saveFailurePlugin.videoAccess = { accountUserId: "user-1" };
  saveFailurePlugin.getRawQuota = async () => 100;
  let saveFailurePosts = 0;
  let saveCalls = 0;
  saveFailurePlugin.sendVideoPayload = async () => {
    saveFailurePosts += 1;
    return { status: 200, json: { id: "accepted-but-save-failed" } };
  };
  saveFailurePlugin.saveSettings = async () => {
    saveCalls += 1;
    if (saveCalls === 2) throw new Error("disk unavailable");
  };
  await assert.rejects(
    saveFailurePlugin.submitVideo(baseOptions),
    /提交结果待核对.*不会自动重复提交/,
  );
  assert.strictEqual(saveFailurePosts, 1);
  assert.strictEqual(saveFailurePlugin.settings.submissionMarkers[0].status, "uncertain");
  await assert.rejects(saveFailurePlugin.submitVideo(baseOptions), /已阻止重复提交/);
  assert.strictEqual(saveFailurePosts, 1, "save-failure retry must not issue another paid POST");

  console.log("video-plugin: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
