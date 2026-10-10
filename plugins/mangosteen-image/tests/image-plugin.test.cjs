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
Module._load = originalLoad;

(async () => {
  const plugin = new ImagePlugin();
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
  } finally {
    global.window = originalWindow;
  }

  const responseLostPlugin = new ImagePlugin();
  responseLostPlugin.api = imageApi;
  responseLostPlugin.settings = { model: "gpt-image-2", size: "1024x1024", imageTasks: [], submissionMarkers: [] };
  responseLostPlugin.saveSettings = async () => {};
  let responseLostPosts = 0;
  responseLostPlugin.postJsonResponse = async () => {
    responseLostPosts += 1;
    throw new Error("socket closed after upload");
  };
  await assert.rejects(
    responseLostPlugin.generateText("safe prompt", 1),
    /提交结果待核对.*不会自动重复提交/,
  );
  assert.strictEqual(responseLostPosts, 1);
  assert.strictEqual(responseLostPlugin.settings.submissionMarkers[0].status, "uncertain");
  await assert.rejects(responseLostPlugin.generateText("safe prompt", 1), /已阻止重复提交/);
  assert.strictEqual(responseLostPosts, 1, "response-lost retry must not issue another paid POST");

  const saveFailurePlugin = new ImagePlugin();
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

  const batchPlugin = new ImagePlugin();
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

  console.log("image-plugin: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
