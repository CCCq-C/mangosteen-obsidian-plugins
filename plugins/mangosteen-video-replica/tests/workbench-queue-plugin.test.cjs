const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      ItemView: class ItemView {},
      Modal: class Modal {},
      Notice: class Notice {},
      Plugin: class Plugin {},
      requestUrl: async () => ({ status: 200, arrayBuffer: new ArrayBuffer(0) }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ReplicaPlugin = require("../main.js");

function request() {
  return {
    version: 3,
    confirmed: false,
    character: { id: "hero", prompt: "固定人物", voiceProfile: "固定女声" },
    products: [{ id: "phone", prompt: "银色手机" }],
    scenes: [{ id: "room", prompt: "明亮客厅" }],
    settings: { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
    shots: [
      {
        id: "001", title: "第一镜", sceneId: "room", productIds: ["phone"], duration: 4,
        dialogue: "第一句", voiceDirection: "自然", plot: "举起手机", environment: "客厅", camera: "推进",
        imagePrompt: "人物在客厅举起手机", lastImagePrompt: "", videoPrompt: "人物举起手机",
      },
      {
        id: "002", title: "第二镜", sceneId: "room", productIds: [], duration: 5,
        dialogue: "不应重新拼接", voiceDirection: "不应重新拼接", plot: "坐下", environment: "客厅", camera: "固定",
        imagePrompt: "人物坐在沙发", lastImagePrompt: "人物看向镜头", videoPrompt: "基础动作",
        videoPromptOverride: "用户确认后的完整视频提示词。",
      },
    ],
  };
}

(async () => {
  const sourceVault = path.resolve(__dirname, "../../..");
  const plugin = new ReplicaPlugin();
  plugin.app = {
    vault: { adapter: { getBasePath: () => sourceVault }, on: () => ({}) },
    workspace: { getLeavesOfType: () => [] },
  };
  plugin.manifest = { dir: "plugins/mangosteen-video-replica" };
  plugin.addRibbonIcon = plugin.registerEvent = plugin.registerInterval = plugin.register = plugin.addCommand = plugin.registerView = () => {};
  global.window = {
    setInterval: () => 1,
    setTimeout: () => 2,
    clearTimeout: () => {},
  };
  await plugin.onload();

  assert.strictEqual(typeof plugin.previewWorkbenchGeneration, "function");
  assert.strictEqual(typeof plugin.startWorkbenchGeneration, "function");
  assert.strictEqual(typeof plugin.runWorkbenchQueueShot, "function");
  assert.strictEqual(typeof plugin.recoverWorkbenchQueue, "function");

  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-shot-queue-"));
  const folder = "山竹视频复刻/队列项目";
  const root = path.join(vault, ...folder.split("/"));
  fs.mkdirSync(path.join(root, ".work"), { recursive: true });
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({
    folder,
    title: "队列项目",
    status: "analysis_ready",
    statusText: "等待选择镜头",
    shots: request().shots.map((shot) => ({ ...shot, status: "等待生成" })),
  }));
  fs.writeFileSync(path.join(root, "generation-request.json"), JSON.stringify(request()));
  plugin.app = {
    vault: { adapter: { getBasePath: () => vault }, on: () => ({}) },
    workspace: { getLeavesOfType: () => [] },
    plugins: { getPlugin: () => null },
  };
  plugin.refreshGenerationModelCatalog = async () => ({
    imageModels: ["gpt-image-2-w"],
    videoModels: ["MiniMax-H3"],
  });

  const plan = await plugin.previewWorkbenchGeneration(folder, ["002", "001"]);
  assert.deepStrictEqual(plan.selectedShotIds, ["001", "002"], "preview must preserve draft order");
  assert.strictEqual(plan.shots[1].effectiveVideoPrompt, "用户确认后的完整视频提示词。");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, "generation-request.json"))).confirmed, false);

  const submitted = [];
  const realRunWorkbenchQueueShot = plugin.runWorkbenchQueueShot.bind(plugin);
  plugin.runWorkbenchQueueShot = async (_folder, shot) => {
    submitted.push({ id: shot.id, prompt: shot.effectiveVideoPrompt });
    return { videoPath: `${folder}/03-视频片段/${shot.id}.mp4` };
  };
  let releaseStartValidation;
  let startValidationReached;
  const startValidationGate = new Promise((resolve) => { releaseStartValidation = resolve; });
  const startValidationStarted = new Promise((resolve) => { startValidationReached = resolve; });
  plugin.refreshGenerationModelCatalog = async () => {
    startValidationReached();
    await startValidationGate;
    return { imageModels: ["gpt-image-2-w"], videoModels: ["MiniMax-H3"] };
  };
  const firstStart = plugin.startWorkbenchGeneration(folder, plan);
  await startValidationStarted;
  await assert.rejects(
    () => plugin.startWorkbenchGeneration(folder, plan),
    /正在创建|队列锁/,
    "concurrent callers must not both pass the project-level queue reservation",
  );
  releaseStartValidation();
  const queued = await firstStart;
  assert.strictEqual(queued.status, "idle", "enqueue must return before long-running generation completes");
  await plugin.queueRuns.get(folder);
  assert.deepStrictEqual(submitted.map((item) => item.id), ["001", "002"]);
  assert.strictEqual(submitted[1].prompt, "用户确认后的完整视频提示词。");
  const persistedQueue = JSON.parse(fs.readFileSync(path.join(root, ".work/generation-queue.json")));
  assert.strictEqual(persistedQueue.status, "completed");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, "generation-request.json"))).confirmed, false, "queue generation must never set confirmed=true");
  assert.strictEqual(plugin.loadWorkbenchProject(folder).generationQueue.status, "completed");

  const appendFirstPlan = await plugin.previewWorkbenchGeneration(folder, ["001"]);
  let releaseAppendFirst;
  let appendFirstReached;
  const appendFirstGate = new Promise((resolve) => { releaseAppendFirst = resolve; });
  const appendFirstStarted = new Promise((resolve) => { appendFirstReached = resolve; });
  const appendedSubmissions = [];
  plugin.runWorkbenchQueueShot = async (_folder, shot, context) => {
    appendedSubmissions.push({ id: shot.id, planId: context.planId, prompt: shot.effectiveVideoPrompt });
    if (shot.id === "001") {
      appendFirstReached();
      await appendFirstGate;
    }
    return { videoPath: `${folder}/03-视频片段/${shot.id}-append.mp4` };
  };
  await plugin.startWorkbenchGeneration(folder, appendFirstPlan);
  await appendFirstStarted;
  const appendSecondPlan = await plugin.previewWorkbenchGeneration(folder, ["002"]);
  const appendedQueue = await plugin.startWorkbenchGeneration(folder, appendSecondPlan);
  assert.deepStrictEqual(
    appendedQueue.shots.map((shot) => [shot.id, shot.status]),
    [["001", "processing"], ["002", "queued"]],
    "a later selected shot must append to the live queue instead of starting a conflicting queue",
  );
  releaseAppendFirst();
  await plugin.queueRuns.get(folder);
  assert.deepStrictEqual(appendedSubmissions.map((item) => item.id), ["001", "002"]);
  assert.notStrictEqual(appendedSubmissions[0].planId, appendedSubmissions[1].planId, "each submission must retain its own confirmed plan snapshot");
  assert.strictEqual(appendedSubmissions[1].prompt, "用户确认后的完整视频提示词。");

  const stalePlan = await plugin.previewWorkbenchGeneration(folder, ["001"]);
  let releaseStaleValidation;
  let staleValidationReached;
  const staleValidationGate = new Promise((resolve) => { releaseStaleValidation = resolve; });
  const staleValidationStarted = new Promise((resolve) => { staleValidationReached = resolve; });
  let staleCatalogCalls = 0;
  plugin.refreshGenerationModelCatalog = async () => {
    staleCatalogCalls += 1;
    if (staleCatalogCalls === 1) {
      staleValidationReached();
      await staleValidationGate;
    }
    return { imageModels: ["gpt-image-2-w"], videoModels: ["MiniMax-H3"] };
  };
  const submissionsBeforeStaleRace = submitted.length;
  plugin.runWorkbenchQueueShot = async (_folder, shot) => {
    submitted.push(shot.id);
    return { videoPath: `${folder}/03-视频片段/${shot.id}-stale.mp4` };
  };
  const staleFirstStart = plugin.startWorkbenchGeneration(folder, stalePlan);
  const staleFirstRejected = assert.rejects(
    staleFirstStart,
    /锁已被其他实例接管|队列锁已丢失/,
    "a stale lock holder must revalidate ownership before enqueueing",
  );
  await staleValidationStarted;
  const staleLockPath = path.join(root, ".work/generation-queue.lock");
  const staleTime = new Date(Date.now() - 6 * 60 * 1000);
  fs.utimesSync(staleLockPath, staleTime, staleTime);
  await plugin.startWorkbenchGeneration(folder, stalePlan);
  await plugin.queueRuns.get(folder);
  releaseStaleValidation();
  await staleFirstRejected;
  assert.strictEqual(submitted.length, submissionsBeforeStaleRace + 1, "only the replacement lock owner may enqueue paid work");
  assert.strictEqual(fs.existsSync(staleLockPath), false, "the replacement owner must release its lock cleanly");

  plugin.refreshGenerationModelCatalog = async () => ({
    imageModels: ["gpt-image-2-w"],
    videoModels: ["MiniMax-H3"],
  });
  const lostLockPlan = await plugin.previewWorkbenchGeneration(folder, ["001", "002"]);
  let releaseLostLockShot;
  let lostLockShotReached;
  const lostLockShotGate = new Promise((resolve) => { releaseLostLockShot = resolve; });
  const lostLockShotStarted = new Promise((resolve) => { lostLockShotReached = resolve; });
  const lostLockSubmitted = [];
  plugin.runWorkbenchQueueShot = async (_folder, shot) => {
    lostLockSubmitted.push(shot.id);
    if (shot.id === "001") {
      lostLockShotReached();
      await lostLockShotGate;
    }
    return { videoPath: `${folder}/03-视频片段/${shot.id}.mp4` };
  };
  await plugin.startWorkbenchGeneration(folder, lostLockPlan);
  await lostLockShotStarted;
  const lostLockPath = path.join(root, ".work/generation-queue.lock");
  const lostLockStaleTime = new Date(Date.now() - 6 * 60 * 1000);
  fs.utimesSync(lostLockPath, lostLockStaleTime, lostLockStaleTime);
  await assert.rejects(
    () => plugin.startWorkbenchGeneration(folder, lostLockPlan),
    /已经在当前队列中|请勿重复提交/,
    "a duplicate submission must not detach the running queue from its own lock",
  );
  assert.strictEqual(plugin.queueRunnerLocks.size, 1, "the old run must retain its queue-specific lost-lock state");
  const replacedLock = JSON.parse(fs.readFileSync(lostLockPath));
  fs.writeFileSync(lostLockPath, JSON.stringify({
    ...replacedLock,
    token: "replacement-owner-token",
    heartbeatAt: new Date().toISOString(),
  }));
  releaseLostLockShot();
  await assert.rejects(
    plugin.queueRuns.get(folder),
    /队列锁已丢失|锁已被其他实例接管/,
    "a runner that loses its lock must stop before submitting the next paid shot",
  );
  assert.deepStrictEqual(lostLockSubmitted, ["001"], "lock loss must prevent every later shot submission");
  assert.strictEqual(plugin.queueRunnerLocks.size, 0, "the stopped old run must clean up its queue-specific lock state");
  assert.strictEqual(plugin.queueRunnerLockRequired.size, 0, "the stopped old run must clean up its lock requirement");
  fs.rmSync(lostLockPath, { force: true });
  plugin.activeQueueObjects.delete(folder);
  plugin.queueApis.delete(folder);
  fs.writeFileSync(path.join(root, ".work/generation-queue.json"), JSON.stringify(persistedQueue));

  const stopPlan = await plugin.previewWorkbenchGeneration(folder, ["001", "002"]);
  let releaseFirstShot;
  let firstShotReached;
  const firstShotGate = new Promise((resolve) => { releaseFirstShot = resolve; });
  const firstShotStarted = new Promise((resolve) => { firstShotReached = resolve; });
  const stopSubmitted = [];
  plugin.runWorkbenchQueueShot = async (_folder, shot) => {
    stopSubmitted.push(shot.id);
    if (shot.id === "001") {
      firstShotReached();
      await firstShotGate;
    }
    return { videoPath: `${folder}/03-视频片段/${shot.id}.mp4` };
  };
  await plugin.startWorkbenchGeneration(folder, stopPlan);
  await firstShotStarted;
  const runnerLockPath = path.join(root, ".work/generation-queue.lock");
  assert.strictEqual(fs.existsSync(runnerLockPath), true, "the queue runner must keep the renewable project lock until it finishes");
  await plugin.stopWorkbenchGeneration(folder);
  releaseFirstShot();
  await plugin.queueRuns.get(folder);
  assert.strictEqual(fs.existsSync(runnerLockPath), false, "the queue runner must release its project lock after stopping");
  assert.deepStrictEqual(stopSubmitted, ["001"], "stop must update the exact queue object used by the runner");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, ".work/generation-queue.json"))).status, "stopped");

  const activeQueue = {
    ...persistedQueue,
    queueId: "active-queue",
    status: "processing",
    stopRequested: false,
    shots: [{ ...persistedQueue.shots[0], id: "001", status: "processing" }],
  };
  fs.writeFileSync(path.join(root, ".work/generation-queue.json"), JSON.stringify(activeQueue));
  plugin.queueApis.delete(folder);
  const otherPlan = await plugin.previewWorkbenchGeneration(folder, ["002"]);
  await assert.rejects(
    () => plugin.startWorkbenchGeneration(folder, otherPlan),
    /另一个 Obsidian 窗口运行/,
    "one project queue file must not be overwritten by a concurrent queue",
  );

  const submittedVideoOptions = [];
  plugin.runWorkbenchQueueShot = realRunWorkbenchQueueShot;
  plugin.getGenerationPlugins = () => ({
    image: {},
    video: {
      settings: { resolution: "768p" },
      submitVideo: async (options) => { submittedVideoOptions.push(options); return { id: "video-task" }; },
    },
  });
  plugin.resolveQueueGenerationRuntime = async () => ({
    image: {}, video: plugin.getGenerationPlugins().video, imageModel: "gpt-image-2-w", model: "MiniMax-H3", resolution: "768p",
  });
  plugin.ensureReferenceAsset = async (_image, asset) => ({
    ...asset,
    imagePath: `山竹视频资产库/${asset.kind}/${asset.id}.png`,
    metadataPath: `山竹视频资产库/${asset.kind}/${asset.id}.json`,
    contentHash: `${asset.kind}-${asset.id}-hash`,
    reused: true,
  });
  plugin.generateImageMulti = async () => ({ kind: "base64", value: "eA==" });
  plugin.saveImageCandidate = async (_image, _candidate, target) => target;
  plugin.localImage = (vaultPath) => ({ name: path.basename(vaultPath), buffer: Buffer.from("x") });
  let releaseVideoWait;
  let videoWaitReached;
  const videoWaitGate = new Promise((resolve) => { releaseVideoWait = resolve; });
  const videoWaitStarted = new Promise((resolve) => { videoWaitReached = resolve; });
  plugin.waitForVideo = async (videoPlugin, taskId) => {
    assert.strictEqual(taskId, "video-task");
    videoWaitReached();
    await videoWaitGate;
    return { localPath: "山竹视频资产库/generated.mp4" };
  };
  plugin.copyVaultFile = (_source, target) => target;
  fs.writeFileSync(path.join(root, ".work/generation-queue.json"), JSON.stringify({}));
  const directPlan = await plugin.previewWorkbenchGeneration(folder, ["002"]);
  const directRun = plugin.runWorkbenchQueueShot(folder, directPlan.shots[0], {
    queueId: "direct",
    planId: directPlan.planId,
    character: directPlan.character,
    products: directPlan.products,
    scenes: directPlan.scenes,
    settings: directPlan.settings,
  });
  await videoWaitStarted;
  const duringVideo = JSON.parse(fs.readFileSync(path.join(root, "project.json")));
  const runningShot = duringVideo.shots.find((shot) => shot.id === "002");
  assert.strictEqual(runningShot.videoTaskId, "video-task", "provider task ID must be persisted before polling begins");
  duringVideo.shots.find((shot) => shot.id === "001").title = "用户生成期间修改的第一镜";
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(duringVideo));
  releaseVideoWait();
  const directResult = await directRun;
  assert.strictEqual(submittedVideoOptions[0].prompt, "用户确认后的完整视频提示词。");
  assert.match(directResult.videoPath, /镜头-002/);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(root, "project.json"))).shots.find((shot) => shot.id === "001").title,
    "用户生成期间修改的第一镜",
    "shot generation must merge into the latest project instead of overwriting unrelated edits",
  );

  const directRuntimeResolver = plugin.resolveQueueGenerationRuntime;
  async function runTimelineReferenceCase(model, resolution) {
    const caseFolder = `山竹视频复刻/时间轴参考-${model}`;
    const caseRoot = path.join(vault, ...caseFolder.split("/"));
    fs.mkdirSync(path.join(caseRoot, ".work"), { recursive: true });
    fs.writeFileSync(path.join(caseRoot, "project.json"), JSON.stringify({ folder: caseFolder, title: model, shots: [] }));
    fs.writeFileSync(path.join(caseRoot, ".work/generation-queue.json"), JSON.stringify({}));
    const calls = { frames: 0, options: null };
    plugin.resolveQueueGenerationRuntime = async () => ({
      image: {},
      video: { submitVideo: async (options) => { calls.options = options; return { id: `task-${model}` }; } },
      imageModel: "gpt-image-2-w",
      model,
      resolution,
    });
    plugin.generateImageMulti = async () => { calls.frames += 1; return { kind: "base64", value: "eA==" }; };
    plugin.waitForVideo = async () => ({ localPath: "山竹视频资产库/generated.mp4" });
    const context = {
      queueId: `queue-${model}`,
      planId: `plan-${model}`,
      requestVersion: 4,
      character: { id: "hero", prompt: "固定人物三视图", voiceProfile: "固定女声" },
      products: [{ id: "phone", prompt: "银色手机" }],
      scenes: [{ id: "room", prompt: "明亮客厅" }],
      settings: { imageModel: "gpt-image-2-w", videoModel: model, ratio: "9:16", resolution },
    };
    const shot = {
      id: "001",
      title: "时间轴镜头",
      sceneId: "room",
      productIds: ["phone"],
      duration: 6,
      timeline: [
        { start: 0, end: 2, action: "人物走入客厅", dialogue: "", performance: "自然", camera: "远景跟拍", environment: "明亮客厅" },
        { start: 2, end: 6, action: "人物举起手机", dialogue: "就是这款。", performance: "惊喜", camera: "中景推进", environment: "同一客厅" },
      ],
      effectiveVideoPrompt: "已确认的时间轴提示词",
    };
    await plugin.runWorkbenchQueueShot(caseFolder, shot, context);
    return calls;
  }

  const h3TimelineCalls = await runTimelineReferenceCase("MiniMax-H3", "768p");
  assert.strictEqual(h3TimelineCalls.frames, 1, "MiniMax-H3 timeline shots must generate one automatic first frame");
  assert(h3TimelineCalls.options.firstImageFile, "MiniMax-H3 must submit the automatic first frame");
  assert.strictEqual(Object.hasOwn(h3TimelineCalls.options, "lastImageFile"), false, "MiniMax-H3 must not invent a last frame");
  assert.strictEqual(Object.hasOwn(h3TimelineCalls.options, "referenceImageFiles"), false, "MiniMax-H3 cannot accept reference image arrays");

  const seedanceTimelineCalls = await runTimelineReferenceCase("seedance-2.5", "720p");
  assert.strictEqual(seedanceTimelineCalls.frames, 0, "Seedance timeline shots must not generate per-shot frames");
  assert.strictEqual(Object.hasOwn(seedanceTimelineCalls.options, "firstImageFile"), false);
  assert.strictEqual(Object.hasOwn(seedanceTimelineCalls.options, "lastImageFile"), false);
  assert.deepStrictEqual(
    seedanceTimelineCalls.options.referenceImageFiles.map((file) => file.name),
    ["hero.png", "room.png", "phone.png"],
    "Seedance must receive the shared character, scene, and product assets directly",
  );

  async function runLegacyReferenceCase(model) {
    const caseFolder = `山竹视频复刻/旧版参考-${model}`;
    const caseRoot = path.join(vault, ...caseFolder.split("/"));
    fs.mkdirSync(path.join(caseRoot, ".work"), { recursive: true });
    fs.writeFileSync(path.join(caseRoot, "project.json"), JSON.stringify({ folder: caseFolder, title: model, shots: [] }));
    fs.writeFileSync(path.join(caseRoot, ".work/generation-queue.json"), JSON.stringify({}));
    const calls = { frames: 0, options: null };
    plugin.resolveQueueGenerationRuntime = async () => ({
      image: {},
      video: { submitVideo: async (options) => { calls.options = options; return { id: `legacy-${model}` }; } },
      imageModel: "gpt-image-2-w",
      model,
      resolution: "768p",
    });
    plugin.generateImageMulti = async () => { calls.frames += 1; return { kind: "base64", value: "eA==" }; };
    plugin.waitForVideo = async () => ({ localPath: "山竹视频资产库/generated.mp4" });
    await plugin.runWorkbenchQueueShot(caseFolder, {
      id: "001",
      title: "旧版镜头",
      sceneId: "room",
      productIds: ["phone"],
      duration: 6,
      timeline: [{ start: 0, end: 6, action: "旧版动作", dialogue: "旧版台词", performance: "自然", camera: "中景", environment: "客厅" }],
      imagePrompt: "旧版首帧提示词",
      lastImagePrompt: "旧版尾帧提示词",
      effectiveVideoPrompt: "旧版已确认提示词",
    }, {
      queueId: `legacy-queue-${model}`,
      planId: `legacy-plan-${model}`,
      requestVersion: 3,
      character: { id: "hero", prompt: "固定人物三视图", voiceProfile: "固定女声" },
      products: [{ id: "phone", prompt: "银色手机" }],
      scenes: [{ id: "room", prompt: "明亮客厅" }],
      settings: { imageModel: "gpt-image-2-w", videoModel: model, ratio: "9:16", resolution: "768p" },
    });
    return calls;
  }

  const legacyH3Calls = await runLegacyReferenceCase("MiniMax-H3");
  assert.strictEqual(legacyH3Calls.frames, 2, "legacy H3 queues must keep their confirmed first and last frame flow");
  assert(legacyH3Calls.options.firstImageFile);
  assert(legacyH3Calls.options.lastImageFile);
  const legacySeedanceCalls = await runLegacyReferenceCase("seedance-2.5");
  assert.strictEqual(legacySeedanceCalls.frames, 2, "legacy Seedance queues must keep their confirmed first and last frame flow");
  assert.strictEqual(legacySeedanceCalls.options.referenceImageFiles.length, 2);
  plugin.resolveQueueGenerationRuntime = directRuntimeResolver;

  const recoverProject = JSON.parse(fs.readFileSync(path.join(root, "project.json")));
  const recoverShot = recoverProject.shots.find((shot) => shot.id === "002");
  recoverShot.videoPath = "";
  recoverShot.status = "正在生成视频";
  recoverShot.videoTaskId = "video-task";
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(recoverProject));
  const recoverQueue = {
    ...JSON.parse(JSON.stringify(persistedQueue)),
    queueId: "recover-queue",
    planId: directPlan.planId,
    status: "processing",
    stopRequested: false,
    character: directPlan.character,
    products: directPlan.products,
    scenes: directPlan.scenes,
    settings: directPlan.settings,
    selectedShotIds: ["002"],
    shots: [{ ...directPlan.shots[0], status: "processing", error: "", result: null }],
  };
  fs.writeFileSync(path.join(root, ".work/generation-queue.json"), JSON.stringify(recoverQueue));
  plugin.queueApis.delete(folder);
  submittedVideoOptions.length = 0;
  let releaseRecoveryWait;
  let recoveryWaitReached;
  const recoveryWaitGate = new Promise((resolve) => { releaseRecoveryWait = resolve; });
  const recoveryWaitStarted = new Promise((resolve) => { recoveryWaitReached = resolve; });
  plugin.waitForVideo = async (_videoPlugin, taskId) => {
    assert.strictEqual(taskId, "video-task");
    recoveryWaitReached();
    await recoveryWaitGate;
    return { localPath: "山竹视频资产库/recovered.mp4" };
  };
  assert.strictEqual(await plugin.recoverWorkbenchQueue(folder), true);
  await recoveryWaitStarted;
  assert.strictEqual(fs.existsSync(runnerLockPath), true, "recovery must hold the same renewable project lock as a new queue");
  assert.strictEqual(
    await plugin.recoverWorkbenchQueue(folder),
    false,
    "a second Obsidian instance must not recover the same paid queue while the runner lock is live",
  );
  releaseRecoveryWait();
  await plugin.queueRuns.get(folder);
  assert.strictEqual(fs.existsSync(runnerLockPath), false, "recovery must release the project lock after completion");
  assert.strictEqual(submittedVideoOptions.length, 0, "restart recovery must poll the persisted task instead of resubmitting it");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, ".work/generation-queue.json"))).status, "completed");

  const repeatedAfterRecovery = [];
  plugin.runWorkbenchQueueShot = async (_folder, shot) => {
    repeatedAfterRecovery.push(shot.id);
    return { videoPath: `${folder}/03-视频片段/${shot.id}-repeat.mp4` };
  };
  const repeatPlan = await plugin.previewWorkbenchGeneration(folder, ["002"]);
  await plugin.startWorkbenchGeneration(folder, repeatPlan);
  await plugin.queueRuns.get(folder);
  assert.deepStrictEqual(repeatedAfterRecovery, ["002"], "a recovered queue must not leave a stale locked copy in the logic API");
  plugin.runWorkbenchQueueShot = realRunWorkbenchQueueShot;

  const failedProject = JSON.parse(fs.readFileSync(path.join(root, "project.json")));
  const failedShot = failedProject.shots.find((shot) => shot.id === "002");
  failedShot.videoPath = "";
  failedShot.status = "正在恢复并查询已有视频任务";
  failedShot.videoTaskId = "failed-video-task";
  failedShot.videoTaskPlanId = directPlan.planId;
  failedShot.videoTaskFingerprint = "old-fingerprint";
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(failedProject));
  plugin.waitForVideo = async () => {
    const failure = new Error("视频描述或参考材料未通过平台审核，请调整内容后重试。");
    failure.code = "VIDEO_TASK_FAILED";
    failure.terminalTaskFailure = true;
    throw failure;
  };
  await assert.rejects(
    () => plugin.runWorkbenchQueueShot(folder, directPlan.shots[0], {
      queueId: "failed-recovery",
      planId: directPlan.planId,
      character: directPlan.character,
      products: directPlan.products,
      scenes: directPlan.scenes,
      settings: directPlan.settings,
    }),
    /未通过平台审核/,
  );
  const failedPersistedShot = JSON.parse(fs.readFileSync(path.join(root, "project.json"))).shots.find((shot) => shot.id === "002");
  assert.strictEqual(failedPersistedShot.videoTaskId, "", "terminal provider failures must release the task ID for a real retry");
  assert.strictEqual(failedPersistedShot.failedVideoTaskId, "failed-video-task", "the failed provider task must remain auditable");

  submittedVideoOptions.length = 0;
  plugin.waitForVideo = async () => ({ localPath: "山竹视频资产库/retry.mp4" });
  await plugin.runWorkbenchQueueShot(folder, directPlan.shots[0], {
    queueId: "retry-after-terminal-failure",
    planId: directPlan.planId,
    character: directPlan.character,
    products: directPlan.products,
    scenes: directPlan.scenes,
    settings: directPlan.settings,
  });
  assert.strictEqual(submittedVideoOptions.length, 1, "retry after a terminal failure must submit a new provider task");

  const syncScriptPath = path.resolve(__dirname, "../../../scripts/sync-plugin-code-to-vault.sh");
  if (fs.existsSync(syncScriptPath)) {
    const syncScript = fs.readFileSync(syncScriptPath, "utf8");
    assert.match(syncScript, /generation-queue\.cjs/, "live-vault sync must include the queue engine");
    assert.match(syncScript, /replica-logic-api\.cjs/, "live-vault sync must include the queue facade");
    assert.match(syncScript, /workbench-queue-plugin\.test\.cjs/, "live-vault sync must include its queue regression test");
  }

  fs.rmSync(vault, { recursive: true, force: true });
  console.log("workbench-queue-plugin: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
