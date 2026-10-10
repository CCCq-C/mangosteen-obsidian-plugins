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
  const video = { settings: { model: "mock", resolution: "720p" }, submitVideo: async () => ({ id: "task-1" }) };
  plugin.getGenerationPlugins = () => ({ image, video });
  plugin.waitForVideo = async () => ({ localPath: "山竹视频/mock.mp4" });
  plugin.openVaultPath = async () => true;
  await plugin.runGeneration(generatedFolder, {
    character: { prompt: "人物三视图" },
    settings: { ratio: "9:16", resolution: "720p", videoModel: "mock" },
    shots: [{ id: 1, title: "开场", duration: 5, imagePrompt: "人物站立", videoPrompt: "人物向前走" }],
  }, 123);
  const completed = JSON.parse(fs.readFileSync(path.join(generated, "project.json"), "utf8"));
  assert.strictEqual(completed.status, "completed");
  assert(fs.existsSync(path.join(generated, "01-人物参考/人物三视图.png")));
  assert(fs.existsSync(path.join(generated, "02-分镜脚本/镜头-1-开场.png")));
  assert(fs.existsSync(path.join(generated, "03-视频片段/镜头-1-开场.mp4")));

  fs.rmSync(vault, { recursive: true, force: true });
  delete global.window;
  Module._load = originalLoad;
  console.log("plugin-load: ok");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
