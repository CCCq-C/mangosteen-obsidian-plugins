const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Modal: class Modal {},
      Notice: class Notice {},
      Plugin: class Plugin {},
      requestUrl: async () => ({ status: 200, arrayBuffer: new ArrayBuffer(0) }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ReplicaPlugin = require("../main.js");
const plugin = new ReplicaPlugin();
assert.strictEqual(typeof ReplicaPlugin, "function");
assert.strictEqual(typeof plugin.prepareVideo, "function");
assert.strictEqual(typeof plugin.runGeneration, "function");
assert.strictEqual(typeof plugin.waitForVideo, "function");

(async () => {
  const realVault = path.resolve(__dirname, "../../..");
  plugin.app = { vault: { adapter: { getBasePath: () => realVault }, on: () => ({}) } };
  plugin.manifest = { dir: "plugins/mangosteen-video-replica" };
  plugin.addRibbonIcon = plugin.addCommand = plugin.registerInterval = plugin.registerEvent = () => {};
  global.window = { setInterval: () => 1, setTimeout: () => 1 };
  await plugin.onload();

  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-replica-plugin-"));
  const project = path.join(vault, "山竹视频复刻", "失败任务");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "generation-request.json"), JSON.stringify({ confirmed: false }));
  fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ folder: "山竹视频复刻/失败任务", shots: [] }));
  plugin.app = { vault: { adapter: { getBasePath: () => vault } } };
  plugin.processing = new Set();

  const blockedFolder = "山竹视频复刻/模型预检";
  const blockedProject = path.join(vault, ...blockedFolder.split("/"));
  fs.mkdirSync(blockedProject, { recursive: true });
  fs.writeFileSync(path.join(blockedProject, "project.json"), JSON.stringify({ folder: blockedFolder, title: "模型预检", frames: [], shots: [] }));
  const blockedCases = [
    { name: "Kling", model: "KlingO3", accountModels: ["KlingO3", "MiniMax-H3"] },
    { name: "Wan", model: "wan3.0-video-prime", accountModels: ["wan3.0-video-prime", "seedance-2.5"] },
    { name: "unknown", model: "future-video-model", accountModels: ["future-video-model", "MiniMax-H3"] },
    { name: "supported but unavailable", model: "MiniMax-H3", accountModels: ["seedance-2.5"] },
  ];
  for (const testCase of blockedCases) {
    const calls = { generateText: 0, generateEdit: 0, generateEditMulti: 0, submitVideo: 0 };
    const blockedImage = {
      generateText: async () => { calls.generateText += 1; return {}; },
      generateEdit: async () => { calls.generateEdit += 1; return {}; },
      generateEditMulti: async () => { calls.generateEditMulti += 1; return {}; },
      extractResults: () => [{ kind: "base64", value: Buffer.from("image").toString("base64") }],
    };
    const blockedVideo = {
      settings: { model: testCase.model, resolution: "720p" },
      refreshAgentAccess: async () => ({
        videoModelKeys: Object.fromEntries(testCase.accountModels.map((model) => [model, "test-key"])),
      }),
      submitVideo: async () => { calls.submitVideo += 1; throw new Error("paid video operation reached"); },
    };
    plugin.getGenerationPlugins = () => ({ image: blockedImage, video: blockedVideo });
    await assert.rejects(() => plugin.runGeneration(blockedFolder, {
      character: { prompt: "人物三视图" },
      settings: { ratio: "9:16", resolution: "720p", videoModel: testCase.model },
      shots: [{ id: 1, title: "开场", duration: 5, imagePrompt: "人物站立", videoPrompt: "人物向前走" }],
    }, 123), /视频复刻不能使用模型/, testCase.name);
    assert.deepStrictEqual(calls, {
      generateText: 0,
      generateEdit: 0,
      generateEditMulti: 0,
      submitVideo: 0,
    }, testCase.name);
  }

  const requestPath = path.join(project, "generation-request.json");
  await plugin.processRequest(requestPath);
  const state = JSON.parse(fs.readFileSync(path.join(project, ".work/generation-state.json"), "utf8"));
  assert.strictEqual(state.status, "failed");
  assert.strictEqual(state.requestMtimeMs, fs.statSync(requestPath).mtimeMs);
  assert.strictEqual(plugin.requestAlreadyHandled("山竹视频复刻/失败任务", state.requestMtimeMs), true);

  const generatedFolder = "山竹视频复刻/模拟生成";
  const generated = path.join(vault, ...generatedFolder.split("/"));
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(path.join(vault, "山竹视频"), { recursive: true });
  fs.writeFileSync(path.join(generated, "project.json"), JSON.stringify({ folder: generatedFolder, title: "模拟生成", frames: [], shots: [] }));
  fs.writeFileSync(path.join(vault, "山竹视频/mock.mp4"), "video");
  const image = {
    generateText: async () => ({}),
    generateEdit: async () => ({}),
    extractResults: () => [{ kind: "base64", value: Buffer.from("image").toString("base64") }],
  };
  let submittedOptions;
  const video = {
    settings: { model: "seedance-2.5", resolution: "720p" },
    refreshAgentAccess: async () => ({ videoModelKeys: { "seedance-2.5": "secret-not-read-by-replica" } }),
    submitVideo: async (options) => { submittedOptions = options; return { id: "task-1" }; },
  };
  plugin.getGenerationPlugins = () => ({ image, video });
  plugin.waitForVideo = async () => ({ localPath: "山竹视频/mock.mp4" });
  plugin.openVaultPath = async () => true;
  await plugin.runGeneration(generatedFolder, {
    character: { prompt: "人物三视图" },
    settings: { ratio: "9:16", resolution: "720p", videoModel: "seedance-2.5" },
    shots: [{ id: 1, title: "开场", duration: 5, imagePrompt: "人物站立", videoPrompt: "人物向前走" }],
  }, 123);
  const completed = JSON.parse(fs.readFileSync(path.join(generated, "project.json"), "utf8"));
  assert.strictEqual(completed.status, "completed");
  assert(fs.existsSync(path.join(generated, "01-人物参考/人物三视图.png")));
  assert(fs.existsSync(path.join(generated, "02-分镜脚本/镜头-1-开场.png")));
  assert(fs.existsSync(path.join(generated, "03-视频片段/镜头-1-开场.mp4")));
  assert.deepStrictEqual(submittedOptions.referenceImageFiles.map((file) => file.name), ["镜头-1-开场.png"]);
  assert.strictEqual(Object.hasOwn(submittedOptions, "firstImageFile"), false);

  fs.rmSync(vault, { recursive: true, force: true });
  delete global.window;
  Module._load = originalLoad;
  console.log("plugin-load: ok");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
