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
const { confirmGenerationPlan, createGenerationQueue } = require("../generation-queue.cjs");
const projectStorage = require("../project-storage.cjs");
const runState = require("../run-state.cjs");

function runShots(run) {
  return run.queue.map((id) => run.shots[id]);
}

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
  assert.match(plan.shots[1].effectiveVideoPrompt, /用户确认后的完整视频提示词。/);
  assert.match(plan.shots[1].effectiveVideoPrompt, /【项目视觉风格】/);
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
  assert.strictEqual(queued.status, "queued", "enqueue must return before long-running generation completes");
  await plugin.queueRuns.get(folder);
  assert.deepStrictEqual(submitted.map((item) => item.id), ["001", "002"]);
  assert.match(submitted[1].prompt, /用户确认后的完整视频提示词。/);
  assert.match(submitted[1].prompt, /【项目视觉风格】/);
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
    runShots(appendedQueue).map((shot) => [shot.id, shot.status]),
    [["001", "processing"], ["002", "queued"]],
    "a later selected shot must append to the live queue instead of starting a conflicting queue",
  );
  releaseAppendFirst();
  await plugin.queueRuns.get(folder);
  assert.deepStrictEqual(appendedSubmissions.map((item) => item.id), ["001", "002"]);
  assert.notStrictEqual(appendedSubmissions[0].planId, appendedSubmissions[1].planId, "each submission must retain its own confirmed plan snapshot");
  assert.match(appendedSubmissions[1].prompt, /用户确认后的完整视频提示词。/);
  assert.match(appendedSubmissions[1].prompt, /【项目视觉风格】/);

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
    runId: "active-queue",
    status: "processing",
    stopRequested: false,
    queue: ["001"],
    selectedShotIds: ["001"],
    shots: { "001": { ...persistedQueue.shots["001"], id: "001", status: "processing" } },
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
  const directRunStateUpdates = [];
  const directRun = plugin.runWorkbenchQueueShot(folder, directPlan.shots[0], {
    queueId: "direct",
    planId: directPlan.planId,
    character: directPlan.character,
    products: directPlan.products,
    scenes: directPlan.scenes,
    settings: directPlan.settings,
    updateState: async (patch) => { directRunStateUpdates.push(JSON.parse(JSON.stringify(patch))); },
  });
  await videoWaitStarted;
  const duringVideo = JSON.parse(fs.readFileSync(path.join(root, "project.json")));
  const runningShot = duringVideo.shots.find((shot) => shot.id === "002");
  assert.strictEqual(runningShot.videoTaskId, "video-task", "provider task ID must be persisted before polling begins");
  const acceptedTaskUpdate = directRunStateUpdates.find((patch) => patch.taskId === "video-task");
  assert.strictEqual(acceptedTaskUpdate?.paidTaskSubmitted, true, "an accepted provider task must immediately update active run state");
  assert.strictEqual(acceptedTaskUpdate?.progress, null, "provider progress must remain null when the provider supplies no number");
  assert.strictEqual(
    directRunStateUpdates.some((patch) => patch.stage === "first-frame" && patch.paidTaskSubmitted === true),
    true,
    "a completed paid image submission must mark the active run even before a video task ID exists",
  );
  duringVideo.shots.find((shot) => shot.id === "001").title = "用户生成期间修改的第一镜";
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(duringVideo));
  releaseVideoWait();
  const directResult = await directRun;
  assert.match(submittedVideoOptions[0].prompt, /用户确认后的完整视频提示词。/);
  assert.match(submittedVideoOptions[0].prompt, /【项目视觉风格】/);
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

  async function runLegacyReferenceCase(model, requestVersion = 3, legacyFrameMode = false) {
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
      legacyFrameMode,
    }, {
      queueId: `legacy-queue-${model}`,
      planId: `legacy-plan-${model}`,
      requestVersion,
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
  const migratedLegacyCalls = await runLegacyReferenceCase("MiniMax-H3", 4, true);
  assert.strictEqual(migratedLegacyCalls.frames, 1, "migrated v4 shots must drop the unnecessary last-frame generation");
  assert(migratedLegacyCalls.options.firstImageFile);
  assert.strictEqual(Object.hasOwn(migratedLegacyCalls.options, "lastImageFile"), false);
  plugin.resolveQueueGenerationRuntime = directRuntimeResolver;

  const paidBoundaryFolder = "山竹视频复刻/持久化停止边界";
  const paidBoundaryRoot = path.join(vault, ...paidBoundaryFolder.split("/"));
  fs.mkdirSync(path.join(paidBoundaryRoot, ".work"), { recursive: true });
  fs.writeFileSync(path.join(paidBoundaryRoot, "project.json"), JSON.stringify({
    folder: paidBoundaryFolder,
    title: "持久化停止边界",
    status: "analysis_ready",
    shots: request().shots.map((shot) => ({ ...shot, status: "等待生成" })),
  }));
  fs.writeFileSync(path.join(paidBoundaryRoot, "generation-request.json"), JSON.stringify(request()));
  fs.writeFileSync(path.join(paidBoundaryRoot, ".work/generation-queue.json"), JSON.stringify({}));
  const originalEnsureReferenceAsset = plugin.ensureReferenceAsset;
  let paidBoundaryCalls = 0;
  plugin.ensureReferenceAsset = async (...args) => {
    paidBoundaryCalls += 1;
    return originalEnsureReferenceAsset(...args);
  };
  try {
    await assert.rejects(
      () => plugin.runWorkbenchQueueShot(paidBoundaryFolder, directPlan.shots[0], {
        queueId: "persisted-stop-boundary",
        planId: directPlan.planId,
        requestVersion: directPlan.requestVersion,
        character: directPlan.character,
        products: directPlan.products,
        scenes: directPlan.scenes,
        settings: directPlan.settings,
        assertPaidSubmissionAllowed: async () => false,
      }),
      /用户已停止生成/,
      "the workbench runner must await the persisted stop check immediately before paid provider work",
    );
  } finally {
    plugin.ensureReferenceAsset = originalEnsureReferenceAsset;
  }
  assert.strictEqual(paidBoundaryCalls, 0, "a persisted stop must prevent the next paid provider call");

  const paidBoundaryExpectations = {
    "reference-asset": { references: 0, images: 0, videos: 0 },
    "first-frame": { references: 2, images: 0, videos: 0 },
    "last-frame": { references: 2, images: 1, videos: 0 },
    "video-submission": { references: 2, images: 2, videos: 0 },
  };
  const originalBoundaryGenerateImageMulti = plugin.generateImageMulti;
  for (const [blockedBoundary, expectedCalls] of Object.entries(paidBoundaryExpectations)) {
    const caseFolder = `山竹视频复刻/付费闸门-${blockedBoundary}`;
    const caseRoot = path.join(vault, ...caseFolder.split("/"));
    fs.mkdirSync(path.join(caseRoot, ".work"), { recursive: true });
    fs.writeFileSync(path.join(caseRoot, "project.json"), JSON.stringify({
      folder: caseFolder,
      title: blockedBoundary,
      status: "analysis_ready",
      shots: request().shots.map((shot) => ({ ...shot, status: "等待生成" })),
    }));
    fs.writeFileSync(path.join(caseRoot, "generation-request.json"), JSON.stringify(request()));
    fs.writeFileSync(path.join(caseRoot, ".work/generation-queue.json"), JSON.stringify({}));
    const calls = { references: 0, images: 0, videos: 0, boundaries: [] };
    plugin.ensureReferenceAsset = async (_image, asset) => {
      calls.references += 1;
      return {
        ...asset,
        imagePath: `山竹视频资产库/${asset.kind}/${asset.id}.png`,
        metadataPath: `山竹视频资产库/${asset.kind}/${asset.id}.json`,
        contentHash: `${asset.kind}-${asset.id}-hash`,
        reused: true,
      };
    };
    plugin.generateImageMulti = async () => {
      calls.images += 1;
      return { kind: "base64", value: "eA==" };
    };
    plugin.resolveQueueGenerationRuntime = async () => ({
      image: {},
      video: { submitVideo: async () => { calls.videos += 1; return { id: `task-${blockedBoundary}` }; } },
      imageModel: "gpt-image-2-w",
      model: "MiniMax-H3",
      resolution: "768p",
    });
    plugin.waitForVideo = async () => ({ localPath: "山竹视频资产库/generated.mp4" });
    await assert.rejects(
      () => plugin.runWorkbenchQueueShot(caseFolder, directPlan.shots[0], {
        queueId: `paid-gate-${blockedBoundary}`,
        planId: directPlan.planId,
        requestVersion: directPlan.requestVersion,
        character: directPlan.character,
        products: directPlan.products,
        scenes: directPlan.scenes,
        settings: directPlan.settings,
        assertPaidSubmissionAllowed: async () => true,
        withPaidSubmissionGate: async (boundary, operation) => {
          calls.boundaries.push(boundary.kind);
          if (boundary.kind === blockedBoundary) {
            const stopped = new Error(`blocked ${blockedBoundary}`);
            stopped.code = "GENERATION_STOPPED";
            throw stopped;
          }
          return operation();
        },
      }),
      new RegExp(`blocked ${blockedBoundary}`),
    );
    assert.deepStrictEqual(
      { references: calls.references, images: calls.images, videos: calls.videos },
      expectedCalls,
      `${blockedBoundary} must be reserved through the shared gate before its provider call`,
    );
    assert(calls.boundaries.includes(blockedBoundary), `${blockedBoundary} must reach the shared submission gate`);
  }
  plugin.ensureReferenceAsset = originalEnsureReferenceAsset;
  plugin.generateImageMulti = originalBoundaryGenerateImageMulti;
  plugin.resolveQueueGenerationRuntime = directRuntimeResolver;

  const recoverProject = JSON.parse(fs.readFileSync(path.join(root, "project.json")));
  const recoverShot = recoverProject.shots.find((shot) => shot.id === "002");
  recoverShot.videoPath = "";
  recoverShot.status = "正在生成视频";
  recoverShot.videoTaskId = "video-task";
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(recoverProject));
  const recoverQueue = createGenerationQueue(
    confirmGenerationPlan(directPlan, request()),
    { now: "2026-10-11T00:20:00.000Z" },
  );
  recoverQueue.queueId = "recover-queue";
  recoverQueue.runId = "recover-queue";
  recoverQueue.status = "processing";
  recoverQueue.shots["002"].status = "processing";
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

  const v6Folder = "山竹视频复刻/版本六队列";
  const v6Root = path.join(vault, ...v6Folder.split("/"));
  const v6MetadataRoot = path.join(v6Root, ".mangosteen");
  const v6LegacyWorkRoot = path.join(v6Root, ".work");
  fs.mkdirSync(path.join(v6MetadataRoot, "runs"), { recursive: true });
  fs.mkdirSync(v6LegacyWorkRoot, { recursive: true });
  fs.writeFileSync(path.join(v6MetadataRoot, "project.json"), JSON.stringify({
    schemaVersion: 6,
    folder: v6Folder,
    title: "版本六队列",
    status: "analysis_ready",
    statusText: "等待选择镜头",
    shots: request().shots.map((shot) => ({ ...shot, status: "等待生成" })),
  }));
  fs.writeFileSync(path.join(v6MetadataRoot, "draft.json"), JSON.stringify({ ...request(), schemaVersion: 6 }));
  const staleLegacyQueue = JSON.stringify({ queueId: "stale-legacy", status: "completed", shots: [] });
  const staleLegacyState = JSON.stringify({ status: "stopped", requestMtimeMs: 1, updatedAt: "2026-10-10T00:00:00.000Z" });
  fs.writeFileSync(path.join(v6LegacyWorkRoot, "generation-queue.json"), staleLegacyQueue);
  fs.writeFileSync(path.join(v6LegacyWorkRoot, "generation-state.json"), staleLegacyState);

  plugin.refreshGenerationModelCatalog = async () => ({
    imageModels: ["gpt-image-2-w"],
    videoModels: ["MiniMax-H3"],
  });

  const gateFolder = "山竹视频复刻/版本六提交闸门";
  const gateRoot = path.join(vault, ...gateFolder.split("/"));
  const gateMetadataRoot = path.join(gateRoot, ".mangosteen");
  fs.mkdirSync(path.join(gateMetadataRoot, "runs"), { recursive: true });
  fs.writeFileSync(path.join(gateMetadataRoot, "project.json"), JSON.stringify({
    schemaVersion: 6,
    folder: gateFolder,
    title: "版本六提交闸门",
    status: "analysis_ready",
    shots: request().shots.map((shot) => ({ ...shot, status: "等待生成" })),
  }));
  fs.writeFileSync(path.join(gateMetadataRoot, "draft.json"), JSON.stringify({ ...request(), schemaVersion: 6 }));
  const gatePreview = await plugin.previewWorkbenchGeneration(gateFolder, ["001"]);
  const gatePlan = confirmGenerationPlan(
    gatePreview,
    JSON.parse(fs.readFileSync(path.join(gateMetadataRoot, "draft.json"), "utf8")),
  );
  const makeGateRun = () => {
    const active = createGenerationQueue(gatePlan, { now: "2026-10-12T00:30:00.000Z" });
    active.queueId = "v6-linearizable-run";
    active.runId = "v6-linearizable-run";
    active.status = "processing";
    active.activeShotId = "001";
    active.revision = 7;
    active.shots["001"].status = "processing";
    active.shots["001"].stage = "provider-submission";
    return active;
  };
  const gateActiveRunPath = path.join(gateMetadataRoot, "active-run.json");
  fs.writeFileSync(gateActiveRunPath, JSON.stringify(makeGateRun()));
  plugin.queueApis.delete(gateFolder);
  plugin.activeQueueObjects.delete(gateFolder);
  assert.strictEqual(typeof plugin.recordPendingWorkbenchStop, "function", "v6 stop must durably record intent before waiting for the paid gate");

  const realAcquireSubmissionGate = plugin.acquireWorkbenchSubmissionGate.bind(plugin);
  let releaseStopGate;
  let stopGateAcquired;
  const stopGatePause = new Promise((resolve) => { releaseStopGate = resolve; });
  const stopGateReady = new Promise((resolve) => { stopGateAcquired = resolve; });
  let pauseFirstSubmissionGate = true;
  plugin.acquireWorkbenchSubmissionGate = async (...args) => {
    const lock = await realAcquireSubmissionGate(...args);
    if (pauseFirstSubmissionGate) {
      pauseFirstSubmissionGate = false;
      stopGateAcquired();
      await stopGatePause;
    }
    return lock;
  };
  const stopFirst = plugin.stopWorkbenchGeneration(gateFolder);
  await stopGateReady;
  let paidAfterStopWon = 0;
  const stoppedSubmission = plugin.withWorkbenchPaidSubmissionGate(gateFolder, {
    queueId: "v6-linearizable-run",
    runId: "v6-linearizable-run",
    revision: 7,
  }, async () => {
    paidAfterStopWon += 1;
    return { id: "must-not-submit" };
  });
  releaseStopGate();
  await stopFirst;
  await assert.rejects(stoppedSubmission, /已停止|停止后续付费/);
  assert.strictEqual(paidAfterStopWon, 0, "when stop acquires the shared gate first, the provider call must remain zero");
  plugin.acquireWorkbenchSubmissionGate = realAcquireSubmissionGate;

  const reverseRun = makeGateRun();
  fs.writeFileSync(gateActiveRunPath, JSON.stringify(reverseRun));
  plugin.queueApis.delete(gateFolder);
  plugin.activeQueueObjects.delete(gateFolder);
  let releaseAcceptedSubmission;
  let acceptedProviderCalled;
  const acceptedSubmissionPause = new Promise((resolve) => { releaseAcceptedSubmission = resolve; });
  const acceptedProviderStarted = new Promise((resolve) => { acceptedProviderCalled = resolve; });
  let paidBeforeStopWon = 0;
  const acceptedSubmission = plugin.withWorkbenchPaidSubmissionGate(gateFolder, {
    queueId: reverseRun.queueId,
    runId: reverseRun.runId,
    revision: reverseRun.revision,
    shotId: "001",
    boundary: "video-submission",
  }, async (_reserved, reservation) => {
    paidBeforeStopWon += 1;
    acceptedProviderCalled();
    await acceptedSubmissionPause;
    const authoritative = plugin.currentWorkbenchQueue(gateFolder);
    const accepted = runState.updateShotState(authoritative, "001", {
      status: "video-processing",
      stage: "provider-generation",
      taskId: "linearized-provider-task",
      paidTaskSubmitted: true,
      progress: null,
      submissionReservation: null,
      submissionUncertain: false,
      lastSubmissionResult: {
        runId: reverseRun.runId,
        shotId: "001",
        boundary: "video-submission",
        reservationId: reservation.reservationId,
        status: "resolved",
        resolvedAt: new Date().toISOString(),
      },
    });
    plugin.persistWorkbenchRun(plugin.workbenchProjectPaths(gateFolder), accepted);
    return { id: "linearized-provider-task" };
  });
  await acceptedProviderStarted;
  let reverseStopFinished = false;
  const reverseStop = plugin.stopWorkbenchGeneration(gateFolder).then((value) => {
    reverseStopFinished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(reverseStopFinished, false, "stop must wait while a paid submission owns the shared gate");
  releaseAcceptedSubmission();
  await acceptedSubmission;
  await reverseStop;
  assert.strictEqual(paidBeforeStopWon, 1, "when submission acquires first, exactly one paid call may linearize before stop");
  const stoppedAfterAccepted = JSON.parse(fs.readFileSync(gateActiveRunPath, "utf8"));
  assert.strictEqual(stoppedAfterAccepted.stopRequested, true);
  assert.strictEqual(stoppedAfterAccepted.shots["001"].taskId, "linearized-provider-task");
  assert.strictEqual(stoppedAfterAccepted.shots["001"].paidTaskSubmitted, true);

  const staleRunnerSave = makeGateRun();
  plugin.persistWorkbenchRun(plugin.workbenchProjectPaths(gateFolder), staleRunnerSave);
  const afterStaleRunnerSave = JSON.parse(fs.readFileSync(gateActiveRunPath, "utf8"));
  assert.strictEqual(afterStaleRunnerSave.stopRequested, true, "a stale runner save must not clear persisted stopRequested");
  assert.strictEqual(afterStaleRunnerSave.shots["001"].taskId, "linearized-provider-task", "a stale runner save must retain accepted recovery data");
  assert.strictEqual(afterStaleRunnerSave.shots["001"].paidTaskSubmitted, true);

  const newerRecoveryRun = runState.updateShotState(afterStaleRunnerSave, "001", {
    status: "recovery-pending",
    stage: "provider-generation",
    progress: 63,
    error: Object.assign(new Error("供应商查询结果暂不确定"), { code: "PROVIDER_QUERY_UNKNOWN", retryable: true }),
    recoveryContext: { pollAttempt: 6, lastProviderStatus: "unknown" },
  });
  plugin.persistWorkbenchRun(plugin.workbenchProjectPaths(gateFolder), newerRecoveryRun);
  const staleTerminalSave = makeGateRun();
  staleTerminalSave.revision = Math.max(0, newerRecoveryRun.revision - 1);
  staleTerminalSave.shots["001"].status = "failed";
  staleTerminalSave.shots["001"].error = { code: "STALE_FAILURE", message: "旧窗口误判失败" };
  plugin.persistWorkbenchRun(plugin.workbenchProjectPaths(gateFolder), staleTerminalSave);
  const afterStaleTerminalSave = JSON.parse(fs.readFileSync(gateActiveRunPath, "utf8"));
  assert.strictEqual(afterStaleTerminalSave.shots["001"].status, "recovery-pending");
  assert.strictEqual(afterStaleTerminalSave.shots["001"].progress, 63);
  assert.strictEqual(afterStaleTerminalSave.shots["001"].error.code, "PROVIDER_QUERY_UNKNOWN");
  assert.deepStrictEqual(afterStaleTerminalSave.shots["001"].recoveryContext, { pollAttempt: 6, lastProviderStatus: "unknown" });

  const staleGateRun = makeGateRun();
  fs.writeFileSync(gateActiveRunPath, JSON.stringify(staleGateRun));
  const gatePaths = plugin.workbenchProjectPaths(gateFolder, { createWorkDirectory: true });
  fs.writeFileSync(gatePaths.submissionGatePath, JSON.stringify({ token: "crashed-owner" }));
  const staleGateTime = new Date(Date.now() - 6 * 60 * 1000);
  fs.utimesSync(gatePaths.submissionGatePath, staleGateTime, staleGateTime);
  let reclaimedGateCalls = 0;
  await plugin.withWorkbenchSubmissionGate(gateFolder, async () => { reclaimedGateCalls += 1; });
  assert.strictEqual(reclaimedGateCalls, 1, "a crashed stale gate owner must not deadlock future submissions");
  assert.strictEqual(fs.existsSync(gatePaths.submissionGatePath), false, "the bounded gate must release after recovery");

  const crashRun = makeGateRun();
  fs.writeFileSync(gateActiveRunPath, JSON.stringify(crashRun));
  let firstCrashProviderCalls = 0;
  await assert.rejects(
    () => plugin.withWorkbenchPaidSubmissionGate(gateFolder, {
      queueId: crashRun.queueId,
      runId: crashRun.runId,
      revision: crashRun.revision,
      shotId: "001",
      boundary: "video-submission",
    }, async (reserved) => {
      const reservation = reserved.shots["001"].submissionReservation;
      assert.strictEqual(reservation.status, "submission-reserved", "reservation must be persisted before provider entry");
      firstCrashProviderCalls += 1;
      throw new Error("模拟 provider 返回后进程崩溃");
    }),
    /模拟 provider 返回后进程崩溃/,
  );
  assert.strictEqual(firstCrashProviderCalls, 1);
  const crashPersisted = JSON.parse(fs.readFileSync(gateActiveRunPath, "utf8"));
  assert.strictEqual(crashPersisted.shots["001"].submissionReservation.status, "submission-reserved");
  fs.writeFileSync(gatePaths.submissionGatePath, JSON.stringify({ token: "crashed-after-provider" }));
  fs.utimesSync(gatePaths.submissionGatePath, staleGateTime, staleGateTime);
  let secondWindowProviderCalls = 0;
  await assert.rejects(
    () => plugin.withWorkbenchPaidSubmissionGate(gateFolder, {
      queueId: crashRun.queueId,
      runId: crashRun.runId,
      revision: crashPersisted.revision,
      shotId: "001",
      boundary: "video-submission",
    }, async () => { secondWindowProviderCalls += 1; }),
    /UNSAFE_PAID_SUBMISSION_RECOVERY|人工检查|不再自动重提/,
  );
  assert.strictEqual(secondWindowProviderCalls, 0, "stale gate cleanup must not authorize resubmission past an unresolved reservation");

  const pendingRun = makeGateRun();
  fs.writeFileSync(gateActiveRunPath, JSON.stringify(pendingRun));
  plugin.submissionGateTimeoutMs = 30;
  let releaseLongGate;
  let longGateStarted;
  const longGatePause = new Promise((resolve) => { releaseLongGate = resolve; });
  const longGateReady = new Promise((resolve) => { longGateStarted = resolve; });
  const longGate = plugin.withWorkbenchSubmissionGate(gateFolder, async () => {
    longGateStarted();
    await longGatePause;
  });
  await longGateReady;
  await assert.rejects(
    () => plugin.stopWorkbenchGeneration(gateFolder),
    (error) => error?.code === "SUBMISSION_GATE_TIMEOUT",
    "stop may time out waiting for a long provider operation but its intent must remain durable",
  );
  const pendingStopPath = plugin.workbenchProjectPaths(gateFolder).pendingStopPath;
  assert.strictEqual(fs.existsSync(pendingStopPath), true, "timed-out stop intent must remain on disk");
  releaseLongGate();
  await longGate;
  const stoppedAfterTimeout = JSON.parse(fs.readFileSync(gateActiveRunPath, "utf8"));
  assert.strictEqual(stoppedAfterTimeout.stopRequested, true, "gate holder must merge pending stop before release");
  assert.strictEqual(fs.existsSync(pendingStopPath), false, "pending intent clears only after active-run records the stop");
  delete plugin.submissionGateTimeoutMs;

  const originalPaidGateMethod = plugin.withWorkbenchPaidSubmissionGate;
  const originalEnsureBoundaryAsset = plugin.ensureReferenceAsset;
  const originalGenerateBoundaryImage = plugin.generateImageMulti;
  const originalSaveBoundaryImage = plugin.saveImageCandidate;
  const originalLocalBoundaryImage = plugin.localImage;
  const originalCopyBoundaryFile = plugin.copyVaultFile;
  const originalWaitBoundaryVideo = plugin.waitForVideo;
  const originalBoundaryRuntime = plugin.resolveQueueGenerationRuntime;
  const writeBoundaryProject = (name) => {
    const caseFolder = `山竹视频复刻/${name}`;
    const caseRoot = path.join(vault, ...caseFolder.split("/"));
    fs.mkdirSync(path.join(caseRoot, ".mangosteen/runs"), { recursive: true });
    fs.writeFileSync(path.join(caseRoot, ".mangosteen/project.json"), JSON.stringify({
      schemaVersion: 6,
      folder: caseFolder,
      title: name,
      status: "analysis_ready",
      shots: request().shots.map((shot) => ({ ...shot, status: "等待生成" })),
    }));
    fs.writeFileSync(path.join(caseRoot, ".mangosteen/draft.json"), JSON.stringify({ ...request(), schemaVersion: 6 }));
    return { caseFolder, caseRoot };
  };
  const readBoundaryArchive = (caseRoot) => {
    const runsRoot = path.join(caseRoot, ".mangosteen/runs");
    const names = fs.readdirSync(runsRoot).filter((name) => name.endsWith(".json"));
    assert.strictEqual(names.length, 1, "each real-path case must archive exactly one terminal run");
    return JSON.parse(fs.readFileSync(path.join(runsRoot, names[0]), "utf8"));
  };
  const configureBoundaryProviders = ({ targetBoundary, pauseTarget = false }) => {
    const calls = { references: 0, images: 0, videos: 0 };
    let releaseTarget;
    let targetReached;
    let targetSeen = false;
    const targetPause = new Promise((resolve) => { releaseTarget = resolve; });
    const targetReady = new Promise((resolve) => { targetReached = resolve; });
    const pause = async (kind) => {
      if (!pauseTarget || targetSeen || kind !== targetBoundary) return;
      targetSeen = true;
      targetReached();
      await targetPause;
    };
    plugin.ensureReferenceAsset = async (_image, asset) => {
      calls.references += 1;
      await pause("reference-asset");
      return {
        ...asset,
        imagePath: `山竹视频资产库/${asset.kind}/${asset.id}.png`,
        metadataPath: `山竹视频资产库/${asset.kind}/${asset.id}.json`,
        contentHash: `${asset.kind}-${asset.id}-hash`,
        reused: false,
      };
    };
    plugin.generateImageMulti = async () => {
      calls.images += 1;
      await pause(calls.images === 1 ? "first-frame" : "last-frame");
      return { kind: "base64", value: "eA==" };
    };
    plugin.saveImageCandidate = async (_image, _candidate, targetPath) => targetPath;
    plugin.localImage = (vaultPath) => ({ vaultPath });
    plugin.copyVaultFile = (_source, targetPath) => targetPath;
    plugin.waitForVideo = async () => ({ localPath: "/tmp/completed-boundary.mp4" });
    plugin.resolveQueueGenerationRuntime = async () => ({
      image: {},
      video: {
        submitVideo: async () => {
          calls.videos += 1;
          await pause("video-submission");
          return { id: `task-${targetBoundary}` };
        },
      },
      imageModel: "gpt-image-2-w",
      model: "MiniMax-H3",
      resolution: "768p",
    });
    return { calls, targetReady, releaseTarget };
  };
  const stopFirstExpectations = {
    "reference-asset": { references: 0, images: 0, videos: 0 },
    "first-frame": { references: 2, images: 0, videos: 0 },
    "last-frame": { references: 2, images: 1, videos: 0 },
    "video-submission": { references: 2, images: 2, videos: 0 },
  };
  for (const [targetBoundary, expectedCalls] of Object.entries(stopFirstExpectations)) {
    const { caseFolder, caseRoot } = writeBoundaryProject(`真实停止优先-${targetBoundary}`);
    const { calls } = configureBoundaryProviders({ targetBoundary });
    let stopInjected = false;
    plugin.withWorkbenchPaidSubmissionGate = async function stopBeforeProvider(folderName, identity, operation) {
      if (folderName === caseFolder && identity.boundary === targetBoundary && !stopInjected) {
        stopInjected = true;
        this.recordPendingWorkbenchStop(this.workbenchProjectPaths(folderName), identity);
        await this.withWorkbenchSubmissionGate(folderName, async () => {});
      }
      return originalPaidGateMethod.call(this, folderName, identity, operation);
    };
    const preview = await plugin.previewWorkbenchGeneration(caseFolder, ["002"]);
    await plugin.startWorkbenchGeneration(caseFolder, preview);
    await plugin.queueRuns.get(caseFolder);
    assert.deepStrictEqual(calls, expectedCalls, `${targetBoundary} stop-first must block its real provider call`);
    const archived = readBoundaryArchive(caseRoot);
    assert.strictEqual(archived.stopRequested, true);
    assert.strictEqual(archived.shots["002"].status, "stopped", `${targetBoundary} stop-first must end stopped, not failed`);
  }
  plugin.withWorkbenchPaidSubmissionGate = originalPaidGateMethod;

  for (const targetBoundary of Object.keys(stopFirstExpectations)) {
    const { caseFolder, caseRoot } = writeBoundaryProject(`真实提交优先-${targetBoundary}`);
    const { calls, targetReady, releaseTarget } = configureBoundaryProviders({ targetBoundary, pauseTarget: true });
    const preview = await plugin.previewWorkbenchGeneration(caseFolder, ["002"]);
    await plugin.startWorkbenchGeneration(caseFolder, preview);
    const run = plugin.queueRuns.get(caseFolder);
    await targetReady;
    if (targetBoundary === "reference-asset") plugin.submissionGateTimeoutMs = 30;
    const stop = plugin.stopWorkbenchGeneration(caseFolder);
    const stopResult = targetBoundary === "reference-asset"
      ? assert.rejects(stop, (error) => error?.code === "SUBMISSION_GATE_TIMEOUT")
      : stop;
    if (targetBoundary === "reference-asset") {
      await stopResult;
      assert.strictEqual(fs.existsSync(plugin.workbenchProjectPaths(caseFolder).pendingStopPath), true);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(fs.existsSync(plugin.workbenchProjectPaths(caseFolder).pendingStopPath), true);
    }
    releaseTarget();
    if (targetBoundary !== "reference-asset") await stopResult;
    await run;
    delete plugin.submissionGateTimeoutMs;
    assert.strictEqual(
      targetBoundary === "reference-asset" ? calls.references
        : targetBoundary === "first-frame" ? calls.images
          : targetBoundary === "last-frame" ? calls.images
            : calls.videos,
      targetBoundary === "last-frame" ? 2 : 1,
      `${targetBoundary} submission-first must execute its target provider operation exactly once`,
    );
    const archived = readBoundaryArchive(caseRoot);
    assert.strictEqual(archived.stopRequested, true, `${targetBoundary} holder must merge pending stop before release`);
    if (targetBoundary === "video-submission") {
      assert.strictEqual(archived.shots["002"].taskId, "task-video-submission");
      assert.strictEqual(archived.shots["002"].paidTaskSubmitted, true);
    }
  }

  const { caseFolder: crashChainFolder, caseRoot: crashChainRoot } = writeBoundaryProject("真实提交返回后崩溃");
  const crashChain = configureBoundaryProviders({ targetBoundary: "video-submission" });
  let crashChainProviderReturned = false;
  plugin.resolveQueueGenerationRuntime = async () => ({
    image: {},
    video: {
      submitVideo: async () => {
        crashChain.calls.videos += 1;
        crashChainProviderReturned = true;
        return { id: "task-crash-after-accept" };
      },
    },
    imageModel: "gpt-image-2-w",
    model: "MiniMax-H3",
    resolution: "768p",
  });
  const originalPersistWorkbenchRun = plugin.persistWorkbenchRun;
  plugin.persistWorkbenchRun = function failAcceptedResolution(paths, queue) {
    const shot = queue?.shots?.["002"];
    if (crashChainProviderReturned
      && shot?.lastSubmissionResult?.boundary === "video-submission"
      && shot?.submissionReservation == null) {
      throw new Error("模拟 provider 已接受后、active-run 确认前崩溃");
    }
    return originalPersistWorkbenchRun.call(this, paths, queue);
  };
  const crashPreview = await plugin.previewWorkbenchGeneration(crashChainFolder, ["002"]);
  await plugin.startWorkbenchGeneration(crashChainFolder, crashPreview);
  await assert.rejects(
    plugin.queueRuns.get(crashChainFolder),
    /模拟 provider 已接受后、active-run 确认前崩溃/,
  );
  plugin.persistWorkbenchRun = originalPersistWorkbenchRun;
  assert.strictEqual(crashChain.calls.videos, 1);
  const crashChainActivePath = path.join(crashChainRoot, ".mangosteen/active-run.json");
  const unresolvedAfterCrash = JSON.parse(fs.readFileSync(crashChainActivePath, "utf8"));
  assert.strictEqual(unresolvedAfterCrash.shots["002"].submissionReservation.boundary, "video-submission");
  assert.strictEqual(unresolvedAfterCrash.shots["002"].taskId, "task-crash-after-accept");
  assert.strictEqual(unresolvedAfterCrash.shots["002"].paidTaskSubmitted, true);
  plugin.queueApis.delete(crashChainFolder);
  plugin.activeQueueObjects.delete(crashChainFolder);
  plugin.queueRuns.delete(crashChainFolder);
  let secondWindowSubmissions = 0;
  let secondWindowQueries = 0;
  plugin.resolveQueueGenerationRuntime = async () => ({
    image: {},
    video: { submitVideo: async () => { secondWindowSubmissions += 1; return { id: "must-not-resubmit" }; } },
    imageModel: "gpt-image-2-w",
    model: "MiniMax-H3",
    resolution: "768p",
  });
  plugin.waitForVideo = async () => {
    secondWindowQueries += 1;
    throw new Error("未决 reservation 不应自动查询或重提");
  };
  const crashRecoveryStarted = await plugin.recoverWorkbenchQueue(crashChainFolder);
  if (crashRecoveryStarted) await plugin.queueRuns.get(crashChainFolder)?.catch(() => {});
  assert.strictEqual(crashRecoveryStarted, false, "unresolved paid reservation must fail closed during restart recovery");
  assert.strictEqual(secondWindowSubmissions, 0);
  assert.strictEqual(secondWindowQueries, 0);
  const crashRecoveryState = JSON.parse(fs.readFileSync(crashChainActivePath, "utf8"));
  assert.strictEqual(crashRecoveryState.shots["002"].status, "recovery-pending");
  assert.strictEqual(crashRecoveryState.shots["002"].error.code, "UNSAFE_PAID_SUBMISSION_RECOVERY");
  assert.strictEqual(crashRecoveryState.shots["002"].submissionReservation.boundary, "video-submission");

  plugin.ensureReferenceAsset = originalEnsureBoundaryAsset;
  plugin.generateImageMulti = originalGenerateBoundaryImage;
  plugin.saveImageCandidate = originalSaveBoundaryImage;
  plugin.localImage = originalLocalBoundaryImage;
  plugin.copyVaultFile = originalCopyBoundaryFile;
  plugin.waitForVideo = originalWaitBoundaryVideo;
  plugin.resolveQueueGenerationRuntime = originalBoundaryRuntime;
  fs.rmSync(gateRoot, { recursive: true, force: true });

  const v6Plan = await plugin.previewWorkbenchGeneration(v6Folder, ["001", "002"]);
  let releaseV6AcceptedTask;
  let v6AcceptedTaskReached;
  const v6AcceptedTaskGate = new Promise((resolve) => { releaseV6AcceptedTask = resolve; });
  const v6AcceptedTaskStarted = new Promise((resolve) => { v6AcceptedTaskReached = resolve; });
  const v6Submitted = [];
  plugin.runWorkbenchQueueShot = async (_folder, shot, context) => {
    v6Submitted.push(shot.id);
    await context.updateState({
      status: "video-processing",
      stage: "provider-generation",
      taskId: `v6-task-${shot.id}`,
      progress: shot.id === "001" ? 37 : null,
      elapsedMs: 1200,
      error: shot.id === "001" ? {
        code: "PROVIDER_QUERY_RETRY",
        source: "video-provider",
        stage: "provider-generation",
        message: "上一次查询结果不确定",
        action: "继续查询同一任务",
        retryable: true,
        paidTaskSubmitted: true,
      } : null,
      recoveryContext: shot.id === "001" ? { pollAttempt: 3, lastProviderStatus: "unknown" } : null,
    });
    if (shot.id === "001") {
      v6AcceptedTaskReached();
      await v6AcceptedTaskGate;
    }
    return { videoPath: `${v6Folder}/03-分镜/${shot.id}/视频.mp4` };
  };
  const v6QueuedSnapshot = await plugin.startWorkbenchGeneration(v6Folder, v6Plan);
  await v6AcceptedTaskStarted;
  const activeRunPath = path.join(v6MetadataRoot, "active-run.json");
  assert.strictEqual(fs.existsSync(activeRunPath), true, "version 6 queues must persist only to active-run.json");
  const acceptedActiveRun = JSON.parse(fs.readFileSync(activeRunPath, "utf8"));
  assert.strictEqual(acceptedActiveRun.shots["001"].taskId, "v6-task-001");
  assert.strictEqual(acceptedActiveRun.shots["001"].paidTaskSubmitted, true);
  assert.strictEqual(acceptedActiveRun.shots["001"].progress, 37);
  const loadedV6 = plugin.loadWorkbenchProject(v6Folder);
  assert.strictEqual(loadedV6.currentRun.status, "processing", "active-run must override a stale legacy stopped state");
  assert.strictEqual(loadedV6.generationQueue.status, "processing", "the UI compatibility view must come from selectCurrentRun");
  assert.strictEqual(loadedV6.generationQueue.shots[0].status, "processing", "the compatibility view must keep the active shot locked without interpreting provider stages");
  assert.deepStrictEqual(loadedV6.generationState, {}, "the UI must not compare the raw stale generation state itself");
  plugin.activeQueueObjects.set(v6Folder, JSON.parse(JSON.stringify(v6QueuedSnapshot)));
  await plugin.stopWorkbenchGeneration(v6Folder);
  const stoppingActiveRun = JSON.parse(fs.readFileSync(activeRunPath, "utf8"));
  assert.strictEqual(stoppingActiveRun.status, "stopping");
  assert.strictEqual(stoppingActiveRun.shots["001"].taskId, "v6-task-001", "stop must retain accepted provider recovery data");
  assert.strictEqual(stoppingActiveRun.shots["001"].paidTaskSubmitted, true);
  assert.strictEqual(stoppingActiveRun.shots["001"].progress, 37, "a stale window stop must not regress provider progress");
  assert.strictEqual(stoppingActiveRun.shots["001"].error.code, "PROVIDER_QUERY_RETRY", "a stale window stop must preserve normalized errors");
  assert.deepStrictEqual(
    stoppingActiveRun.shots["001"].recoveryContext,
    { pollAttempt: 3, lastProviderStatus: "unknown" },
    "a stale window stop must preserve recovery context",
  );
  releaseV6AcceptedTask();
  await plugin.queueRuns.get(v6Folder);
  assert.deepStrictEqual(v6Submitted, ["001"], "stop must block only the future paid submission");
  assert.strictEqual(fs.existsSync(activeRunPath), false, "the active pointer must be removed after archive succeeds");
  const archivedRuns = fs.readdirSync(path.join(v6MetadataRoot, "runs")).filter((name) => name.endsWith(".json"));
  assert.strictEqual(archivedRuns.length, 1);
  const archivedRun = JSON.parse(fs.readFileSync(path.join(v6MetadataRoot, "runs", archivedRuns[0]), "utf8"));
  assert.strictEqual(archivedRun.status, "stopped");
  assert.strictEqual(archivedRun.shots["001"].taskId, "v6-task-001");
  assert.strictEqual(fs.readFileSync(path.join(v6LegacyWorkRoot, "generation-queue.json"), "utf8"), staleLegacyQueue);
  assert.strictEqual(fs.readFileSync(path.join(v6LegacyWorkRoot, "generation-state.json"), "utf8"), staleLegacyState);
  const afterV6Archive = plugin.loadWorkbenchProject(v6Folder);
  assert.strictEqual(afterV6Archive.currentRun, null, "a version 6 project must not revive stale legacy state after its active run is archived");
  assert.deepStrictEqual(afterV6Archive.generationQueue, {});
  assert.deepStrictEqual(afterV6Archive.generationState, {});

  const retainedPointerAfterArchive = { ...archivedRun };
  delete retainedPointerAfterArchive.archivedAt;
  fs.writeFileSync(activeRunPath, `${JSON.stringify(retainedPointerAfterArchive, null, 2)}\n`);
  plugin.archiveWorkbenchRun(
    plugin.workbenchProjectPaths(v6Folder),
    retainedPointerAfterArchive,
    "2026-10-12T00:00:00.000Z",
  );
  assert.strictEqual(fs.existsSync(activeRunPath), false, "an archive retry must clear a pointer left behind after a successful archive write");

  const v6RecoveryPreview = await plugin.previewWorkbenchGeneration(v6Folder, ["001"]);
  const v6RecoveryPlan = confirmGenerationPlan(
    v6RecoveryPreview,
    JSON.parse(fs.readFileSync(path.join(v6MetadataRoot, "draft.json"), "utf8")),
  );
  const v6RecoveryRun = createGenerationQueue(v6RecoveryPlan, { now: "2026-10-12T00:00:01.000Z" });
  v6RecoveryRun.queueId = "v6-active-run-recovery";
  v6RecoveryRun.runId = "v6-active-run-recovery";
  v6RecoveryRun.status = "processing";
  v6RecoveryRun.activeShotId = "001";
  v6RecoveryRun.shots["001"].status = "video-processing";
  v6RecoveryRun.shots["001"].stage = "provider-generation";
  v6RecoveryRun.shots["001"].taskId = "active-run-only-task";
  v6RecoveryRun.shots["001"].paidTaskSubmitted = true;
  const v6RecoveryProject = JSON.parse(fs.readFileSync(path.join(v6MetadataRoot, "project.json"), "utf8"));
  const v6RecoveryProjectShot = v6RecoveryProject.shots.find((shot) => shot.id === "001");
  v6RecoveryProjectShot.videoPath = "";
  v6RecoveryProjectShot.videoTaskId = "";
  v6RecoveryProjectShot.videoTaskPlanId = "";
  fs.writeFileSync(path.join(v6MetadataRoot, "project.json"), JSON.stringify(v6RecoveryProject));
  fs.writeFileSync(activeRunPath, JSON.stringify(v6RecoveryRun));
  plugin.queueApis.delete(v6Folder);
  plugin.activeQueueObjects.delete(v6Folder);
  plugin.runWorkbenchQueueShot = realRunWorkbenchQueueShot;
  let recoveredActiveRunTaskId = "";
  const paidSubmissionsBeforeActiveRunRecovery = submittedVideoOptions.length;
  plugin.waitForVideo = async (_videoPlugin, taskId) => {
    recoveredActiveRunTaskId = taskId;
    return { localPath: "山竹视频资产库/recovered-active-run.mp4" };
  };
  assert.strictEqual(await plugin.recoverWorkbenchQueue(v6Folder), true, "v6 recovery must trust its confirmed active-run task ID");
  await plugin.queueRuns.get(v6Folder);
  assert.strictEqual(recoveredActiveRunTaskId, "active-run-only-task");
  assert.strictEqual(submittedVideoOptions.length, paidSubmissionsBeforeActiveRunRecovery, "active-run task recovery must not resubmit paid work");
  const recoveredArchive = fs.readdirSync(path.join(v6MetadataRoot, "runs"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(v6MetadataRoot, "runs", name), "utf8")))
    .find((run) => run.runId === "v6-active-run-recovery");
  assert(recoveredArchive, "the recovered active run must archive after the existing task completes");
  assert.notStrictEqual(recoveredArchive.shots["001"].error?.code, "UNSAFE_PAID_TASK_RECOVERY");

  plugin.queueApis.delete(v6Folder);
  const archiveFailurePlan = await plugin.previewWorkbenchGeneration(v6Folder, ["001"]);
  plugin.runWorkbenchQueueShot = async (_folder, shot, context) => {
    await context.updateState({
      status: "video-processing",
      stage: "provider-generation",
      taskId: "v6-archive-failure-task",
      progress: null,
    });
    return { videoPath: `${v6Folder}/03-分镜/${shot.id}/视频.mp4` };
  };
  const originalAtomicWriteJson = projectStorage.atomicWriteJson;
  projectStorage.atomicWriteJson = (options) => {
    if (String(options?.relativePath || "").includes("/.mangosteen/runs/")) throw new Error("injected archive failure");
    return originalAtomicWriteJson(options);
  };
  try {
    await plugin.startWorkbenchGeneration(v6Folder, archiveFailurePlan);
    await assert.rejects(plugin.queueRuns.get(v6Folder), /injected archive failure/);
  } finally {
    projectStorage.atomicWriteJson = originalAtomicWriteJson;
  }
  assert.strictEqual(fs.existsSync(activeRunPath), true, "archive failure must keep the terminal active run for recovery");
  const retainedAfterArchiveFailure = JSON.parse(fs.readFileSync(activeRunPath, "utf8"));
  assert.strictEqual(retainedAfterArchiveFailure.shots["001"].taskId, "v6-archive-failure-task");
  assert.strictEqual(retainedAfterArchiveFailure.shots["001"].paidTaskSubmitted, true);
  assert.strictEqual(await plugin.recoverWorkbenchQueue(v6Folder), false, "terminal recovery performs no paid work");
  assert.strictEqual(fs.existsSync(activeRunPath), false, "a later recovery pass must retry a previously failed archive before allowing another run");

  const syncScriptPath = path.resolve(__dirname, "../../../scripts/sync-plugin-code-to-vault.sh");
  if (fs.existsSync(syncScriptPath)) {
    const syncScript = fs.readFileSync(syncScriptPath, "utf8");
    assert.match(syncScript, /generation-queue\.cjs/, "live-vault sync must include the queue engine");
    assert.match(syncScript, /run-state\.cjs/, "live-vault sync must include the active-run state model");
    assert.match(syncScript, /replica-logic-api\.cjs/, "live-vault sync must include the queue facade");
    assert.match(syncScript, /workbench-queue-plugin\.test\.cjs/, "live-vault sync must include its queue regression test");
  }

  fs.rmSync(vault, { recursive: true, force: true });
  console.log("workbench-queue-plugin: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
