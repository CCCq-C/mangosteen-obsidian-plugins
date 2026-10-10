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

  async function runMockEndToEnd(model, family) {
    const caseVault = fs.mkdtempSync(path.join(os.tmpdir(), `mangosteen-replica-e2e-${family}-`));
    const projectFolder = "山竹视频复刻/双镜头端到端";
    const projectRoot = path.join(caseVault, ...projectFolder.split("/"));
    const videoRoot = path.join(caseVault, "山竹视频");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(videoRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "project.json"), JSON.stringify({
      folder: projectFolder,
      title: "双镜头端到端",
      frames: [],
      shots: [],
    }));

    const request = {
      version: 2,
      confirmed: true,
      character: { id: "hero", prompt: "固定人物参考板" },
      scenes: [{ id: "studio", prompt: "固定摄影棚场景" }],
      settings: { ratio: "9:16", resolution: "720p", videoModel: model },
      shots: [
        { title: "入场", sceneId: "studio", duration: 4, imagePrompt: "人物走入摄影棚", videoPrompt: "人物向前走" },
        { title: "定格", sceneId: "studio", duration: 4, imagePrompt: "人物转身", lastImagePrompt: "人物停在灯光下", videoPrompt: "镜头缓慢推进" },
      ],
    };
    const requestPath = path.join(projectRoot, "generation-request.json");
    fs.writeFileSync(requestPath, JSON.stringify(request));

    const generatedTextPrompts = [];
    const submittedOptions = [];
    const image = {
      generateText: async (prompt) => {
        generatedTextPrompts.push(prompt);
        return { candidate: { kind: "base64", value: Buffer.from(`asset:${prompt}`).toString("base64") } };
      },
      generateEdit: async () => { throw new Error("version 2 must use generateEditMulti"); },
      generateEditMulti: async (prompt) => ({
        candidate: { kind: "base64", value: Buffer.from(`keyframe:${prompt}`).toString("base64") },
      }),
      extractResults: (response) => response?.candidate ? [response.candidate] : [],
    };
    const video = {
      settings: { model, resolution: "720p" },
      refreshAgentAccess: async () => ({ videoModelKeys: { [model]: "mock-key-never-used" } }),
      submitVideo: async (options) => {
        submittedOptions.push(options);
        const id = `mock-video-${submittedOptions.length}`;
        fs.writeFileSync(path.join(videoRoot, `${id}.mp4`), `video:${id}`);
        return { id };
      },
    };

    plugin.app = { vault: { adapter: { getBasePath: () => caseVault } } };
    plugin.processing = new Set();
    plugin.referenceAssetPromises = new Map();
    plugin.getGenerationPlugins = () => ({ image, video });
    plugin.waitForVideo = async (_video, taskId) => ({ localPath: `山竹视频/${taskId}.mp4` });
    plugin.openVaultPath = async () => true;

    try {
      await plugin.processRequest(requestPath);
      const completed = JSON.parse(fs.readFileSync(path.join(projectRoot, "project.json"), "utf8"));
      const completedState = JSON.parse(fs.readFileSync(path.join(projectRoot, ".work/generation-state.json"), "utf8"));
      assert.strictEqual(completedState.status, "completed", `${family}: mock workflow must complete`);
      assert.strictEqual(completed.status, "completed", `${family}: project must be retained as completed`);
      assert.strictEqual(completed.characterAsset.id, "hero", `${family}: one character asset must be retained`);
      assert(fs.existsSync(path.join(caseVault, ...completed.characterAsset.imagePath.split("/"))), `${family}: character asset file must exist`);
      assert.strictEqual(completed.sceneAssets.length, 1, `${family}: one scene asset must be retained`);
      assert(fs.existsSync(path.join(caseVault, ...completed.sceneAssets[0].imagePath.split("/"))), `${family}: scene asset file must exist`);
      assert.deepStrictEqual(generatedTextPrompts, ["固定人物参考板", "固定摄影棚场景"], `${family}: exactly one character and one scene asset must be generated`);

      assert.strictEqual(completed.shots.length, 2, `${family}: two shots must be retained`);
      assert(completed.shots.every((shot) => shot.firstImagePath && fs.existsSync(path.join(caseVault, ...shot.firstImagePath.split("/")))), `${family}: both shot first keyframes must be retained`);
      assert.strictEqual(completed.shots[0].lastImagePath, "", `${family}: first shot must not invent a last keyframe`);
      assert(completed.shots[1].lastImagePath && fs.existsSync(path.join(caseVault, ...completed.shots[1].lastImagePath.split("/"))), `${family}: optional last keyframe must be retained`);
      assert(completed.shots.every((shot) => shot.videoPath && fs.existsSync(path.join(caseVault, ...shot.videoPath.split("/")))), `${family}: two video files must be retained`);
      assert.deepStrictEqual(completed.shots.map((shot) => fs.readFileSync(path.join(caseVault, ...shot.videoPath.split("/")), "utf8")), [
        "video:mock-video-1",
        "video:mock-video-2",
      ], `${family}: retained videos must match both mock tasks`);

      assert.strictEqual(submittedOptions.length, 2, `${family}: both shots must submit video calls`);
      if (family === "minimax-h3") {
        assert(submittedOptions.every((options) => options.firstImageFile?.buffer), "MiniMax-H3: every call must contain a local first frame");
        assert.strictEqual(Object.hasOwn(submittedOptions[0], "lastImageFile"), false, "MiniMax-H3: last frame must stay optional");
        assert(submittedOptions[1].lastImageFile?.buffer, "MiniMax-H3: second call must contain its local last frame");
        assert(submittedOptions.every((options) => !Object.hasOwn(options, "referenceImageFiles")), "MiniMax-H3: reference image arrays must not be sent");
      } else {
        assert(submittedOptions.every((options) => !Object.hasOwn(options, "firstImageFile") && !Object.hasOwn(options, "lastImageFile")), "Seedance: first/last frame fields must not be sent");
        assert.deepStrictEqual(submittedOptions.map((options) => options.referenceImageFiles.map((file) => file.name)), [
          ["镜头-001-入场-首帧.png"],
          ["镜头-002-定格-首帧.png", "镜头-002-定格-尾帧.png"],
        ], "Seedance: only local reference image files must be sent");
        assert(submittedOptions.every((options) => options.referenceImageFiles.every((file) => Buffer.isBuffer(file.buffer))), "Seedance: every reference must contain local file bytes");
      }
    } finally {
      fs.rmSync(caseVault, { recursive: true, force: true });
    }
  }

  await runMockEndToEnd("MiniMax-H3", "minimax-h3");
  await runMockEndToEnd("seedance-2.5", "seedance");
  plugin.app = { vault: { adapter: { getBasePath: () => vault } } };
  plugin.processing = new Set();
  plugin.referenceAssetPromises = new Map();

  const generatedFolder = "山竹视频复刻/模拟生成";
  const generated = path.join(vault, ...generatedFolder.split("/"));
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(path.join(vault, "山竹视频"), { recursive: true });
  fs.writeFileSync(path.join(generated, "project.json"), JSON.stringify({ folder: generatedFolder, title: "模拟生成", frames: [], shots: [] }));
  fs.writeFileSync(path.join(vault, "山竹视频/mock.mp4"), "video");
  const image = {
    generateText: async () => ({}),
    generateEdit: async () => ({}),
    generateEditMulti: async () => { throw new Error("version 1 must not require multi-image editing"); },
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

  const generatedV2Folder = "山竹视频复刻/资产生成";
  const generatedV2 = path.join(vault, ...generatedV2Folder.split("/"));
  const sourceFramePath = `${generatedV2Folder}/02-分镜脚本/原片画面-001.jpg`;
  fs.mkdirSync(path.dirname(path.join(vault, ...sourceFramePath.split("/"))), { recursive: true });
  fs.writeFileSync(path.join(vault, ...sourceFramePath.split("/")), "source-frame-must-not-be-used");
  fs.writeFileSync(path.join(generatedV2, "project.json"), JSON.stringify({
    folder: generatedV2Folder,
    title: "资产生成",
    frames: [{ index: 1, timestamp: 0, path: sourceFramePath }],
    shots: [],
  }));

  const harborImagePath = path.join(vault, "山竹视频资产库", "场景", "harbor", "场景参考图.png");
  fs.mkdirSync(path.dirname(harborImagePath), { recursive: true });
  fs.writeFileSync(harborImagePath, "existing-harbor-scene");

  const generatedTextPrompts = [];
  const editCalls = [];
  const imageV2 = {
    generateText: async (prompt) => {
      generatedTextPrompts.push(prompt);
      return { candidate: { kind: "base64", value: Buffer.from(`text:${prompt}`).toString("base64") } };
    },
    generateEdit: async () => { throw new Error("version 2 must use generateEditMulti"); },
    generateEditMulti: async (prompt, images) => {
      editCalls.push({
        prompt,
        references: images.map((file) => file.buffer.toString()),
      });
      return { candidate: { kind: "base64", value: Buffer.from(`edit:${prompt}`).toString("base64") } };
    },
    extractResults: (response) => response?.candidate ? [response.candidate] : [],
  };
  const submittedV2Options = [];
  const videoV2 = {
    settings: { model: "seedance-2.5", resolution: "720p" },
    refreshAgentAccess: async () => ({ videoModelKeys: { "seedance-2.5": "secret-not-read-by-replica" } }),
    submitVideo: async (options) => {
      submittedV2Options.push(options);
      return { id: `task-v2-${submittedV2Options.length}` };
    },
  };
  plugin.getGenerationPlugins = () => ({ image: imageV2, video: videoV2 });
  plugin.waitForVideo = async () => ({ localPath: "山竹视频/mock.mp4" });
  const requestV2 = {
    version: 2,
    confirmed: true,
    character: { id: "hero", prompt: "固定人物参考板" },
    scenes: [
      { id: "harbor", prompt: "海边集装箱场景" },
      { id: "studio", prompt: "摄影棚场景" },
    ],
    settings: { ratio: "9:16", resolution: "720p", videoModel: "seedance-2.5" },
    shots: [
      { id: "001", title: "港口", sceneId: "harbor", duration: 4, imagePrompt: "人物走在港口", videoPrompt: "人物向前走" },
      { id: "002", title: "摄影棚", sceneId: "studio", duration: 4, imagePrompt: "人物走入摄影棚", lastImagePrompt: "人物停在灯光下", videoPrompt: "镜头缓慢推进" },
    ],
  };
  await plugin.runGeneration(generatedV2Folder, requestV2, 456);

  assert.deepStrictEqual(generatedTextPrompts, ["固定人物参考板", "摄影棚场景"]);
  assert.deepStrictEqual(editCalls, [
    {
      prompt: "人物走在港口\n保持参考人物的脸部、发型、服装和年龄一致，并保持场景一致。",
      references: ["text:固定人物参考板", "existing-harbor-scene"],
    },
    {
      prompt: "人物走入摄影棚\n保持参考人物的脸部、发型、服装和年龄一致，并保持场景一致。",
      references: ["text:固定人物参考板", "text:摄影棚场景"],
    },
    {
      prompt: "人物停在灯光下\n保持参考人物的脸部、发型、服装和年龄一致，并保持场景一致。",
      references: ["text:固定人物参考板", "text:摄影棚场景"],
    },
  ]);
  assert(editCalls.every((call) => !call.references.includes("source-frame-must-not-be-used")));
  assert.deepStrictEqual(submittedV2Options.map((options) => options.referenceImageFiles.map((file) => file.name)), [
    ["镜头-001-港口-首帧.png"],
    ["镜头-002-摄影棚-首帧.png", "镜头-002-摄影棚-尾帧.png"],
  ]);

  const completedV2 = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  assert.strictEqual(completedV2.status, "completed");
  assert.strictEqual(completedV2.videoModel, "seedance-2.5");
  assert.strictEqual(completedV2.characterAsset.imagePath, "山竹视频资产库/人物/hero/人物参考板.png");
  assert.deepStrictEqual(completedV2.sceneAssets.map((asset) => asset.imagePath), [
    "山竹视频资产库/场景/harbor/场景参考图.png",
    "山竹视频资产库/场景/studio/场景参考图.png",
  ]);
  assert.strictEqual(completedV2.shots[0].lastImagePath, "");
  assert.strictEqual(completedV2.shots[1].lastImagePath, `${generatedV2Folder}/02-分镜脚本/镜头-002-摄影棚-尾帧.png`);
  assert(fs.existsSync(path.join(vault, "山竹视频资产库", "人物", "hero", "metadata.json")));
  assert(fs.existsSync(path.join(vault, "山竹视频资产库", "场景", "studio", "metadata.json")));

  const dashboardV2 = fs.readFileSync(path.join(generatedV2, "00-项目总览.md"), "utf8");
  assert.match(dashboardV2, /模型：`seedance-2\.5`/);
  assert.match(dashboardV2, /山竹视频资产库\/人物\/hero\/人物参考板\.png/);
  assert.match(dashboardV2, /山竹视频资产库\/场景\/harbor\/场景参考图\.png/);
  assert.match(dashboardV2, /镜头-001-港口-首帧\.png/);
  assert.match(dashboardV2, /镜头-002-摄影棚-尾帧\.png/);
  assert.match(dashboardV2, /镜头-002-摄影棚\.mp4/);

  await plugin.runGeneration(generatedV2Folder, requestV2, 457);
  assert.deepStrictEqual(generatedTextPrompts, ["固定人物参考板", "摄影棚场景"], "existing assets must be reused");

  const concurrentFolders = ["山竹视频复刻/并发任务一", "山竹视频复刻/并发任务二"];
  for (const folder of concurrentFolders) {
    const absoluteFolder = path.join(vault, ...folder.split("/"));
    fs.mkdirSync(absoluteFolder, { recursive: true });
    fs.writeFileSync(path.join(absoluteFolder, "project.json"), JSON.stringify({ folder, title: folder.split("/").pop(), frames: [], shots: [] }));
  }
  const concurrentPrompts = { "并发人物参考板": 0, "并发场景参考图": 0 };
  let releaseCharacter;
  let releaseScene;
  let markCharacterStarted;
  let markSceneStarted;
  const characterGate = new Promise((resolve) => { releaseCharacter = resolve; });
  const sceneGate = new Promise((resolve) => { releaseScene = resolve; });
  const characterStarted = new Promise((resolve) => { markCharacterStarted = resolve; });
  const sceneStarted = new Promise((resolve) => { markSceneStarted = resolve; });
  const concurrentImage = {
    generateText: async (prompt) => {
      concurrentPrompts[prompt] += 1;
      const count = concurrentPrompts[prompt];
      if (prompt === "并发人物参考板" && count === 1) {
        markCharacterStarted();
        await characterGate;
      }
      if (prompt === "并发场景参考图" && count === 1) {
        markSceneStarted();
        await sceneGate;
      }
      return { candidate: { kind: "base64", value: Buffer.from(`concurrent:${prompt}`).toString("base64") } };
    },
    generateEdit: async () => { throw new Error("version 2 must use generateEditMulti"); },
    generateEditMulti: async (prompt) => ({ candidate: { kind: "base64", value: Buffer.from(`frame:${prompt}`).toString("base64") } }),
    extractResults: (response) => response?.candidate ? [response.candidate] : [],
  };
  const concurrentVideo = {
    settings: { model: "seedance-2.5", resolution: "720p" },
    refreshAgentAccess: async () => ({ videoModelKeys: { "seedance-2.5": "secret-not-read-by-replica" } }),
    submitVideo: async () => ({ id: "concurrent-video" }),
  };
  const concurrentRequest = {
    version: 2,
    confirmed: true,
    character: { id: "concurrent-hero", prompt: "并发人物参考板" },
    scenes: [{ id: "concurrent-scene", prompt: "并发场景参考图" }],
    settings: { ratio: "9:16", resolution: "720p", videoModel: "seedance-2.5" },
    shots: [{ id: "001", title: "并发镜头", sceneId: "concurrent-scene", duration: 4, imagePrompt: "并发首帧", videoPrompt: "并发视频" }],
  };
  plugin.getGenerationPlugins = () => ({ image: concurrentImage, video: concurrentVideo });
  const firstConcurrentRun = plugin.runGeneration(concurrentFolders[0], concurrentRequest, 501);
  await characterStarted;
  const secondConcurrentRun = plugin.runGeneration(concurrentFolders[1], concurrentRequest, 502);
  await new Promise((resolve) => setImmediate(resolve));
  releaseCharacter();
  await sceneStarted;
  await new Promise((resolve) => setImmediate(resolve));
  releaseScene();
  await Promise.all([firstConcurrentRun, secondConcurrentRun]);
  assert.deepStrictEqual(concurrentPrompts, {
    "并发人物参考板": 1,
    "并发场景参考图": 1,
  }, "concurrent requests must share one paid generation per missing asset");

  const escapedMediaOutside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-escaped-media-"));
  const escapedMediaFolder = path.join(vault, "山竹视频资产库", "人物", "escaped-media");
  fs.symlinkSync(escapedMediaOutside, escapedMediaFolder, "dir");
  const escapedMediaVaultPath = "山竹视频资产库/人物/escaped-media/人物参考板.png";
  const escapedMediaOutsidePath = path.join(escapedMediaOutside, "人物参考板.png");
  fs.writeFileSync(escapedMediaOutsidePath, "outside-image-must-stay");
  assert.throws(
    () => plugin.localImage(escapedMediaVaultPath),
    /资产路径.*知识库范围/,
    "asset image reads must reject symlink escape",
  );
  await assert.rejects(
    () => plugin.saveImageCandidate(imageV2, { kind: "base64", value: Buffer.from("overwrite").toString("base64") }, escapedMediaVaultPath),
    /资产路径.*知识库范围/,
    "asset image writes must reject symlink escape",
  );
  assert.strictEqual(fs.readFileSync(escapedMediaOutsidePath, "utf8"), "outside-image-must-stay");

  const failedV2Folder = "山竹视频复刻/版本2失败持久化";
  const failedV2 = path.join(vault, ...failedV2Folder.split("/"));
  fs.mkdirSync(failedV2, { recursive: true });
  fs.writeFileSync(path.join(failedV2, "project.json"), JSON.stringify({ folder: failedV2Folder, title: "版本2失败持久化", frames: [], shots: [] }));
  const failedV2RequestPath = path.join(failedV2, "generation-request.json");
  fs.writeFileSync(failedV2RequestPath, JSON.stringify({
    version: 2,
    confirmed: true,
    character: { id: "failure-hero", prompt: "失败人物" },
    scenes: [{ id: "failure-scene", prompt: "失败场景" }],
    settings: { ratio: "9:16", resolution: "720p", videoModel: "seedance-2.5" },
    shots: [{ title: "失败镜头", sceneId: "failure-scene", duration: 4, imagePrompt: "失败首帧", videoPrompt: "失败视频" }],
  }));
  plugin.getGenerationPlugins = () => ({
    image: {
      generateText: async () => { throw new Error("v2 paid image failed"); },
      generateEdit: async () => ({}),
      generateEditMulti: async () => ({}),
      extractResults: () => [],
    },
    video: concurrentVideo,
  });
  await plugin.processRequest(failedV2RequestPath);
  const failedV2State = JSON.parse(fs.readFileSync(path.join(failedV2, ".work/generation-state.json"), "utf8"));
  const failedV2Project = JSON.parse(fs.readFileSync(path.join(failedV2, "project.json"), "utf8"));
  assert.strictEqual(failedV2State.status, "failed");
  assert.strictEqual(failedV2State.requestMtimeMs, fs.statSync(failedV2RequestPath).mtimeMs);
  assert.match(failedV2State.error, /v2 paid image failed/);
  assert.strictEqual(failedV2Project.status, "failed");
  assert.match(failedV2Project.statusText, /v2 paid image failed/);
  assert.strictEqual(plugin.requestAlreadyHandled(failedV2Folder, failedV2State.requestMtimeMs), true);

  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(escapedMediaOutside, { recursive: true, force: true });
  delete global.window;
  Module._load = originalLoad;
  console.log("plugin-load: ok");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
