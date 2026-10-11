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

function createVault(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles).map(([filePath, value]) => [filePath, Buffer.from(value)]));
  const folders = new Set();
  const createdBinaryPaths = [];
  const modifiedBinaryPaths = [];
  const vault = {
    getAbstractFileByPath: (filePath) => files.has(filePath) || folders.has(filePath) ? { path: filePath } : null,
    createFolder: async (folderPath) => { folders.add(folderPath); },
    createBinary: async (filePath, value) => { createdBinaryPaths.push(filePath); files.set(filePath, Buffer.from(value)); },
    modifyBinary: async (file, value) => { modifiedBinaryPaths.push(file.path); files.set(file.path, Buffer.from(value)); },
  };
  return { vault, files, folders, createdBinaryPaths, modifiedBinaryPaths };
}

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

const outputTarget = {
  owner: "video-replica",
  projectId: "project-1",
  shotId: "008",
  assetType: "shot-video",
  destinationPath: "山竹视频复刻/project-1/03-分镜/008/视频.mp4",
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
    outputTarget,
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
  assert.deepStrictEqual(persisted.outputTarget, { ...outputTarget, overwrite: "replace-current" });

  const targetPlugin = new VideoPlugin();
  const fingerprintInputs = [];
  targetPlugin.api = {
    ...videoApi,
    createSubmissionFingerprint(value) {
      fingerprintInputs.push(value);
      return videoApi.createSubmissionFingerprint(value);
    },
  };
  targetPlugin.settings = { resolutionsByModel: {}, videoTasks: [], submissionMarkers: [] };
  targetPlugin.videoAccess = { accountUserId: "user-1" };
  targetPlugin.getRawQuota = async () => 100;
  targetPlugin.saveSettings = async () => {};
  const targetPayloads = [];
  targetPlugin.sendVideoPayload = async (payload) => {
    targetPayloads.push(payload);
    return { status: 200, json: { id: "project-video-task" } };
  };
  const targetTask = await targetPlugin.submitVideo({ ...baseOptions, outputTarget });
  assert.deepStrictEqual(targetTask.outputTarget, { ...outputTarget, overwrite: "replace-current" });
  assert.strictEqual(targetPayloads.length, 1);
  assert.strictEqual(Object.hasOwn(targetPayloads[0], "outputTarget"), false, "outputTarget must stay out of provider payloads");
  assert.strictEqual(JSON.stringify(targetPayloads).includes(outputTarget.destinationPath), false);
  assert.strictEqual(Object.hasOwn(targetTask.requestShape, "outputTarget"), false, "outputTarget must stay out of request shapes");
  assert.strictEqual(targetTask.requestShape.fields.includes("outputTarget"), false);
  assert.strictEqual(JSON.stringify(targetTask.requestShape).includes(outputTarget.destinationPath), false);
  assert.strictEqual(fingerprintInputs.length, 1);
  assert.strictEqual(Object.hasOwn(fingerprintInputs[0], "outputTarget"), false, "outputTarget must stay out of paid fingerprints");
  assert.strictEqual(JSON.stringify(fingerprintInputs).includes(outputTarget.destinationPath), false);
  assert.strictEqual(JSON.stringify(targetPlugin.settings.submissionMarkers).includes(outputTarget.destinationPath), false, "submission markers must not persist local paths");

  const usageTask = {
    ...targetTask,
    status: "completed",
    saved: true,
    localPath: outputTarget.destinationPath,
    usageRequestId: "",
    usageGroup: "",
  };
  let usageBridgePayload;
  const usageBridge = {
    getAccountUserId: () => "user-1",
    matchMediaUsage: async (tasks) => {
      usageBridgePayload = tasks;
      return {
        ok: true,
        matches: {
          [usageTask.id]: {
            accountUserId: "user-1",
            costUsd: "1.25",
            detail: "matched video usage",
            requestId: "request-1",
            tokenName: "video-token",
            group: "video-group",
          },
        },
      };
    },
  };
  const usagePlugin = new VideoPlugin();
  usagePlugin.settings = { resolutionsByModel: {}, videoTasks: [usageTask], submissionMarkers: [] };
  usagePlugin.app = { plugins: { getPlugin: () => ({ getAccountBridge: () => usageBridge }) } };
  usagePlugin.saveSettings = async () => {};
  await usagePlugin.refreshTaskUsageRecords();
  assert.deepStrictEqual(usageBridgePayload, [{
    kind: "video",
    id: usageTask.id,
    model: usageTask.model,
    group: usageTask.group,
    accountUserId: usageTask.accountUserId,
    createdAt: usageTask.createdAt,
    status: usageTask.status,
    usageRequestId: "",
    usageGroup: "",
  }]);
  assert.strictEqual(Object.hasOwn(usageBridgePayload[0], "outputTarget"), false);
  assert.strictEqual(JSON.stringify(usageBridgePayload).includes(outputTarget.destinationPath), false, "usage bridge payload must exclude every local destination path");
  assert.strictEqual(usageTask.usageLogMatched, true, "safe usage payload must still match usage records");
  assert.strictEqual(usageTask.cost, 1.25);

  const persistedSettings = JSON.parse(JSON.stringify(targetPlugin.settings));
  const projectVault = createVault({ [outputTarget.destinationPath]: "old video" });
  const restartedPlugin = new VideoPlugin();
  restartedPlugin.api = videoApi;
  restartedPlugin.settings = persistedSettings;
  restartedPlugin.app = { vault: projectVault.vault, plugins: {} };
  restartedPlugin.fetchVideoTask = async (task) => ({ id: task.id, status: "completed", url: "https://downloads.example/project.mp4" });
  restartedPlugin.request = async () => ({ status: 200, arrayBuffer: Buffer.from("new video") });
  restartedPlugin.getRawQuota = async () => 99;
  restartedPlugin.saveSettings = async () => {};
  restartedPlugin.refreshTaskUsageRecords = async () => {};
  await restartedPlugin.refreshVideoTasksNow();
  const restoredTask = restartedPlugin.settings.videoTasks.find((task) => task.id === targetTask.id);
  assert.strictEqual(restoredTask.saved, true);
  assert.strictEqual(restoredTask.localPath, outputTarget.destinationPath);
  assert.deepStrictEqual(projectVault.modifiedBinaryPaths, [outputTarget.destinationPath], "existing project video must be replaced with modifyBinary");
  assert.ok(![...projectVault.files.keys()].some((filePath) => filePath.startsWith("山竹创作记录/视频/")), "project tasks must not create a standalone copy");
  assert.strictEqual(restartedPlugin.settings.submissionMarkers.length, 0, "saved project output must reconcile its paid submission marker");

  const standaloneVault = createVault();
  const standalonePlugin = new VideoPlugin();
  standalonePlugin.api = videoApi;
  standalonePlugin.settings = { resolutionsByModel: {}, videoTasks: [], submissionMarkers: [] };
  standalonePlugin.app = { vault: standaloneVault.vault, plugins: {} };
  standalonePlugin.request = async () => ({ status: 200, arrayBuffer: Buffer.from("standalone video") });
  for (let index = 1; index <= 10; index += 1) {
    await standalonePlugin.saveCompletedVideo(
      { id: `standalone-task-${index}`, model: "seedance-2.5", prompt: `standalone ${index}` },
      { id: `standalone-task-${index}`, status: "completed", url: `https://downloads.example/${index}.mp4` },
    );
  }
  assert.strictEqual(standaloneVault.createdBinaryPaths.length, 10);
  assert.strictEqual(new Set(standaloneVault.createdBinaryPaths.map((filePath) => filePath.split("/").slice(0, -1).join("/"))).size, 1, "standalone videos must share one monthly directory");
  assert.ok(standaloneVault.createdBinaryPaths.every((filePath) => /^山竹创作记录\/视频\/\d{4}-\d{2}\/[^/]+\.mp4$/.test(filePath)), "standalone videos must not create one directory per task");

  const downloadFailurePlugin = new VideoPlugin();
  downloadFailurePlugin.api = videoApi;
  downloadFailurePlugin.settings = { resolutionsByModel: {}, videoTasks: [], submissionMarkers: [] };
  downloadFailurePlugin.videoAccess = { accountUserId: "user-1" };
  downloadFailurePlugin.getRawQuota = async () => 100;
  downloadFailurePlugin.saveSettings = async () => {};
  let downloadFailurePosts = 0;
  downloadFailurePlugin.sendVideoPayload = async () => {
    downloadFailurePosts += 1;
    return { status: 200, json: { id: "accepted-download-failure" } };
  };
  const acceptedTask = await downloadFailurePlugin.submitVideo({ ...baseOptions, outputTarget });
  downloadFailurePlugin.fetchVideoTask = async () => ({ id: acceptedTask.id, status: "completed", url: "https://downloads.example/fail.mp4" });
  downloadFailurePlugin.request = async () => ({ status: 503 });
  await downloadFailurePlugin.refreshVideoTasksNow();
  assert.strictEqual(downloadFailurePlugin.settings.videoTasks[0].id, acceptedTask.id, "download failure must retain the accepted task");
  assert.strictEqual(downloadFailurePlugin.settings.videoTasks[0].status, "retrying");
  assert.strictEqual(downloadFailurePlugin.settings.submissionMarkers[0].status, "accepted");
  const changedOutputTarget = {
    ...outputTarget,
    shotId: "009",
    destinationPath: "山竹视频复刻/project-1/03-分镜/009/视频.mp4",
  };
  await assert.rejects(
    downloadFailurePlugin.submitVideo({ ...baseOptions, outputTarget: changedOutputTarget }),
    /已阻止重复提交/,
  );
  assert.strictEqual(downloadFailurePosts, 1, "changing only the local destination must not bypass duplicate paid-request protection");

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
