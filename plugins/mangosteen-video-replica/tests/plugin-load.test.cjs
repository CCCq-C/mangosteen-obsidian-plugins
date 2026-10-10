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
assert.strictEqual(typeof plugin.analyzeLatestProject, "function");
assert.strictEqual(typeof plugin.confirmLatestGeneration, "function");
assert.strictEqual(typeof plugin.concatProject, "function");
assert.strictEqual(typeof plugin.runGeneration, "function");
assert.strictEqual(typeof plugin.waitForVideo, "function");

(async () => {
  const realVault = path.resolve(__dirname, "../../..");
  plugin.app = { vault: { adapter: { getBasePath: () => realVault }, on: () => ({}) } };
  plugin.manifest = { dir: "plugins/mangosteen-video-replica" };
  const commandIds = [];
  plugin.addRibbonIcon = plugin.registerInterval = plugin.registerEvent = () => {};
  plugin.addCommand = (command) => { commandIds.push(command.id); };
  global.window = { setInterval: () => 1, setTimeout: () => 1 };
  await plugin.onload();
  assert(commandIds.includes("analyze-latest-project"));
  assert(commandIds.includes("select-analysis-model"));
  assert(commandIds.includes("select-generation-models"));
  assert(commandIds.includes("confirm-latest-generation"));
  assert(commandIds.includes("concat-latest-project"));
  plugin.app.plugins = { getPlugin: (id) => id === "mangosteen-image"
    ? { settings: { model: "gpt-image-2-w" } }
    : { settings: { model: "MiniMax-H3", resolution: "720p" } } };
  assert.deepStrictEqual(plugin.analysisSettings(), { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3", resolution: "768p" });

  const catalogImage = { settings: { model: "gpt-image-2-w" }, refreshAgentAccess: async () => ({ imageModelKeys: { "gpt-image-2-w": "key", "gpt-image-2-adobe": "key" } }) };
  const catalogVideo = { settings: { model: "MiniMax-H3", resolution: "768p" }, refreshAgentAccess: async () => ({ videoModelKeys: { "MiniMax-H3": "key", "seedance-2.5": "key" } }) };
  plugin.app.plugins = { getPlugin: (id) => id === "mangosteen-image" ? catalogImage : id === "mangosteen-video" ? catalogVideo : null };
  const generationCatalog = await plugin.refreshGenerationModelCatalog();
  assert.deepStrictEqual(generationCatalog.imageModels, ["gpt-image-2-w", "gpt-image-2-adobe"]);
  assert.deepStrictEqual(generationCatalog.videoModels, ["MiniMax-H3", "seedance-2.5"]);
  const generationImage = (overrides = {}) => ({
    settings: { model: "gpt-image-2-w" },
    refreshAgentAccess: async () => ({ imageModelKeys: { "gpt-image-2-w": "test-key" } }),
    ...overrides,
  });

  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-replica-plugin-"));
  const project = path.join(vault, "山竹视频复刻", "失败任务");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "generation-request.json"), JSON.stringify({ confirmed: false }));
  fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ folder: "山竹视频复刻/失败任务", shots: [] }));
  plugin.app = { vault: { adapter: { getBasePath: () => vault } } };
  plugin.processing = new Set();

  const analysisFolder = "山竹视频复刻/山竹模型分析";
  const analysisRoot = path.join(vault, ...analysisFolder.split("/"));
  fs.mkdirSync(path.join(analysisRoot, "02-分镜脚本"), { recursive: true });
  const analysisFrames = [1, 2].map((index) => {
    const framePath = `${analysisFolder}/02-分镜脚本/原片画面-${String(index).padStart(3, "0")}.jpg`;
    fs.writeFileSync(path.join(vault, ...framePath.split("/")), `frame-${index}`);
    return { index, timestamp: index - 1, path: framePath };
  });
  fs.writeFileSync(path.join(analysisRoot, "project.json"), JSON.stringify({
    folder: analysisFolder, title: "山竹模型分析", duration: 8, width: 1080, height: 1920,
    frames: analysisFrames, shots: [], transcriptPath: `${analysisFolder}/02-分镜脚本/台词转写.md`,
    storyboardPath: `${analysisFolder}/02-分镜脚本/分镜脚本.md`, status: "prepared",
  }));
  fs.writeFileSync(path.join(analysisRoot, "02-分镜脚本/台词转写.md"), "# 台词转写\n\n- 00:00 你好\n");
  const structuredCalls = [];
  const agentResult = { data: {
    character: { id: "hero", prompt: "短黑发人物三视图，固定五官和服装。" },
    scenes: [{ id: "studio", prompt: "明亮摄影棚，固定白色背景和柔光灯。" }],
    shots: [{
      title: "打招呼", sceneId: "studio", startTime: 0, endTime: 4,
      dialogue: "你好", plot: "人物抬手打招呼", environment: "摄影棚", camera: "中景固定",
      imagePrompt: "人物面对镜头抬手。", lastImagePrompt: "人物放下手。", videoPrompt: "人物自然挥手后放下。",
    }],
  }, model: "山竹当前模型" };
  const agent = {
    getLanguageModelCatalog: () => ({
      ready: true,
      activeGroup: "default",
      activeModel: "fallback-model",
      groups: [
        { id: "default", label: "默认", ratio: 1, models: ["fallback-model"] },
        { id: "gpt_plus", label: "GPT", ratio: 1, models: ["gpt-5.6-sol", "gpt-5.6-terra"] },
      ],
    }),
    analyzeStructured: async (options) => {
      structuredCalls.push(options);
      return agentResult;
    },
  };
  plugin.app.plugins = { getPlugin: (id) => id === "mangosteen-agent" ? agent : id === "mangosteen-video" ? { settings: { model: "MiniMax-H3", resolution: "768p" } } : null };
  plugin.settings = { analysisGroup: "gpt_plus", analysisModel: "gpt-5.6-sol" };
  plugin.openVaultPath = async () => true;
  const analyzedByAgent = await plugin.analyzeProject(analysisFolder);
  assert.strictEqual(structuredCalls.length, 1, "analysis must call the Mangosteen Agent exactly once");
  assert.strictEqual(structuredCalls[0].images.length, 2, "analysis must pass sampled local frames to the Mangosteen Agent");
  assert.strictEqual(structuredCalls[0].schemaName, "video_replica_analysis");
  assert.strictEqual(structuredCalls[0].group, "gpt_plus");
  assert.strictEqual(structuredCalls[0].model, "gpt-5.6-sol");
  assert.match(structuredCalls[0].prompt, /你好/, "analysis must include the local Whisper transcript in the model prompt");
  assert.strictEqual(analyzedByAgent.request.confirmed, false);
  assert.strictEqual(analyzedByAgent.project.analysisProvider, "mangosteen-agent");
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(analysisRoot, ".work/last-agent-response.json"), "utf8")),
    agentResult.data,
    "the latest model response must be retained for diagnosis",
  );

  const unavailableModel = Object.assign(new Error("模型路由不存在"), {
    code: "REMOTE_REJECTED",
    status: 404,
    changeModel: true,
  });
  plugin.app.plugins = { getPlugin: (id) => id === "mangosteen-agent"
    ? { getLanguageModelCatalog: agent.getLanguageModelCatalog, analyzeStructured: async () => { throw unavailableModel; } }
    : id === "mangosteen-video" ? { settings: { model: "MiniMax-H3", resolution: "768p" } } : null };
  await assert.rejects(() => plugin.analyzeProject(analysisFolder), /请更换分析模型后重试/);
  const modelErrorProject = JSON.parse(fs.readFileSync(path.join(analysisRoot, "project.json"), "utf8"));
  assert.strictEqual(modelErrorProject.status, "analysis_model_error");
  assert.strictEqual(modelErrorProject.analysisErrorCode, "REMOTE_REJECTED");
  assert.match(modelErrorProject.statusText, /gpt-5\.6-sol.*请更换分析模型/);
  plugin.app.plugins = { getPlugin: (id) => id === "mangosteen-agent" ? agent : id === "mangosteen-video" ? { settings: { model: "MiniMax-H3", resolution: "768p" } } : null };

  plugin.concatProject = async (value) => {
    const output = `${value.folder}/04-最终成片/最终成片.mp4`;
    const absolute = path.join(plugin.vaultPath(), ...output.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "joined-video");
    return output;
  };

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
    const blockedImage = generationImage({
      generateText: async () => { calls.generateText += 1; return {}; },
      generateEdit: async () => { calls.generateEdit += 1; return {}; },
      generateEditMulti: async () => { calls.generateEditMulti += 1; return {}; },
      extractResults: () => [{ kind: "base64", value: Buffer.from("image").toString("base64") }],
    });
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
    }, 123), /视频模型.*不可用/, testCase.name);
    assert.deepStrictEqual(calls, {
      generateText: 0,
      generateEdit: 0,
      generateEditMulti: 0,
      submitVideo: 0,
    }, testCase.name);
  }

  const requestPath = path.join(project, "generation-request.json");
  await plugin.processRequest(requestPath);
  assert.strictEqual(fs.existsSync(path.join(project, ".work/generation-state.json")), false, "an unconfirmed draft must stay idle and must not be marked failed");

  const leaseFolder = "山竹视频复刻/租约恢复";
  const leaseRoot = path.join(vault, ...leaseFolder.split("/"));
  fs.mkdirSync(path.join(leaseRoot, ".work"), { recursive: true });
  plugin.instanceId = "instance-current";
  const requestMtimeMs = 789;
  const now = Date.now();
  const writeLease = (value) => fs.writeFileSync(path.join(leaseRoot, ".work/generation-state.json"), JSON.stringify(value));
  writeLease({
    status: "processing", requestMtimeMs, instanceId: plugin.instanceId,
    leaseStartedAt: new Date(now - 1000).toISOString(), leaseUpdatedAt: new Date(now).toISOString(), leaseExpiresAt: new Date(now + 60000).toISOString(),
  });
  assert.strictEqual(plugin.requestAlreadyHandled(leaseFolder, requestMtimeMs, now), true, "fresh same-instance lease must skip duplicate scans");
  writeLease({
    status: "processing", requestMtimeMs, instanceId: "instance-before-restart",
    leaseStartedAt: new Date(now - 120000).toISOString(), leaseUpdatedAt: new Date(now - 120000).toISOString(), leaseExpiresAt: new Date(now - 60000).toISOString(),
  });
  assert.strictEqual(plugin.requestAlreadyHandled(leaseFolder, requestMtimeMs, now), false, "expired foreign lease must resume after restart");
  writeLease({ status: "processing", requestMtimeMs, updatedAt: new Date(now - 120000).toISOString() });
  assert.strictEqual(plugin.requestAlreadyHandled(leaseFolder, requestMtimeMs, now), false, "legacy processing state without a lease must resume");

  async function runMockEndToEnd({ model, family, resolution }) {
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
      settings: { ratio: "9:16", resolution, videoModel: model },
      shots: [
        { title: "入场", sceneId: "studio", duration: 4, imagePrompt: "人物走入摄影棚", videoPrompt: "人物向前走" },
        { title: "定格", sceneId: "studio", duration: 4, imagePrompt: "人物转身", lastImagePrompt: "人物停在灯光下", videoPrompt: "镜头缓慢推进" },
      ],
    };
    const requestPath = path.join(projectRoot, "generation-request.json");
    fs.writeFileSync(requestPath, JSON.stringify(request));

    const generatedTextPrompts = [];
    const generatedImageModels = [];
    const submittedOptions = [];
    const image = generationImage({
      generateText: async (prompt, _count, _slot, options) => {
        generatedTextPrompts.push(prompt);
        generatedImageModels.push(options?.model);
        return { candidate: { kind: "base64", value: Buffer.from(`asset:${prompt}`).toString("base64") } };
      },
      generateEdit: async () => { throw new Error("version 2 must use generateEditMulti"); },
      generateEditMulti: async (prompt, _images, _slot, options) => {
        generatedImageModels.push(options?.model);
        return { candidate: { kind: "base64", value: Buffer.from(`keyframe:${prompt}`).toString("base64") } };
      },
      extractResults: (response) => response?.candidate ? [response.candidate] : [],
    });
    const video = {
      settings: { model, resolution },
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
      assert.strictEqual(completed.finalVideoPath, `${projectFolder}/04-最终成片/最终成片.mp4`, `${family}: completed clips must be joined automatically`);
      assert.strictEqual(completed.characterAsset.id, "hero", `${family}: one character asset must be retained`);
      assert(fs.existsSync(path.join(caseVault, ...completed.characterAsset.imagePath.split("/"))), `${family}: character asset file must exist`);
      assert.strictEqual(completed.sceneAssets.length, 1, `${family}: one scene asset must be retained`);
      assert(fs.existsSync(path.join(caseVault, ...completed.sceneAssets[0].imagePath.split("/"))), `${family}: scene asset file must exist`);
      assert.deepStrictEqual(generatedTextPrompts, ["固定人物参考板", "固定摄影棚场景"], `${family}: exactly one character and one scene asset must be generated`);
      assert(generatedImageModels.every((value) => value === "gpt-image-2-w"), `${family}: every image call must use the selected image model`);

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
      const expectedResolution = family === "minimax-h3" ? "768p" : "720p";
      assert.deepStrictEqual(submittedOptions.map((options) => options.resolution), [
        expectedResolution,
        expectedResolution,
      ], `${family}: every video call must use its model-valid resolution`);
      if (family === "minimax-h3") {
        assert.deepStrictEqual(submittedOptions.map((options) => ({
          first: options.firstImageFile?.name,
          last: options.lastImageFile?.name || null,
        })), [
          { first: "镜头-001-入场-首帧.png", last: null },
          { first: "镜头-002-定格-首帧.png", last: "镜头-002-定格-尾帧.png" },
        ], "MiniMax-H3: first/last local files must stay in shot order");
        const submittedKeyframes = [
          submittedOptions[0].firstImageFile,
          submittedOptions[1].firstImageFile,
          submittedOptions[1].lastImageFile,
        ];
        assert(submittedKeyframes.every((file) => Buffer.isBuffer(file?.buffer)), "MiniMax-H3: every submitted keyframe must contain local file bytes");
        const savedKeyframePaths = [
          completed.shots[0].firstImagePath,
          completed.shots[1].firstImagePath,
          completed.shots[1].lastImagePath,
        ];
        submittedKeyframes.forEach((file, index) => {
          const savedBytes = fs.readFileSync(path.join(caseVault, ...savedKeyframePaths[index].split("/")));
          assert(file.buffer.equals(savedBytes), `MiniMax-H3: submitted keyframe ${index + 1} must match its saved shot file`);
        });
        assert.strictEqual(new Set(submittedKeyframes.map((file) => file.buffer.toString("hex"))).size, 3, "MiniMax-H3: shot keyframes must not be swapped or reused");
        assert.strictEqual(Object.hasOwn(submittedOptions[0], "lastImageFile"), false, "MiniMax-H3: last frame must stay optional");
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

  await runMockEndToEnd({ model: "MiniMax-H3", family: "minimax-h3", resolution: "768p" });
  await runMockEndToEnd({ model: "seedance-2.5", family: "seedance", resolution: "720p" });
  plugin.app = { vault: { adapter: { getBasePath: () => vault } } };
  plugin.processing = new Set();
  plugin.referenceAssetPromises = new Map();

  const generatedFolder = "山竹视频复刻/模拟生成";
  const generated = path.join(vault, ...generatedFolder.split("/"));
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(path.join(vault, "山竹视频"), { recursive: true });
  fs.writeFileSync(path.join(generated, "project.json"), JSON.stringify({ folder: generatedFolder, title: "模拟生成", frames: [], shots: [] }));
  fs.writeFileSync(path.join(vault, "山竹视频/mock.mp4"), "video");
  const image = generationImage({
    generateText: async () => ({}),
    generateEdit: async () => ({}),
    generateEditMulti: async () => { throw new Error("version 1 must not require multi-image editing"); },
    extractResults: () => [{ kind: "base64", value: Buffer.from("image").toString("base64") }],
  });
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
  const imageV2 = generationImage({
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
  });
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
  assert(fs.existsSync(path.join(vault, "山竹视频资产库", "人物", "hero", "character.json")));
  assert(fs.existsSync(path.join(vault, "山竹视频资产库", "场景", "studio", "scene.json")));
  assert.match(completedV2.characterAsset.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert(completedV2.sceneAssets.every((asset) => /^sha256:[a-f0-9]{64}$/.test(asset.contentHash)));

  const dashboardV2 = fs.readFileSync(path.join(generatedV2, "00-项目总览.md"), "utf8");
  assert.match(dashboardV2, /模型：`seedance-2\.5`/);
  assert.match(dashboardV2, /山竹视频资产库\/人物\/hero\/人物参考板\.png/);
  assert.match(dashboardV2, /山竹视频资产库\/场景\/harbor\/场景参考图\.png/);
  assert.match(dashboardV2, /镜头-001-港口-首帧\.png/);
  assert.match(dashboardV2, /镜头-002-摄影棚-尾帧\.png/);
  assert.match(dashboardV2, /镜头-002-摄影棚\.mp4/);

  await plugin.runGeneration(generatedV2Folder, requestV2, 457);
  assert.deepStrictEqual(generatedTextPrompts, ["固定人物参考板", "摄影棚场景"], "existing assets must be reused");
  assert.strictEqual(editCalls.length, 3, "retrying an unchanged project must reuse saved keyframes");
  assert.strictEqual(submittedV2Options.length, 2, "retrying a completed unchanged project must not submit duplicate videos");

  const beforeCharacterReplacement = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  fs.writeFileSync(path.join(vault, "山竹视频资产库", "人物", "hero", "人物参考板.png"), "manually-replaced-character");
  await plugin.runGeneration(generatedV2Folder, requestV2, 457.1);
  const afterCharacterReplacement = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  assert.strictEqual(editCalls.length, 6, "replacing character image bytes must regenerate every keyframe");
  assert.strictEqual(submittedV2Options.length, 4, "replacing character image bytes must invalidate every video");
  assert(afterCharacterReplacement.shots.every((shot, index) => shot.generationFingerprint !== beforeCharacterReplacement.shots[index].generationFingerprint));

  const beforeSceneReplacement = afterCharacterReplacement.shots.map((shot) => shot.generationFingerprint);
  fs.writeFileSync(harborImagePath, "manually-replaced-harbor");
  await plugin.runGeneration(generatedV2Folder, requestV2, 457.2);
  const afterSceneReplacement = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  assert.strictEqual(editCalls.length, 7, "replacing one scene image must regenerate only that scene's keyframe");
  assert.strictEqual(submittedV2Options.length, 5, "replacing one scene image must invalidate only that scene's video");
  assert.notStrictEqual(afterSceneReplacement.shots[0].generationFingerprint, beforeSceneReplacement[0]);
  assert.strictEqual(afterSceneReplacement.shots[1].generationFingerprint, beforeSceneReplacement[1]);

  const studioImagePath = path.join(vault, "山竹视频资产库", "场景", "studio", "场景参考图.png");
  const originalGenerateText = imageV2.generateText;
  imageV2.generateText = async (prompt) => {
    generatedTextPrompts.push(prompt);
    return { candidate: { kind: "base64", value: Buffer.from(`recreated:${prompt}`).toString("base64") } };
  };
  fs.unlinkSync(studioImagePath);
  await plugin.runGeneration(generatedV2Folder, requestV2, 457.3);
  imageV2.generateText = originalGenerateText;
  const afterSceneRecreation = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  assert.strictEqual(editCalls.length, 9, "a missing and recreated scene must regenerate its required keyframes");
  assert.strictEqual(submittedV2Options.length, 6, "a missing and recreated scene must invalidate its video");
  assert.strictEqual(afterSceneRecreation.shots[0].generationFingerprint, afterSceneReplacement.shots[0].generationFingerprint);
  assert.notStrictEqual(afterSceneRecreation.shots[1].generationFingerprint, afterSceneReplacement.shots[1].generationFingerprint);

  const reusableV2 = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  const deletedFirstImage = reusableV2.shots[1].firstImagePath;
  fs.unlinkSync(path.join(vault, ...deletedFirstImage.split("/")));
  await plugin.runGeneration(generatedV2Folder, requestV2, 458);
  assert.strictEqual(editCalls.length, 10, "a missing mandatory first keyframe must be regenerated");
  assert.strictEqual(submittedV2Options.length, 7, "a video must not be reused when a mandatory keyframe is missing");
  assert(fs.existsSync(path.join(vault, ...deletedFirstImage.split("/"))), "the missing mandatory keyframe must be restored");

  const beforeResolutionChange = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  const previousFingerprints = beforeResolutionChange.shots.map((shot) => shot.generationFingerprint);
  await plugin.runGeneration(generatedV2Folder, {
    ...requestV2,
    settings: { ...requestV2.settings, resolution: "1080p" },
  }, 459);
  const afterResolutionChange = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  assert.strictEqual(editCalls.length, 13, "an effective resolution change must invalidate all saved keyframes");
  assert.strictEqual(submittedV2Options.length, 9, "an effective resolution change must invalidate both saved videos");
  assert(afterResolutionChange.shots.every((shot, index) => shot.generationFingerprint !== previousFingerprints[index]), "resolution changes must persist new deterministic fingerprints");

  const resolutionFingerprints = afterResolutionChange.shots.map((shot) => shot.generationFingerprint);
  await plugin.runGeneration(generatedV2Folder, {
    ...requestV2,
    character: { ...requestV2.character, id: "hero-v2" },
    settings: { ...requestV2.settings, resolution: "1080p" },
  }, 460);
  const afterCharacterChange = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  assert.strictEqual(editCalls.length, 16, "a character ID change must invalidate all saved keyframes");
  assert.strictEqual(submittedV2Options.length, 11, "a character ID change must invalidate both saved videos");
  assert(afterCharacterChange.shots.every((shot, index) => shot.generationFingerprint !== resolutionFingerprints[index]), "character changes must persist new deterministic fingerprints");

  const characterFingerprints = afterCharacterChange.shots.map((shot) => shot.generationFingerprint);
  await plugin.runGeneration(generatedV2Folder, {
    ...requestV2,
    character: { ...requestV2.character, id: "hero-v2" },
    settings: { ...requestV2.settings, ratio: "16:9", resolution: "1080p" },
  }, 461);
  const afterRatioChange = JSON.parse(fs.readFileSync(path.join(generatedV2, "project.json"), "utf8"));
  assert.strictEqual(editCalls.length, 19, "a Seedance effective ratio change must invalidate all saved keyframes");
  assert.strictEqual(submittedV2Options.length, 13, "a Seedance effective ratio change must invalidate both saved videos");
  assert(afterRatioChange.shots.every((shot, index) => shot.generationFingerprint !== characterFingerprints[index]), "ratio changes must persist new deterministic fingerprints");

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
  const concurrentImage = generationImage({
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
  });
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
    image: generationImage({
      generateText: async () => { throw new Error("v2 paid image failed"); },
      generateEdit: async () => ({}),
      generateEditMulti: async () => ({}),
      extractResults: () => [],
    }),
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

  const modelErrorFolder = "山竹视频复刻/图片模型失败标记";
  const modelErrorRoot = path.join(vault, ...modelErrorFolder.split("/"));
  fs.mkdirSync(modelErrorRoot, { recursive: true });
  fs.writeFileSync(path.join(modelErrorRoot, "project.json"), JSON.stringify({ folder: modelErrorFolder, title: "图片模型失败标记", frames: [], shots: [] }));
  const modelErrorRequestPath = path.join(modelErrorRoot, "generation-request.json");
  fs.writeFileSync(modelErrorRequestPath, JSON.stringify({
    version: 2,
    confirmed: true,
    character: { id: "model-error-hero", prompt: "模型错误人物" },
    scenes: [{ id: "model-error-scene", prompt: "模型错误场景" }],
    settings: { imageModel: "gpt-image-2-w", ratio: "9:16", resolution: "768p", videoModel: "MiniMax-H3" },
    shots: [{ title: "失败镜头", sceneId: "model-error-scene", duration: 4, imagePrompt: "失败首帧", videoPrompt: "失败视频" }],
  }));
  plugin.getGenerationPlugins = () => ({
    image: generationImage({
      generateText: async () => { throw Object.assign(new Error("model not found"), { code: "MODEL_UNAVAILABLE", status: 404, changeModel: true }); },
      generateEdit: async () => ({}),
      generateEditMulti: async () => ({}),
      extractResults: () => [],
    }),
    video: {
      settings: { model: "MiniMax-H3", resolution: "768p" },
      refreshAgentAccess: async () => ({ videoModelKeys: { "MiniMax-H3": "test-key" } }),
      submitVideo: async () => ({ id: "must-not-run" }),
    },
  });
  await plugin.processRequest(modelErrorRequestPath);
  const modelErrorState = JSON.parse(fs.readFileSync(path.join(modelErrorRoot, ".work/generation-state.json"), "utf8"));
  const generationModelErrorProject = JSON.parse(fs.readFileSync(path.join(modelErrorRoot, "project.json"), "utf8"));
  assert.strictEqual(modelErrorState.status, "generation_image_model_error");
  assert.strictEqual(modelErrorState.model, "gpt-image-2-w");
  assert.strictEqual(generationModelErrorProject.status, "generation_image_model_error");
  assert.match(generationModelErrorProject.statusText, /gpt-image-2-w.*请更换图片模型后重试/);

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
