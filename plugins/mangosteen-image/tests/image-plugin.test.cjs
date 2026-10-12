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

const ImagePlugin = require("../main.js");
const imageApi = require("../image-api.cjs");
const imageOutputStorage = require("../output-storage.cjs");
Module._load = originalLoad;

const newImagePlugin = () => Object.assign(new ImagePlugin(), { outputStorage: imageOutputStorage });

function createVault(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles).map(([filePath, value]) => [filePath, Buffer.from(value)]));
  const folders = [];
  const createdBinaryPaths = [];
  const modifiedBinaryPaths = [];
  const vault = {
    adapter: { exists: async (filePath) => files.has(filePath) || folders.includes(filePath) },
    createFolder: async (folderPath) => { folders.push(folderPath); },
    getAbstractFileByPath: (filePath) => files.has(filePath) ? { path: filePath } : null,
    create: async (filePath, value) => { files.set(filePath, Buffer.from(value)); return { path: filePath }; },
    read: async (file) => files.get(file.path).toString("utf8"),
    modify: async (file, value) => { files.set(file.path, Buffer.from(value)); },
    createBinary: async (filePath, value) => { createdBinaryPaths.push(filePath); files.set(filePath, Buffer.from(value)); },
    modifyBinary: async (file, value) => { modifiedBinaryPaths.push(file.path); files.set(file.path, Buffer.from(value)); },
  };
  return { vault, files, folders, createdBinaryPaths, modifiedBinaryPaths };
}

(async () => {
  const plugin = newImagePlugin();
  assert.strictEqual(plugin.supportsOutputTargetSave(), true, "current image plugin must explicitly advertise target-aware saves");
  let polls = 0;
  plugin.api = {
    readImageTaskProgress: () => null,
    readImageTaskState: () => "processing",
  };
  plugin.extractResults = () => (++polls >= 91 ? [{ kind: "url", value: "https://example.test/image.png" }] : []);
  plugin.fetchImageTask = async () => ({ data: { status: "processing" } });
  plugin.saveSettings = async () => {};
  plugin.refreshImageTaskViews = () => {};

  const originalWindow = global.window;
  global.window = { setTimeout: (callback) => { callback(); return 1; } };
  try {
    const task = { id: "slow-image-task", status: "processing" };
    const response = await plugin.waitForImageTask(task);
    assert.strictEqual(response.__mangosteenTaskId, task.id);
    assert.strictEqual(task.status, "completed");
    assert.strictEqual(polls, 91, "a valid image task taking just over three minutes must not be abandoned");

    const reconnectingPlugin = newImagePlugin();
    reconnectingPlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
    reconnectingPlugin.api = {
      readImageTaskProgress: () => null,
      readImageTaskState: () => "processing",
    };
    let reconnectPolls = 0;
    reconnectingPlugin.fetchImageTask = async () => {
      reconnectPolls += 1;
      if (reconnectPolls === 1) throw new Error("net::ERR_NETWORK_CHANGED");
      return reconnectPolls === 2
        ? { data: { status: "processing" } }
        : { data: [{ url: "https://example.test/recovered.png" }] };
    };
    reconnectingPlugin.extractResults = (response) => response?.data?.[0]?.url
      ? [{ kind: "url", value: response.data[0].url }]
      : [];
    reconnectingPlugin.saveSettings = async () => {};
    reconnectingPlugin.refreshImageTaskViews = () => {};
    const reconnectTask = { id: "accepted-image-task", status: "processing", submissionFingerprint: "sha256:accepted" };
    const recovered = await reconnectingPlugin.waitForImageTask(reconnectTask);
    assert.strictEqual(recovered.__mangosteenTaskId, reconnectTask.id);
    assert.strictEqual(reconnectTask.status, "completed");
    assert.strictEqual(reconnectPolls, 3, "a transient polling disconnect must keep querying the accepted paid task");
  } finally {
    global.window = originalWindow;
  }

  const responseLostPlugin = newImagePlugin();
  responseLostPlugin.api = imageApi;
  responseLostPlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  responseLostPlugin.saveSettings = async () => {};
  let responseLostPosts = 0;
  responseLostPlugin.postJsonResponse = async () => {
    responseLostPosts += 1;
    throw new Error("socket closed after upload");
  };
  const firstOutputTarget = { owner: "video-replica", destinationPath: "山竹视频复刻/project-1/03-分镜/001/首帧.png" };
  const secondOutputTarget = { owner: "video-replica", destinationPath: "山竹视频复刻/project-1/03-分镜/002/首帧.png" };
  await assert.rejects(
    responseLostPlugin.generateText("safe prompt", 1, "single", { outputTarget: firstOutputTarget }),
    /提交结果待核对.*不会自动重复提交/,
  );
  assert.strictEqual(responseLostPosts, 1);
  assert.strictEqual(responseLostPlugin.settings.submissionMarkers[0].status, "uncertain");
  await assert.rejects(responseLostPlugin.generateText("safe prompt", 1, "single", { outputTarget: secondOutputTarget }), /已阻止重复提交/);
  assert.strictEqual(responseLostPosts, 1, "response-lost retry must not issue another paid POST");

  const saveFailurePlugin = newImagePlugin();
  saveFailurePlugin.api = imageApi;
  saveFailurePlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  let saveFailurePosts = 0;
  let saveCalls = 0;
  saveFailurePlugin.postJsonResponse = async () => {
    saveFailurePosts += 1;
    return { status: 200, json: { id: "accepted-image-task" }, __mangosteenGroup: "image" };
  };
  saveFailurePlugin.saveSettings = async () => {
    saveCalls += 1;
    if (saveCalls === 2) throw new Error("disk unavailable");
  };
  await assert.rejects(
    saveFailurePlugin.generateText("save failure prompt", 1),
    /提交结果待核对.*不会自动重复提交/,
  );
  assert.strictEqual(saveFailurePosts, 1);
  assert.strictEqual(saveFailurePlugin.settings.submissionMarkers[0].status, "uncertain");
  await assert.rejects(saveFailurePlugin.generateText("save failure prompt", 1), /已阻止重复提交/);
  assert.strictEqual(saveFailurePosts, 1, "save-failure retry must not issue another paid POST");

  const batchPlugin = newImagePlugin();
  batchPlugin.api = imageApi;
  batchPlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  batchPlugin.saveSettings = async () => {};
  let batchPosts = 0;
  batchPlugin.postJsonResponse = async () => ({ status: 200, json: { id: `batch-task-${++batchPosts}` } });
  batchPlugin.waitForImageTask = async (task) => ({ __mangosteenTaskId: task.id, __mangosteenSubmissionFingerprint: task.submissionFingerprint });
  const batch = await batchPlugin.generateTextBatch("two legitimate images", 2);
  assert.strictEqual(batch.successes.length, 2);
  assert.strictEqual(batchPosts, 2, "two explicit batch slots must remain distinct paid requests");
  assert.strictEqual(new Set(batchPlugin.settings.submissionMarkers.map((item) => item.fingerprint)).size, 2);
  await batchPlugin.reconcileImageSubmission(batch.successes[0].response.__mangosteenSubmissionFingerprint);
  assert.strictEqual(batchPlugin.settings.submissionMarkers.length, 1, "persisted image output reconciles only its own marker");

  const overridePlugin = newImagePlugin();
  overridePlugin.api = imageApi;
  overridePlugin.settings = { model: "gpt-image-2-adobe", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  overridePlugin.saveSettings = async () => {};
  let overridePayload;
  let overrideRequestModel;
  overridePlugin.postJsonResponse = async (_path, payload, model) => {
    overridePayload = payload;
    overrideRequestModel = model;
    return { status: 200, json: { id: "override-image-task" }, __mangosteenGroup: "gpt_image_web" };
  };
  overridePlugin.waitForImageTask = async (task) => ({ task });
  const overrideResponse = await overridePlugin.generateText("use explicit model", 1, "video-replica", { model: "gpt-image-2-w" });
  assert.strictEqual(overridePayload.model, "gpt-image-2-w");
  assert.strictEqual(overrideRequestModel, "gpt-image-2-w");
  assert.strictEqual(overrideResponse.task.model, "gpt-image-2-w");
  assert.strictEqual(overridePlugin.settings.model, "gpt-image-2-adobe", "per-request model must not mutate the standalone image setting");

  const outputTarget = {
    owner: "video-replica",
    projectId: "project-1",
    shotId: "008",
    assetType: "first-frame",
    destinationPath: "山竹视频复刻/project-1/03-分镜/008/首帧.png",
  };
  const usageTask = {
    id: "usage-image-task",
    taskPath: "/v1/images/generations/tasks",
    mode: "文生图",
    model: "gpt-image-2-w",
    group: "gpt_image_web",
    size: "1024x1024",
    requestedCount: 1,
    outputCount: 1,
    accountUserId: "account-1",
    createdAt: "2026-10-11T07:00:51.000Z",
    status: "completed",
    usageRequestId: "",
    usageGroup: "",
    outputTarget,
    imagePaths: [outputTarget.destinationPath],
    recordPath: outputTarget.destinationPath,
    saved: true,
  };
  let usageBridgePayload;
  const usageBridge = {
    getAccountUserId: () => "account-1",
    matchMediaUsage: async (tasks) => {
      usageBridgePayload = tasks;
      return {
        ok: true,
        matches: {
          [usageTask.id]: {
            accountUserId: "account-1",
            costUsd: "0.125",
            detail: "matched image usage",
            requestId: "request-1",
            tokenName: "image-token",
            group: "gpt_image_web",
          },
        },
      };
    },
  };
  const usagePlugin = newImagePlugin();
  usagePlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [usageTask], submissionMarkers: [] };
  usagePlugin.app = { plugins: { getPlugin: () => ({ getAccountBridge: () => usageBridge }) } };
  usagePlugin.saveSettings = async () => {};
  usagePlugin.refreshImageTaskViews = () => {};
  await usagePlugin.refreshTaskUsageRecords();
  assert.deepStrictEqual(usageBridgePayload, [{
    kind: "image",
    id: usageTask.id,
    taskPath: usageTask.taskPath,
    mode: usageTask.mode,
    model: usageTask.model,
    group: usageTask.group,
    size: usageTask.size,
    requestedCount: usageTask.requestedCount,
    outputCount: usageTask.outputCount,
    accountUserId: usageTask.accountUserId,
    createdAt: usageTask.createdAt,
    status: usageTask.status,
    usageRequestId: "",
    usageGroup: "",
  }]);
  assert.ok(!Object.prototype.hasOwnProperty.call(usageBridgePayload[0], "outputTarget"));
  assert.ok(!JSON.stringify(usageBridgePayload).includes("destinationPath"), "usage-log bridge payload must exclude every local destination path");
  assert.strictEqual(usageTask.usageLogMatched, true, "safe usage payload must still match usage records");
  assert.strictEqual(usageTask.cost, 0.125);
  assert.strictEqual(usageTask.usageRequestId, "request-1");

  const targetPlugin = newImagePlugin();
  targetPlugin.api = imageApi;
  targetPlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  targetPlugin.saveSettings = async () => {};
  let remoteJsonPayload;
  targetPlugin.postJsonResponse = async (_path, payload) => {
    remoteJsonPayload = payload;
    return { status: 200, json: { id: "persisted-project-task" } };
  };
  targetPlugin.waitForImageTask = async (task) => ({ task });
  const targetResponse = await targetPlugin.generateText("project frame", 1, "shot-008", { outputTarget });
  assert.ok(!Object.prototype.hasOwnProperty.call(remoteJsonPayload, "outputTarget"), "outputTarget must stay out of remote JSON");
  assert.deepStrictEqual(targetResponse.task.outputTarget, { ...outputTarget, overwrite: "replace-current" });

  const synchronousPlugin = newImagePlugin();
  synchronousPlugin.api = imageApi;
  synchronousPlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  synchronousPlugin.saveSettings = async () => {};
  synchronousPlugin.postJsonResponse = async () => ({ status: 200, json: { data: [{ b64_json: Buffer.from("sync image").toString("base64") }] } });
  const synchronousResponse = await synchronousPlugin.generateText("synchronous project frame", 1, "shot-008-sync", { outputTarget });
  assert.deepStrictEqual(synchronousResponse.__mangosteenOutputTarget, { ...outputTarget, overwrite: "replace-current" });
  assert.deepStrictEqual(synchronousPlugin.settings.imageTasks[0].outputTarget, synchronousResponse.__mangosteenOutputTarget, "sync and async tasks must persist the same normalized destination");

  const editPlugin = newImagePlugin();
  editPlugin.api = imageApi;
  editPlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  editPlugin.saveSettings = async () => {};
  editPlugin.refreshAgentAccess = async () => {};
  editPlugin.requireKey = () => {};
  let remoteMultipartFields;
  editPlugin.postMultipart = async (_path, fields) => {
    remoteMultipartFields = fields;
    return { status: 200, json: { id: "persisted-edit-task" } };
  };
  editPlugin.waitForImageTask = async (task) => ({ task });
  const editResponse = await editPlugin.generateEditMulti("edit project frame", [{ name: "ref.png", type: "image/png", buffer: Buffer.from("ref") }], "shot-008", { outputTarget });
  assert.ok(!Object.prototype.hasOwnProperty.call(remoteMultipartFields, "outputTarget"), "outputTarget must stay out of multipart fields");
  assert.deepStrictEqual(editResponse.task.outputTarget, { ...outputTarget, overwrite: "replace-current" });

  const persistedSettings = JSON.parse(JSON.stringify(targetPlugin.settings));
  const projectVault = createVault({ [outputTarget.destinationPath]: "old image" });
  const restartedPlugin = newImagePlugin();
  restartedPlugin.api = imageApi;
  restartedPlugin.settings = persistedSettings;
  restartedPlugin.app = { vault: projectVault.vault, plugins: {} };
  restartedPlugin.fetchImageTask = async () => ({ data: [{ b64_json: Buffer.from("new image").toString("base64") }] });
  restartedPlugin.saveSettings = async () => {};
  restartedPlugin.refreshImageTaskViews = () => {};
  await restartedPlugin.refreshImageTasksNow();
  const restoredTask = restartedPlugin.settings.imageTasks.find((task) => task.id === "persisted-project-task");
  assert.strictEqual(restoredTask.saved, true);
  assert.deepStrictEqual(restoredTask.imagePaths, [outputTarget.destinationPath]);
  assert.deepStrictEqual(projectVault.modifiedBinaryPaths, [outputTarget.destinationPath], "existing project images must be replaced with modifyBinary");
  assert.ok(![...projectVault.files.keys()].some((filePath) => filePath.endsWith("任务记录.md")), "project tasks must not append the global history record");
  assert.ok(![...projectVault.files.keys()].some((filePath) => filePath.startsWith("山竹创作记录/图片/")), "project tasks must not create a global history copy");
  assert.strictEqual(restartedPlugin.settings.submissionMarkers.length, 0, "saved project output must reconcile its paid submission marker");

  const standaloneVault = createVault();
  const standalonePlugin = newImagePlugin();
  standalonePlugin.api = imageApi;
  standalonePlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  standalonePlugin.app = { vault: standaloneVault.vault, plugins: {} };
  standalonePlugin.toSelectedImage = async (_candidate, index) => ({ name: `image-${index}.png`, type: "image/png", buffer: Buffer.from(`image-${index}`) });
  for (let index = 1; index <= 10; index += 1) {
    await standalonePlugin.persistGeneration({
      candidates: [{ kind: "base64", value: "" }],
      prompt: `standalone ${index}`,
      mode: "文生图",
      cost: null,
      taskId: `task-${index}`,
    });
  }
  const standaloneImagePaths = standaloneVault.createdBinaryPaths.filter((filePath) => /\.(?:png|jpe?g|webp)$/i.test(filePath));
  assert.strictEqual(standaloneImagePaths.length, 10);
  assert.strictEqual(new Set(standaloneImagePaths.map((filePath) => filePath.split("/").slice(0, -1).join("/"))).size, 1, "standalone images must share one monthly directory");
  assert.ok(standaloneImagePaths.every((filePath) => /^山竹创作记录\/图片\/\d{4}-\d{2}\/[^/]+\.png$/.test(filePath)), "standalone images must not create one directory per task");

  const multiSaved = await standalonePlugin.persistGeneration({
    candidates: [{ kind: "base64", value: "" }, { kind: "base64", value: "" }],
    prompt: "standalone multi-image task",
    mode: "文生图",
    cost: null,
    taskId: "task-multi",
  });
  assert.match(multiSaved.imagePaths[0], /-task-multi-01\.png$/);
  assert.match(multiSaved.imagePaths[1], /-task-multi-02\.png$/);

  console.log("image-plugin: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
