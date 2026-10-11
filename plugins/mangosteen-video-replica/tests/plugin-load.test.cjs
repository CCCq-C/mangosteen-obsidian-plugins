const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { createReplicaLogicApi } = require("../replica-logic-api.cjs");

assert.strictEqual(typeof createReplicaLogicApi, "function");
assert.doesNotMatch(
  fs.readFileSync(path.resolve(__dirname, "../replica-logic-api.cjs"), "utf8"),
  /require\(["']obsidian["']\)/,
  "the logic API must stay reusable outside Obsidian UI code",
);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      ItemView: class ItemView {
        constructor(leaf) { this.leaf = leaf; }
      },
      Modal: class Modal {},
      Notice: class Notice {},
      Plugin: class Plugin {},
      requestUrl: async () => ({ status: 200, arrayBuffer: new ArrayBuffer(0) }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ReplicaPlugin = require("../main.js");
const replicaCore = require("../replica-core.cjs");
const replicaEditor = require("../replica-editor.cjs");
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
  const vaultEvents = {};
  const registeredViews = [];
  const workbenchLeaves = [];
  const workbenchView = {
    refreshCalls: 0,
    requestRefresh() { this.refreshCalls += 1; },
  };
  let openedViewState = null;
  let revealedLeaf = null;
  let setViewStateCalls = 0;
  const workbenchLeaf = {
    view: workbenchView,
    async setViewState(state) {
      setViewStateCalls += 1;
      openedViewState = state;
      workbenchLeaves.push(this);
    },
  };
  const workspace = {
    getLeavesOfType: (type) => type === "mangosteen-video-replica-workbench" ? workbenchLeaves : [],
    getLeaf: () => workbenchLeaf,
    revealLeaf: async (leaf) => { revealedLeaf = leaf; },
  };
  plugin.app = {
    vault: {
      adapter: { getBasePath: () => realVault },
      on: (event, handler) => { vaultEvents[event] = handler; return {}; },
    },
    workspace,
  };
  plugin.manifest = { dir: "plugins/mangosteen-video-replica" };
  const commandIds = [];
  const registeredIntervals = [];
  const registeredCleanups = [];
  const timeoutCallbacks = new Map();
  const clearedTimeouts = [];
  let nextTimeoutId = 10;
  plugin.addRibbonIcon = plugin.registerEvent = () => {};
  plugin.registerInterval = (id) => { registeredIntervals.push(id); };
  plugin.register = (cleanup) => { registeredCleanups.push(cleanup); };
  plugin.addCommand = (command) => { commandIds.push(command.id); };
  plugin.registerView = (type, creator) => { registeredViews.push({ type, creator }); };
  global.window = {
    setInterval: (_callback, delay) => ({ kind: "interval", delay }),
    setTimeout: (callback, delay) => {
      const id = nextTimeoutId++;
      timeoutCallbacks.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => { clearedTimeouts.push(id); timeoutCallbacks.delete(id); },
  };
  await plugin.onload();
  assert.strictEqual(registeredIntervals.length, 1);
  assert.strictEqual(registeredIntervals[0].delay, 5000, "background scanning must keep the registered 5-second interval");
  assert.strictEqual(timeoutCallbacks.size, 1);
  const [[startupTimeoutId, startupTimeout]] = timeoutCallbacks.entries();
  assert.strictEqual(startupTimeout.delay, 1500);
  assert.strictEqual(registeredCleanups.length, 1, "startup scanning timeout must register lifecycle cleanup");
  let startupScans = 0;
  const originalScanRequests = plugin.scanRequests;
  plugin.scanRequests = async () => { startupScans += 1; };
  registeredCleanups[0]();
  assert.deepStrictEqual(clearedTimeouts, [startupTimeoutId]);
  timeoutCallbacks.get(startupTimeoutId)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(startupScans, 0, "unloading before the startup timeout must prevent scanning and paid processing");
  plugin.scanRequests = originalScanRequests;
  assert.strictEqual(registeredViews.length, 1);
  assert.strictEqual(registeredViews[0].type, "mangosteen-video-replica-workbench");
  assert(commandIds.includes("open-video-replica-workbench"));
  assert(commandIds.includes("analyze-latest-project"));
  assert(commandIds.includes("select-analysis-model"));
  assert(commandIds.includes("select-generation-models"));
  assert(commandIds.includes("confirm-latest-generation"));
  assert(commandIds.includes("concat-latest-project"));
  assert(commandIds.includes("stop-latest-generation"));
  await plugin.activateWorkbench();
  assert.deepStrictEqual(openedViewState, {
    type: "mangosteen-video-replica-workbench",
    active: true,
  });
  assert.strictEqual(revealedLeaf, workbenchLeaf);
  await plugin.activateWorkbench();
  assert.strictEqual(setViewStateCalls, 1, "opening the cockpit twice must reuse its native ItemView leaf");
  const refreshCallsBeforeModify = workbenchView.refreshCalls;
  vaultEvents.modify({ name: "project.json", path: "山竹视频复刻/事件刷新/project.json" });
  assert.strictEqual(workbenchView.refreshCalls, refreshCallsBeforeModify + 1);
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
  plugin.app = { vault: { adapter: { getBasePath: () => vault } }, workspace };
  plugin.processing = new Set();

  const workbenchFolder = "山竹视频复刻/驾驶舱草案";
  const workbenchRoot = path.join(vault, ...workbenchFolder.split("/"));
  const workbenchRequestPath = path.join(workbenchRoot, "generation-request.json");
  const workbenchStatePath = path.join(workbenchRoot, ".work/generation-state.json");
  fs.mkdirSync(path.dirname(workbenchStatePath), { recursive: true });
  fs.writeFileSync(path.join(workbenchRoot, "project.json"), JSON.stringify({
    folder: workbenchFolder,
    title: "驾驶舱草案",
    status: "analysis_ready",
    shots: [
      {
        id: "001",
        title: "A 旧标题",
        firstImagePath: `${workbenchFolder}/02-分镜脚本/A.png`,
        videoPath: `${workbenchFolder}/03-视频片段/A.mp4`,
        generationFingerprint: "fingerprint-A",
      },
      {
        id: "001",
        title: "B 旧标题",
        firstImagePath: `${workbenchFolder}/02-分镜脚本/B.png`,
        videoPath: `${workbenchFolder}/03-视频片段/B.mp4`,
        generationFingerprint: "fingerprint-B",
      },
    ],
  }));
  const workbenchDraft = {
    version: 3,
    confirmed: false,
    character: { id: "hero", prompt: "固定人物参考板", voiceProfile: "轻微四川口音" },
    products: [],
    scenes: [{ id: "studio", prompt: "纯环境摄影棚" }],
    settings: { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
    shots: [
      {
        id: "001",
        title: "A 草案",
        duration: 4,
        sceneId: "studio",
        productIds: [],
        dialogue: "A 台词",
        voiceDirection: "A 语气",
        plot: "A 动作",
        environment: "摄影棚",
        camera: "中景固定",
        imagePrompt: "A 首帧",
        lastImagePrompt: "",
        videoPrompt: "A 视频",
      },
      {
        id: "001",
        title: "B 草案",
        duration: 5,
        sceneId: "studio",
        productIds: [],
        dialogue: "B 台词",
        voiceDirection: "B 语气",
        plot: "B 动作",
        environment: "摄影棚",
        camera: "近景固定",
        imagePrompt: "B 首帧",
        lastImagePrompt: "",
        videoPrompt: "B 视频",
      },
    ],
  };
  fs.writeFileSync(workbenchRequestPath, JSON.stringify(workbenchDraft));

  const listedWorkbenchProject = plugin.listWorkbenchProjects().find((item) => item.folder === workbenchFolder);
  assert.deepStrictEqual(
    { folder: listedWorkbenchProject.folder, title: listedWorkbenchProject.title, status: listedWorkbenchProject.status },
    { folder: workbenchFolder, title: "驾驶舱草案", status: "analysis_ready" },
  );
  const loadedWorkbenchProject = await plugin.loadWorkbenchProject(workbenchFolder);
  assert.strictEqual(loadedWorkbenchProject.project.title, "驾驶舱草案");
  assert.strictEqual(loadedWorkbenchProject.requestMtimeMs, fs.statSync(workbenchRequestPath).mtimeMs);
  assert.deepStrictEqual(
    loadedWorkbenchProject.request.shots.map((shot) => shot.workbenchId),
    ["001", "001~2"],
    "duplicate legacy request IDs must become deterministic per-occurrence workbench identities",
  );

  const malformedFolder = "山竹视频复刻/损坏项目";
  const malformedRoot = path.join(vault, ...malformedFolder.split("/"));
  fs.mkdirSync(path.join(malformedRoot, ".work"), { recursive: true });
  fs.writeFileSync(path.join(malformedRoot, "project.json"), "{");
  fs.writeFileSync(path.join(malformedRoot, "generation-request.json"), "{");
  fs.writeFileSync(path.join(malformedRoot, ".work/generation-state.json"), "{");
  const malformed = await plugin.loadWorkbenchProject(malformedFolder);
  assert.deepStrictEqual(Object.keys(malformed.readErrors).sort(), ["generationState", "project", "request"]);

  const integratedWorkbenchView = registeredViews[0].creator({});
  integratedWorkbenchView.selectedFolder = workbenchFolder;
  integratedWorkbenchView.snapshot = loadedWorkbenchProject;
  integratedWorkbenchView.draft = loadedWorkbenchProject.request;
  integratedWorkbenchView.viewModel = { empty: false, locked: false, canConfirm: true };
  integratedWorkbenchView.render = () => {};
  integratedWorkbenchView.buildRenderSignature = () => "integration-test";
  let integratedViewReloads = 0;
  integratedWorkbenchView.refresh = async () => {
    const reloaded = await plugin.loadWorkbenchProject(workbenchFolder);
    integratedWorkbenchView.snapshot = reloaded;
    integratedWorkbenchView.draft = reloaded.request;
    integratedWorkbenchView.viewModel = { empty: false, locked: false, canConfirm: true };
    integratedViewReloads += 1;
  };
  integratedWorkbenchView.reorderShot(1, "up");
  integratedWorkbenchView.draft = replicaEditor.updateDraftField(
    integratedWorkbenchView.draft,
    { section: "shot", index: 0, field: "title" },
    "B 新标题",
  );
  integratedWorkbenchView.draft = replicaEditor.updateDraftField(
    integratedWorkbenchView.draft,
    { section: "shot", index: 0, field: "dialogue" },
    "B 已编辑",
  );
  integratedWorkbenchView.draft = replicaEditor.updateDraftField(
    integratedWorkbenchView.draft,
    { section: "shot", index: 1, field: "title" },
    "A 新标题",
  );
  integratedWorkbenchView.draft = replicaEditor.updateDraftField(
    integratedWorkbenchView.draft,
    { section: "shot", index: 1, field: "dialogue" },
    "A 已编辑",
  );
  integratedWorkbenchView.dirty = true;
  await integratedWorkbenchView.saveDraft();
  assert.strictEqual(integratedViewReloads, 1, "the real View save route must reload the persisted draft");
  const savedWorkbenchRequest = JSON.parse(fs.readFileSync(workbenchRequestPath, "utf8"));
  assert.strictEqual(savedWorkbenchRequest.confirmed, false);
  assert.deepStrictEqual(savedWorkbenchRequest.shots.map((shot) => ({
    id: shot.id,
    title: shot.title,
    workbenchId: shot.workbenchId,
  })), [
    { id: "001", title: "B 新标题", workbenchId: "001~2" },
    { id: "002", title: "A 新标题", workbenchId: "001" },
  ]);
  const savedWorkbenchProject = JSON.parse(fs.readFileSync(path.join(workbenchRoot, "project.json"), "utf8"));
  assert(savedWorkbenchProject.shots.every((shot) => Array.isArray(shot.timeline)), "saved structured timelines must be mirrored into project.json");
  assert.deepStrictEqual(savedWorkbenchProject.shots.map((shot) => ({
    title: shot.title,
    dialogue: shot.dialogue,
    workbenchId: shot.workbenchId,
    firstImagePath: shot.firstImagePath,
    videoPath: shot.videoPath,
    generationFingerprint: shot.generationFingerprint,
  })), [
    {
      title: "B 新标题",
      dialogue: "B 已编辑",
      workbenchId: "001~2",
      firstImagePath: `${workbenchFolder}/02-分镜脚本/B.png`,
      videoPath: `${workbenchFolder}/03-视频片段/B.mp4`,
      generationFingerprint: "fingerprint-B",
    },
    {
      title: "A 新标题",
      dialogue: "A 已编辑",
      workbenchId: "001",
      firstImagePath: `${workbenchFolder}/02-分镜脚本/A.png`,
      videoPath: `${workbenchFolder}/03-视频片段/A.mp4`,
      generationFingerprint: "fingerprint-A",
    },
  ], "reordering and editing must keep each logical shot's artifacts attached to its stable identity");

  const normalizedGenerationRequest = replicaCore.normalizeGenerationRequest({ ...savedWorkbenchRequest, confirmed: true });
  assert.deepStrictEqual(
    normalizedGenerationRequest.shots.map((shot) => shot.id),
    ["001", "002"],
    "internal workbench identity must not alter user-visible generation shot IDs",
  );
  assert(
    normalizedGenerationRequest.shots.every((shot) => !Object.prototype.hasOwnProperty.call(shot, "workbenchId")),
    "internal workbench identity must not enter normalized generation inputs",
  );

  const reloadedWorkbenchProject = await plugin.loadWorkbenchProject(workbenchFolder);
  assert.deepStrictEqual(
    reloadedWorkbenchProject.request.shots.map((shot) => shot.workbenchId),
    ["001~2", "001"],
    "saved workbench identities must survive reload in reordered order",
  );
  integratedWorkbenchView.draft = replicaEditor.updateDraftField(
    integratedWorkbenchView.draft,
    { section: "shot", index: 0, field: "title" },
    "B 二次编辑",
  );
  integratedWorkbenchView.dirty = true;
  await integratedWorkbenchView.saveDraft();
  assert.strictEqual(integratedViewReloads, 2, "the second real View save must reload the same stable identities");
  const secondSavedWorkbenchRequest = JSON.parse(fs.readFileSync(workbenchRequestPath, "utf8"));
  assert.deepStrictEqual(
    secondSavedWorkbenchRequest.shots.map((shot) => ({ id: shot.id, workbenchId: shot.workbenchId })),
    [
      { id: "001", workbenchId: "001~2" },
      { id: "002", workbenchId: "001" },
    ],
    "a second save must persist stable identities without renumbering them",
  );
  const secondSavedWorkbenchProject = JSON.parse(fs.readFileSync(path.join(workbenchRoot, "project.json"), "utf8"));
  assert.deepStrictEqual(secondSavedWorkbenchProject.shots.map((shot) => ({
    title: shot.title,
    workbenchId: shot.workbenchId,
    firstImagePath: shot.firstImagePath,
    videoPath: shot.videoPath,
    generationFingerprint: shot.generationFingerprint,
  })), [
    {
      title: "B 二次编辑",
      workbenchId: "001~2",
      firstImagePath: `${workbenchFolder}/02-分镜脚本/B.png`,
      videoPath: `${workbenchFolder}/03-视频片段/B.mp4`,
      generationFingerprint: "fingerprint-B",
    },
    {
      title: "A 新标题",
      workbenchId: "001",
      firstImagePath: `${workbenchFolder}/02-分镜脚本/A.png`,
      videoPath: `${workbenchFolder}/03-视频片段/A.mp4`,
      generationFingerprint: "fingerprint-A",
    },
  ], "reload and second save must keep artifacts with each duplicate-ID logical shot");

  fs.writeFileSync(workbenchRequestPath, JSON.stringify({ ...savedWorkbenchRequest, confirmed: true }));
  await assert.rejects(() => plugin.saveWorkbenchDraft(workbenchFolder, savedWorkbenchRequest), /已确认|不能编辑/);
  fs.writeFileSync(workbenchRequestPath, JSON.stringify(savedWorkbenchRequest));
  fs.writeFileSync(workbenchStatePath, JSON.stringify({ status: "processing", requestMtimeMs: fs.statSync(workbenchRequestPath).mtimeMs }));
  await assert.rejects(() => plugin.saveWorkbenchDraft(workbenchFolder, savedWorkbenchRequest), /生成中|不能编辑/);
  fs.writeFileSync(workbenchStatePath, JSON.stringify({ status: "processing", requestMtimeMs: fs.statSync(workbenchRequestPath).mtimeMs - 1 }));
  assert.doesNotThrow(() => plugin.currentWorkbenchLock(plugin.workbenchProjectPaths(workbenchFolder)), "old processing state must not lock a newer draft request");
  fs.writeFileSync(workbenchStatePath, JSON.stringify({ status: "ready" }));
  await assert.rejects(() => plugin.saveWorkbenchDraft("其他目录/越界项目", savedWorkbenchRequest), /山竹视频复刻/);
  await assert.rejects(() => plugin.saveWorkbenchDraft("山竹视频复刻/../越界项目", savedWorkbenchRequest), /不安全|山竹视频复刻/);
  await assert.rejects(() => plugin.stopWorkbenchGeneration("山竹视频复刻/../越界项目"), /不安全|山竹视频复刻/);

  const projectSymlinkVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-workbench-project-link-"));
  const projectSymlinkRoot = path.join(projectSymlinkVault, "山竹视频复刻");
  const escapedProjectOutside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-workbench-project-outside-"));
  fs.mkdirSync(projectSymlinkRoot, { recursive: true });
  const externalProjectBytes = JSON.stringify({ folder: "external", shots: [{ id: "001", title: "outside" }] });
  const externalRequestBytes = JSON.stringify(savedWorkbenchRequest);
  const externalStateBytes = JSON.stringify({ status: "processing", requestMtimeMs: 901 });
  fs.mkdirSync(path.join(escapedProjectOutside, ".work"), { recursive: true });
  fs.writeFileSync(path.join(escapedProjectOutside, "project.json"), externalProjectBytes);
  fs.writeFileSync(path.join(escapedProjectOutside, "generation-request.json"), externalRequestBytes);
  fs.writeFileSync(path.join(escapedProjectOutside, ".work/generation-state.json"), externalStateBytes);
  fs.symlinkSync(escapedProjectOutside, path.join(projectSymlinkRoot, "越界项目"), "dir");

  const rootSymlinkVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-workbench-root-link-"));
  const escapedRootOutside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-workbench-root-outside-"));
  const escapedRootProject = path.join(escapedRootOutside, "越界项目");
  fs.mkdirSync(escapedRootProject, { recursive: true });
  const rootExternalProjectBytes = JSON.stringify({ folder: "external-root", shots: [{ id: "001", title: "outside-root" }] });
  const rootExternalRequestBytes = JSON.stringify(savedWorkbenchRequest);
  const rootExternalStateBytes = JSON.stringify({ status: "processing", requestMtimeMs: 902 });
  fs.mkdirSync(path.join(escapedRootProject, ".work"), { recursive: true });
  fs.writeFileSync(path.join(escapedRootProject, "project.json"), rootExternalProjectBytes);
  fs.writeFileSync(path.join(escapedRootProject, "generation-request.json"), rootExternalRequestBytes);
  fs.writeFileSync(path.join(escapedRootProject, ".work/generation-state.json"), rootExternalStateBytes);
  fs.symlinkSync(escapedRootOutside, path.join(rootSymlinkVault, "山竹视频复刻"), "dir");

  const workSymlinkVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-workbench-work-link-"));
  const workSymlinkFolder = "山竹视频复刻/工作目录越界";
  const workSymlinkProject = path.join(workSymlinkVault, ...workSymlinkFolder.split("/"));
  const escapedWorkOutside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-workbench-work-outside-"));
  const workLinkProjectBytes = JSON.stringify({ folder: workSymlinkFolder, title: "工作目录越界", shots: [] });
  const workLinkRequestBytes = JSON.stringify(savedWorkbenchRequest);
  const workOutsideProjectBytes = JSON.stringify({ folder: "outside-work-project", untouched: true });
  const workOutsideRequestBytes = JSON.stringify({ outside: "request", untouched: true });
  const workOutsideStateBytes = JSON.stringify({ status: "processing", requestMtimeMs: 903, untouched: true });
  const workOutsideStopBytes = JSON.stringify({ requestMtimeMs: 1, requestedAt: "2026-10-11T00:00:00Z", untouched: true });
  fs.mkdirSync(workSymlinkProject, { recursive: true });
  fs.writeFileSync(path.join(workSymlinkProject, "project.json"), workLinkProjectBytes);
  fs.writeFileSync(path.join(workSymlinkProject, "generation-request.json"), workLinkRequestBytes);
  fs.writeFileSync(path.join(escapedWorkOutside, "project.json"), workOutsideProjectBytes);
  fs.writeFileSync(path.join(escapedWorkOutside, "generation-request.json"), workOutsideRequestBytes);
  fs.writeFileSync(path.join(escapedWorkOutside, "generation-state.json"), workOutsideStateBytes);
  fs.writeFileSync(path.join(escapedWorkOutside, "stop-request.json"), workOutsideStopBytes);
  fs.symlinkSync(escapedWorkOutside, path.join(workSymlinkProject, ".work"), "dir");

  const normalApp = plugin.app;
  try {
    plugin.app = { vault: { adapter: { getBasePath: () => projectSymlinkVault } }, workspace };
    assert.throws(() => plugin.loadWorkbenchProject("山竹视频复刻/越界项目"), /符号链接|范围|不安全/);
    await assert.rejects(() => plugin.saveWorkbenchDraft("山竹视频复刻/越界项目", savedWorkbenchRequest), /符号链接|范围|不安全/);
    await assert.rejects(() => plugin.confirmWorkbenchDraft("山竹视频复刻/越界项目"), /符号链接|范围|不安全/);
    await assert.rejects(() => plugin.stopWorkbenchGeneration("山竹视频复刻/越界项目"), /符号链接|范围|不安全/);
    assert.strictEqual(fs.readFileSync(path.join(escapedProjectOutside, "project.json"), "utf8"), externalProjectBytes);
    assert.strictEqual(fs.readFileSync(path.join(escapedProjectOutside, "generation-request.json"), "utf8"), externalRequestBytes);
    assert.strictEqual(fs.readFileSync(path.join(escapedProjectOutside, ".work/generation-state.json"), "utf8"), externalStateBytes);
    assert.strictEqual(fs.existsSync(path.join(escapedProjectOutside, ".work/stop-request.json")), false);

    plugin.app = { vault: { adapter: { getBasePath: () => rootSymlinkVault } }, workspace };
    assert.throws(() => plugin.listWorkbenchProjects(), /符号链接|范围|不安全/);
    assert.throws(() => plugin.loadWorkbenchProject("山竹视频复刻/越界项目"), /符号链接|范围|不安全/);
    await assert.rejects(() => plugin.prepareVideo("/tmp/must-not-be-opened.mp4"), /根目录|符号链接|范围|不安全/);
    await assert.rejects(() => plugin.saveWorkbenchDraft("山竹视频复刻/越界项目", savedWorkbenchRequest), /符号链接|范围|不安全/);
    await assert.rejects(() => plugin.confirmWorkbenchDraft("山竹视频复刻/越界项目"), /符号链接|范围|不安全/);
    await assert.rejects(() => plugin.stopWorkbenchGeneration("山竹视频复刻/越界项目"), /符号链接|范围|不安全/);
    assert.strictEqual(fs.readFileSync(path.join(escapedRootProject, "project.json"), "utf8"), rootExternalProjectBytes);
    assert.strictEqual(fs.readFileSync(path.join(escapedRootProject, "generation-request.json"), "utf8"), rootExternalRequestBytes);
    assert.strictEqual(fs.readFileSync(path.join(escapedRootProject, ".work/generation-state.json"), "utf8"), rootExternalStateBytes);
    assert.strictEqual(fs.existsSync(path.join(escapedRootProject, ".work/stop-request.json")), false);

    plugin.app = { vault: { adapter: { getBasePath: () => workSymlinkVault } }, workspace };
    assert.throws(() => plugin.loadWorkbenchProject(workSymlinkFolder), /工作目录|符号链接|范围|不安全/);
    await assert.rejects(() => plugin.stopWorkbenchGeneration(workSymlinkFolder), /工作目录|符号链接|范围|不安全/);
    assert.throws(
      () => plugin.writeState(workSymlinkFolder, { status: "processing", requestMtimeMs: 903 }),
      /工作目录|符号链接|范围|不安全/,
    );
    assert.strictEqual(fs.readFileSync(path.join(workSymlinkProject, "project.json"), "utf8"), workLinkProjectBytes);
    assert.strictEqual(fs.readFileSync(path.join(workSymlinkProject, "generation-request.json"), "utf8"), workLinkRequestBytes);
    assert.strictEqual(fs.readFileSync(path.join(escapedWorkOutside, "project.json"), "utf8"), workOutsideProjectBytes);
    assert.strictEqual(fs.readFileSync(path.join(escapedWorkOutside, "generation-request.json"), "utf8"), workOutsideRequestBytes);
    assert.strictEqual(fs.readFileSync(path.join(escapedWorkOutside, "generation-state.json"), "utf8"), workOutsideStateBytes);
    assert.strictEqual(fs.readFileSync(path.join(escapedWorkOutside, "stop-request.json"), "utf8"), workOutsideStopBytes);
  } finally {
    plugin.app = normalApp;
  }

  const projectJsonLinkFolder = "山竹视频复刻/项目文件链接";
  const projectJsonLinkRoot = path.join(vault, ...projectJsonLinkFolder.split("/"));
  const requestJsonLinkFolder = "山竹视频复刻/请求文件链接";
  const requestJsonLinkRoot = path.join(vault, ...requestJsonLinkFolder.split("/"));
  const jsonLinkOutside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-project-json-outside-"));
  const outsideProjectJson = path.join(jsonLinkOutside, "project.json");
  const outsideRequestJson = path.join(jsonLinkOutside, "generation-request.json");
  const outsideProjectJsonBytes = JSON.stringify({ folder: "outside", untouched: true });
  const outsideRequestJsonBytes = JSON.stringify(savedWorkbenchRequest);
  fs.mkdirSync(projectJsonLinkRoot, { recursive: true });
  fs.mkdirSync(requestJsonLinkRoot, { recursive: true });
  fs.writeFileSync(outsideProjectJson, outsideProjectJsonBytes);
  fs.writeFileSync(outsideRequestJson, outsideRequestJsonBytes);
  fs.symlinkSync(outsideProjectJson, path.join(projectJsonLinkRoot, "project.json"));
  fs.writeFileSync(path.join(projectJsonLinkRoot, "generation-request.json"), outsideRequestJsonBytes);
  fs.writeFileSync(path.join(requestJsonLinkRoot, "project.json"), JSON.stringify({ folder: requestJsonLinkFolder, status: "analysis_ready", shots: [] }));
  fs.symlinkSync(outsideRequestJson, path.join(requestJsonLinkRoot, "generation-request.json"));
  assert.throws(() => plugin.loadWorkbenchProject(projectJsonLinkFolder), /符号链接|不安全|项目范围/, "project.json symlinks must be rejected");
  assert.throws(() => plugin.loadWorkbenchProject(requestJsonLinkFolder), /符号链接|不安全|项目范围/, "request JSON symlinks must be rejected");
  await assert.rejects(() => plugin.saveWorkbenchDraft(requestJsonLinkFolder, savedWorkbenchRequest), /符号链接|不安全|项目范围/);
  assert.strictEqual(fs.readFileSync(outsideProjectJson, "utf8"), outsideProjectJsonBytes);
  assert.strictEqual(fs.readFileSync(outsideRequestJson, "utf8"), outsideRequestJsonBytes);

  const stateJsonLinkFolder = "山竹视频复刻/状态文件链接";
  const stateJsonLinkRoot = path.join(vault, ...stateJsonLinkFolder.split("/"));
  const stopJsonLinkFolder = "山竹视频复刻/停止文件链接";
  const stopJsonLinkRoot = path.join(vault, ...stopJsonLinkFolder.split("/"));
  const outsideStateJson = path.join(jsonLinkOutside, "generation-state.json");
  const outsideStopJson = path.join(jsonLinkOutside, "stop-request.json");
  const outsideStateJsonBytes = JSON.stringify({ status: "processing", requestMtimeMs: 911, untouched: true });
  const outsideStopJsonBytes = JSON.stringify({ requestMtimeMs: 912, requestedAt: "2026-10-11T00:00:00Z", untouched: true });
  fs.writeFileSync(outsideStateJson, outsideStateJsonBytes);
  fs.writeFileSync(outsideStopJson, outsideStopJsonBytes);
  for (const [folder, root] of [[stateJsonLinkFolder, stateJsonLinkRoot], [stopJsonLinkFolder, stopJsonLinkRoot]]) {
    fs.mkdirSync(path.join(root, ".work"), { recursive: true });
    fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ folder, status: "generating", shots: [] }));
    fs.writeFileSync(path.join(root, "generation-request.json"), outsideRequestJsonBytes);
  }
  fs.symlinkSync(outsideStateJson, path.join(stateJsonLinkRoot, ".work/generation-state.json"));
  fs.writeFileSync(path.join(stopJsonLinkRoot, ".work/generation-state.json"), JSON.stringify({ status: "processing", requestMtimeMs: 912 }));
  fs.symlinkSync(outsideStopJson, path.join(stopJsonLinkRoot, ".work/stop-request.json"));
  assert.throws(() => plugin.writeState(stateJsonLinkFolder, { status: "processing", requestMtimeMs: 911 }), /符号链接|不安全|项目范围/);
  assert.throws(() => plugin.requestGenerationStop(stopJsonLinkFolder), /符号链接|不安全|项目范围/);
  assert.strictEqual(fs.readFileSync(outsideStateJson, "utf8"), outsideStateJsonBytes);
  assert.strictEqual(fs.readFileSync(outsideStopJson, "utf8"), outsideStopJsonBytes);

  const childLinkFolder = "山竹视频复刻/子目录链接";
  const childLinkRoot = path.join(vault, ...childLinkFolder.split("/"));
  const childLinkOutside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-project-child-outside-"));
  fs.mkdirSync(childLinkRoot, { recursive: true });
  fs.writeFileSync(path.join(childLinkRoot, "project.json"), JSON.stringify({ folder: childLinkFolder, status: "analysis_ready", shots: [] }));
  fs.writeFileSync(path.join(childLinkRoot, "generation-request.json"), outsideRequestJsonBytes);
  fs.mkdirSync(path.join(childLinkOutside, "storyboard"), { recursive: true });
  fs.mkdirSync(path.join(childLinkOutside, "clips"), { recursive: true });
  const outsideImagePath = path.join(childLinkOutside, "storyboard/outside.png");
  const outsideClipPath = path.join(childLinkOutside, "clips/outside.mp4");
  fs.writeFileSync(outsideImagePath, "outside-image-untouched");
  fs.writeFileSync(outsideClipPath, "outside-video-untouched");
  fs.symlinkSync(path.join(childLinkOutside, "storyboard"), path.join(childLinkRoot, "02-分镜脚本"), "dir");
  fs.symlinkSync(path.join(childLinkOutside, "clips"), path.join(childLinkRoot, "03-视频片段"), "dir");
  let outsideProjectReads = 0;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function trackedProjectRead(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(outsideImagePath)) outsideProjectReads += 1;
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    assert.throws(
      () => plugin.localImage(`${childLinkFolder}/02-分镜脚本/outside.png`),
      /符号链接|不安全|项目范围/,
      "project image reads must reject storyboard directory symlinks before reading outside bytes",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.strictEqual(outsideProjectReads, 0, "outside storyboard files must never be read for upload");
  let unsafeGenerationProviderLookups = 0;
  plugin.getGenerationPlugins = () => { unsafeGenerationProviderLookups += 1; throw new Error("provider must not be reached"); };
  await assert.rejects(() => plugin.runGeneration(childLinkFolder, {
    version: 2,
    confirmed: true,
    character: { id: "safe", prompt: "safe" },
    scenes: [{ id: "safe", prompt: "safe" }],
    settings: { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
    shots: [{ id: "001", title: "safe", sceneId: "safe", duration: 4, imagePrompt: "safe", videoPrompt: "safe" }],
  }, 100), /符号链接|不安全|项目范围/);
  assert.strictEqual(unsafeGenerationProviderLookups, 0, "unsafe project output directories must be rejected before provider access or paid submission");
  delete plugin.getGenerationPlugins;
  const safeProviderRoot = path.join(vault, "山竹视频");
  fs.mkdirSync(safeProviderRoot, { recursive: true });
  fs.writeFileSync(path.join(safeProviderRoot, "safe-source.mp4"), "safe-source");
  assert.throws(
    () => plugin.copyVaultFile("山竹视频/safe-source.mp4", `${childLinkFolder}/03-视频片段/outside.mp4`),
    /符号链接|不安全|项目范围/,
    "project video writes must reject clip directory symlinks",
  );
  assert.strictEqual(fs.readFileSync(outsideClipPath, "utf8"), "outside-video-untouched");

  const jsonEscapeOutsidePath = path.join(vault, "山竹视频复刻", "outside-json-frame.jpg");
  fs.writeFileSync(jsonEscapeOutsidePath, "outside-json-frame");
  let jsonEscapeReads = 0;
  let escapedAnalysisCalls = 0;
  const appBeforePathAnalysis = plugin.app;
  const settingsBeforePathAnalysis = plugin.settings;
  const pathAnalysisAgent = {
    getLanguageModelCatalog: () => ({
      ready: true,
      activeGroup: "safe",
      activeModel: "safe-model",
      groups: [{ id: "safe", label: "safe", ratio: 1, models: ["safe-model"] }],
    }),
    analyzeStructured: async () => { escapedAnalysisCalls += 1; throw new Error("unsafe provider call"); },
  };
  plugin.app = {
    vault: { adapter: { getBasePath: () => vault } },
    workspace,
    plugins: { getPlugin: (id) => id === "mangosteen-agent" ? pathAnalysisAgent : null },
  };
  plugin.settings = { analysisGroup: "safe", analysisModel: "safe-model" };
  for (const [name, framePath] of [
    ["相对越界", "山竹视频复刻/相对越界/../outside-json-frame.jpg"],
    ["绝对越界", path.join(childLinkOutside, "storyboard/outside.png")],
  ]) {
    const escapeFolder = `山竹视频复刻/${name}`;
    const escapeRoot = path.join(vault, ...escapeFolder.split("/"));
    fs.mkdirSync(escapeRoot, { recursive: true });
    fs.writeFileSync(path.join(escapeRoot, "project.json"), JSON.stringify({
      folder: escapeFolder,
      title: name,
      status: "prepared",
      frames: [{ index: 1, timestamp: 0, path: framePath }],
      shots: [],
    }));
    const beforeReads = jsonEscapeReads;
    fs.readFileSync = function trackedJsonEscapeRead(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(jsonEscapeOutsidePath)
        || path.resolve(String(filePath)) === path.resolve(outsideImagePath)) jsonEscapeReads += 1;
      return originalReadFileSync.call(this, filePath, ...args);
    };
    try {
      await assert.rejects(() => plugin.analyzeProject(escapeFolder), /绝对|不安全|项目范围|符号链接/);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.strictEqual(jsonEscapeReads, beforeReads, `${name}: project JSON escape path must not be read or uploaded`);
  }
  assert.strictEqual(escapedAnalysisCalls, 0, "unsafe project media must be rejected before provider upload");
  plugin.app = appBeforePathAnalysis;
  plugin.settings = settingsBeforePathAnalysis;

  const validOutputFolder = "山竹视频复刻/合法新输出";
  const validOutputRoot = path.join(vault, ...validOutputFolder.split("/"));
  fs.mkdirSync(validOutputRoot, { recursive: true });
  fs.writeFileSync(path.join(validOutputRoot, "project.json"), JSON.stringify({ folder: validOutputFolder, shots: [] }));
  fs.writeFileSync(path.join(validOutputRoot, "generation-request.json"), outsideRequestJsonBytes);
  const validOutputPath = `${validOutputFolder}/02-分镜脚本/新目录/首帧.png`;
  await plugin.saveImageCandidate({}, { kind: "base64", value: Buffer.from("valid-new-output").toString("base64") }, validOutputPath);
  assert.strictEqual(fs.readFileSync(path.join(vault, ...validOutputPath.split("/")), "utf8"), "valid-new-output", "checked paths must still permit legitimate missing output directories");

  let releaseCatalog;
  let catalogStarted;
  const waitForCatalog = new Promise((resolve) => { catalogStarted = resolve; });
  const catalogGate = new Promise((resolve) => { releaseCatalog = resolve; });
  plugin.refreshGenerationModelCatalog = async () => {
    catalogStarted();
    await catalogGate;
    return { imageModels: ["gpt-image-2-w"], videoModels: ["MiniMax-H3"] };
  };
  fs.writeFileSync(workbenchRequestPath, JSON.stringify(savedWorkbenchRequest));
  const staleConfirmation = plugin.confirmWorkbenchDraft(workbenchFolder);
  await waitForCatalog;
  fs.writeFileSync(workbenchStatePath, JSON.stringify({ status: "processing", requestMtimeMs: fs.statSync(workbenchRequestPath).mtimeMs }));
  releaseCatalog();
  await assert.rejects(() => staleConfirmation, /生成中|不能确认/);
  assert.strictEqual(JSON.parse(fs.readFileSync(workbenchRequestPath, "utf8")).confirmed, false);

  fs.writeFileSync(workbenchStatePath, JSON.stringify({ status: "ready" }));
  fs.writeFileSync(workbenchRequestPath, JSON.stringify({
    ...savedWorkbenchRequest,
    settings: { ...savedWorkbenchRequest.settings, imageModel: "retired-image-model" },
  }));
  let unavailableProjectProcessCalls = 0;
  plugin.refreshGenerationModelCatalog = async () => ({
    imageModels: ["gpt-image-2-w"],
    videoModels: ["MiniMax-H3"],
  });
  plugin.processRequest = async () => { unavailableProjectProcessCalls += 1; };
  await assert.rejects(
    () => plugin.confirmWorkbenchDraft(workbenchFolder),
    /图片模型.*retired-image-model.*不可用/,
    "confirmation must reject the unavailable model saved by this exact project",
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(workbenchRequestPath, "utf8")).confirmed, false);
  assert.strictEqual(unavailableProjectProcessCalls, 0, "unavailable project models must block paid processing");
  delete plugin.processRequest;

  fs.writeFileSync(workbenchStatePath, JSON.stringify({ status: "ready" }));
  fs.writeFileSync(workbenchRequestPath, JSON.stringify(savedWorkbenchRequest));
  let releaseConcurrentCatalog;
  let concurrentCatalogStarted;
  const waitForConcurrentCatalog = new Promise((resolve) => { concurrentCatalogStarted = resolve; });
  const concurrentCatalogGate = new Promise((resolve) => { releaseConcurrentCatalog = resolve; });
  plugin.refreshGenerationModelCatalog = async () => {
    concurrentCatalogStarted();
    await concurrentCatalogGate;
    return {
      imageModels: ["other-global-image", "gpt-image-2-w"],
      videoModels: ["seedance-2.5", "MiniMax-H3"],
    };
  };
  const settingsBeforeProjectConfirmation = plugin.settings;
  plugin.settings = { imageModel: "other-global-image", videoModel: "seedance-2.5" };
  let processingTriggers = 0;
  plugin.processRequest = async (requestPath, notify) => {
    processingTriggers += 1;
    assert.strictEqual(fs.realpathSync(requestPath), fs.realpathSync(workbenchRequestPath));
    assert.strictEqual(notify, true);
  };
  const originalRenameSync = fs.renameSync;
  let confirmedRequestWrites = 0;
  fs.renameSync = function trackedRename(source, destination) {
    const canonicalDestination = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
    const canonicalRequest = path.join(fs.realpathSync(path.dirname(workbenchRequestPath)), path.basename(workbenchRequestPath));
    if (canonicalDestination === canonicalRequest) confirmedRequestWrites += 1;
    return originalRenameSync.call(this, source, destination);
  };
  try {
    const firstConfirmation = plugin.confirmWorkbenchDraft(workbenchFolder);
    await waitForConcurrentCatalog;
    await assert.rejects(() => plugin.confirmWorkbenchDraft(workbenchFolder), /正在确认/);
    releaseConcurrentCatalog();
    await firstConfirmation;
  } finally {
    fs.renameSync = originalRenameSync;
  }
  const confirmedWorkbenchRequest = JSON.parse(fs.readFileSync(workbenchRequestPath, "utf8"));
  assert.strictEqual(confirmedWorkbenchRequest.confirmed, true);
  assert.deepStrictEqual(
    {
      imageModel: confirmedWorkbenchRequest.settings.imageModel,
      videoModel: confirmedWorkbenchRequest.settings.videoModel,
    },
    { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3" },
    "confirmation must use the current project's saved model pair, not shared global settings",
  );
  assert.strictEqual(confirmedRequestWrites, 1, "fast double confirmation must atomically write once");
  assert.strictEqual(processingTriggers, 1, "fast double confirmation must trigger processing once");
  await assert.rejects(() => plugin.confirmWorkbenchDraft(workbenchFolder), /已确认|重复确认/);
  assert(workbenchView.refreshCalls > 0, "project writes must request a refresh from the open workbench view");
  delete plugin.refreshGenerationModelCatalog;
  delete plugin.processRequest;
  plugin.settings = settingsBeforeProjectConfirmation;

  const appBeforeConfirmLatest = plugin.app;
  const originalActivateWorkbench = plugin.activateWorkbench;
  let workbenchActivations = 0;
  plugin.activateWorkbench = async () => {
    workbenchActivations += 1;
    return { view: { activeTab: "overview", render() { this.rendered = true; } } };
  };
  plugin.confirmWorkbenchDraft = async () => { throw new Error("legacy whole-project confirmation must not run"); };
  await plugin.confirmLatestGeneration();
  assert.strictEqual(workbenchActivations, 1, "the legacy command id must now open the per-shot queue UI");
  delete plugin.confirmWorkbenchDraft;
  plugin.activateWorkbench = originalActivateWorkbench;

  for (const terminalStatus of ["completed", "stopped", "failed"]) {
    const terminalVault = fs.mkdtempSync(path.join(os.tmpdir(), `mangosteen-confirm-${terminalStatus}-`));
    const terminalFolder = `山竹视频复刻/${terminalStatus}`;
    const terminalRoot = path.join(terminalVault, ...terminalFolder.split("/"));
    fs.mkdirSync(path.join(terminalRoot, ".work"), { recursive: true });
    fs.writeFileSync(path.join(terminalRoot, "project.json"), JSON.stringify({
      folder: terminalFolder,
      title: terminalStatus,
      status: terminalStatus,
      shots: [],
    }));
    const terminalRequestPath = path.join(terminalRoot, "generation-request.json");
    const terminalRequestBytes = JSON.stringify({ confirmed: true, settings: {}, shots: [] });
    fs.writeFileSync(terminalRequestPath, terminalRequestBytes);
    fs.utimesSync(terminalRequestPath, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const terminalMtimeMs = fs.statSync(terminalRequestPath).mtimeMs;
    fs.writeFileSync(path.join(terminalRoot, ".work/generation-state.json"), JSON.stringify({ status: terminalStatus, requestMtimeMs: terminalMtimeMs }));
    let terminalProcessCalls = 0;
    let terminalProviderCalls = 0;
    plugin.app = { vault: { adapter: { getBasePath: () => terminalVault } }, workspace };
    plugin.refreshGenerationModelCatalog = async () => {
      terminalProviderCalls += 1;
      return { imageModels: ["gpt-image-2-w"], videoModels: ["MiniMax-H3"] };
    };
    plugin.processRequest = async () => { terminalProcessCalls += 1; };
    await plugin.confirmLatestGeneration();
    assert.strictEqual(fs.statSync(terminalRequestPath).mtimeMs, terminalMtimeMs, `${terminalStatus}: confirmed terminal request mtime must not change`);
    assert.strictEqual(fs.readFileSync(terminalRequestPath, "utf8"), terminalRequestBytes, `${terminalStatus}: confirmed terminal request bytes must not change`);
    assert.strictEqual(terminalProcessCalls, 0, `${terminalStatus}: terminal request must not trigger processing`);
    assert.strictEqual(terminalProviderCalls, 0, `${terminalStatus}: terminal request must not inspect or invoke paid providers`);
    fs.rmSync(terminalVault, { recursive: true, force: true });
  }
  delete plugin.refreshGenerationModelCatalog;
  delete plugin.processRequest;
  plugin.app = appBeforeConfirmLatest;

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
  fs.writeFileSync(path.join(leaseRoot, "project.json"), JSON.stringify({
    folder: leaseFolder,
    title: "租约恢复",
    status: "generating",
    statusText: "正在生成",
    shots: [],
  }));
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
  writeLease({
    status: "processing", requestMtimeMs, instanceId: plugin.instanceId,
    leaseStartedAt: new Date(now - 1000).toISOString(), leaseUpdatedAt: new Date(now).toISOString(), leaseExpiresAt: new Date(now + 60000).toISOString(),
  });
  fs.writeFileSync(path.join(leaseRoot, ".work/stop-request.json"), JSON.stringify({
    requestMtimeMs: requestMtimeMs - 1,
    requestedAt: "2026-10-11T00:00:00Z",
  }));
  assert.strictEqual(plugin.isGenerationStopRequested(leaseFolder, requestMtimeMs), false);
  assert.doesNotThrow(
    () => plugin.assertGenerationActive(leaseFolder, requestMtimeMs),
    "a stop marker for an older request must not stop the current request",
  );
  const leaseStopPath = plugin.stopRequestPath(leaseFolder);
  const originalRenameForStop = fs.renameSync;
  let stopMarkerWrites = 0;
  fs.renameSync = function trackedStopRename(source, destination) {
    if (destination === leaseStopPath) stopMarkerWrites += 1;
    return originalRenameForStop.call(this, source, destination);
  };
  try {
    assert.strictEqual(plugin.requestGenerationStop(leaseFolder), true, "an active project must accept a graceful stop request");
    const firstStopRequest = JSON.parse(fs.readFileSync(leaseStopPath, "utf8"));
    writeLease({
      status: "processing", requestMtimeMs, instanceId: plugin.instanceId,
      leaseStartedAt: new Date(now - 1000).toISOString(), leaseUpdatedAt: new Date(now).toISOString(), leaseExpiresAt: new Date(now + 60000).toISOString(),
    });
    fs.writeFileSync(path.join(leaseRoot, "project.json"), JSON.stringify({
      folder: leaseFolder,
      title: "租约恢复",
      status: "generating",
      statusText: "半完成停止前的旧状态",
      shots: [],
    }));
    assert.strictEqual(plugin.requestGenerationStop(leaseFolder), true, "repeated stop requests must remain successful and idempotent");
    const repairedState = JSON.parse(fs.readFileSync(path.join(leaseRoot, ".work/generation-state.json"), "utf8"));
    assert.strictEqual(repairedState.stopRequestedAt, firstStopRequest.requestedAt);
    assert(Number.isFinite(Date.parse(repairedState.updatedAt)));
    assert(Date.parse(repairedState.updatedAt) >= Date.parse(firstStopRequest.requestedAt));
    assert.match(JSON.parse(fs.readFileSync(path.join(leaseRoot, "project.json"), "utf8")).statusText, /当前已提交.*完成后停止/);
    writeLease({
      status: "processing",
      requestMtimeMs,
      instanceId: plugin.instanceId,
      stopRequestedAt: firstStopRequest.requestedAt,
    });
    assert.strictEqual(plugin.requestGenerationStop(leaseFolder), true, "a matching marker must also repair a missing updatedAt");
    const repairedTimestampState = JSON.parse(fs.readFileSync(path.join(leaseRoot, ".work/generation-state.json"), "utf8"));
    assert.strictEqual(repairedTimestampState.stopRequestedAt, firstStopRequest.requestedAt);
    assert(Number.isFinite(Date.parse(repairedTimestampState.updatedAt)));
  } finally {
    fs.renameSync = originalRenameForStop;
  }
  assert.strictEqual(stopMarkerWrites, 1, "repeated stop requests must write the authoritative marker once");
  const stopRequest = JSON.parse(fs.readFileSync(leaseStopPath, "utf8"));
  assert.strictEqual(stopRequest.requestMtimeMs, requestMtimeMs);
  assert.throws(
    () => plugin.assertGenerationActive(leaseFolder, requestMtimeMs),
    (error) => error?.code === "GENERATION_STOPPED",
    "the generator must stop before the next paid operation",
  );
  const stoppingProject = JSON.parse(fs.readFileSync(path.join(leaseRoot, "project.json"), "utf8"));
  assert.match(stoppingProject.statusText, /当前已提交.*完成后停止/);
  writeLease({ status: "stopped", requestMtimeMs, updatedAt: new Date().toISOString() });
  assert.strictEqual(plugin.requestAlreadyHandled(leaseFolder, requestMtimeMs, now), true, "stopped requests must not restart automatically");

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
      character: { id: "hero", prompt: "固定人物参考板", voiceProfile: "年轻清亮的中文女声，轻微四川口音。" },
      scenes: [{ id: "studio", prompt: "固定摄影棚场景" }],
      settings: { ratio: "9:16", resolution, videoModel: model },
      shots: [
        { title: "入场", sceneId: "studio", duration: 4, dialogue: "你们好呀", voiceDirection: "亲切，语速中等，句尾上扬。", imagePrompt: "人物走入摄影棚", videoPrompt: "人物向前走" },
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
      assert.strictEqual(generatedTextPrompts.length, 2, `${family}: exactly one character and one scene asset must be generated`);
      assert.match(generatedTextPrompts[0], /固定人物参考板/, `${family}: character board must keep its source prompt`);
      assert.match(generatedTextPrompts[0], /【项目视觉风格】/, `${family}: character board must inherit the project style`);
      assert.match(generatedTextPrompts[1], /固定摄影棚场景/, `${family}: scene asset must keep the environment description`);
      assert.match(generatedTextPrompts[1], /纯环境空镜/, `${family}: scene assets must be generated without people`);
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
      assert.match(submittedOptions[0].prompt, /你们好呀/, `${family}: dialogue must reach the video prompt`);
      assert.match(submittedOptions[0].prompt, /轻微四川口音/, `${family}: stable voice profile must reach the video prompt`);
      assert.match(submittedOptions[0].prompt, /亲切，语速中等/, `${family}: per-shot delivery must reach the video prompt`);
      assert.match(submittedOptions[1].prompt, /镜头缓慢推进/, `${family}: silent shots must retain the visual instruction`);
      assert.doesNotMatch(submittedOptions[1].prompt, /【角色对白】|画面中的角色完整说出/, `${family}: silent shots must not invent dialogue instructions`);
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

  const stoppedVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-replica-stopped-path-"));
  const stoppedFolder = "山竹视频复刻/首镜完成后停止";
  const stoppedRoot = path.join(stoppedVault, ...stoppedFolder.split("/"));
  const stoppedVideoRoot = path.join(stoppedVault, "山竹视频");
  fs.mkdirSync(stoppedRoot, { recursive: true });
  fs.mkdirSync(stoppedVideoRoot, { recursive: true });
  fs.writeFileSync(path.join(stoppedRoot, "project.json"), JSON.stringify({
    folder: stoppedFolder,
    title: "首镜完成后停止",
    frames: [],
    shots: [],
  }));
  const stoppedRequest = {
    version: 2,
    confirmed: true,
    character: { id: "stop-hero", prompt: "停止测试人物" },
    scenes: [{ id: "stop-scene", prompt: "停止测试场景" }],
    settings: { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
    shots: [
      { id: "001", title: "已提交镜头", sceneId: "stop-scene", duration: 4, imagePrompt: "首镜首帧", videoPrompt: "首镜视频" },
      { id: "002", title: "不得提交镜头", sceneId: "stop-scene", duration: 4, imagePrompt: "次镜首帧", videoPrompt: "次镜视频" },
    ],
  };
  const stoppedRequestPath = path.join(stoppedRoot, "generation-request.json");
  fs.writeFileSync(stoppedRequestPath, JSON.stringify(stoppedRequest));
  const stoppedImage = generationImage({
    generateText: async (prompt) => ({ candidate: { kind: "base64", value: Buffer.from(`asset:${prompt}`).toString("base64") } }),
    generateEdit: async () => { throw new Error("version 2 must use generateEditMulti"); },
    generateEditMulti: async (prompt) => ({ candidate: { kind: "base64", value: Buffer.from(`frame:${prompt}`).toString("base64") } }),
    extractResults: (response) => response?.candidate ? [response.candidate] : [],
  });
  let stoppedVideoSubmissions = 0;
  const stoppedVideo = {
    settings: { model: "MiniMax-H3", resolution: "768p" },
    refreshAgentAccess: async () => ({ videoModelKeys: { "MiniMax-H3": "test-key" } }),
    submitVideo: async () => {
      stoppedVideoSubmissions += 1;
      const id = `stopped-video-${stoppedVideoSubmissions}`;
      fs.writeFileSync(path.join(stoppedVideoRoot, `${id}.mp4`), `video:${id}`);
      return { id };
    },
  };
  plugin.app = { vault: { adapter: { getBasePath: () => stoppedVault } } };
  plugin.processing = new Set();
  plugin.referenceAssetPromises = new Map();
  plugin.getGenerationPlugins = () => ({ image: stoppedImage, video: stoppedVideo });
  plugin.waitForVideo = async (_video, taskId) => {
    assert.strictEqual(plugin.requestGenerationStop(stoppedFolder), true);
    return { localPath: `山竹视频/${taskId}.mp4` };
  };
  plugin.openVaultPath = async () => true;
  try {
    await plugin.processRequest(stoppedRequestPath);
    const stoppedProject = JSON.parse(fs.readFileSync(path.join(stoppedRoot, "project.json"), "utf8"));
    const stoppedState = JSON.parse(fs.readFileSync(path.join(stoppedRoot, ".work/generation-state.json"), "utf8"));
    assert.strictEqual(stoppedVideoSubmissions, 1, "stop after the current completion must prevent the next provider submission");
    assert.strictEqual(stoppedState.status, "stopped");
    assert.strictEqual(stoppedProject.status, "stopped");
    assert(stoppedProject.shots[0].videoPath, "the completed current provider artifact must remain attached");
    assert.strictEqual(
      fs.readFileSync(path.join(stoppedVault, ...stoppedProject.shots[0].videoPath.split("/")), "utf8"),
      "video:stopped-video-1",
    );
    assert.strictEqual(stoppedProject.shots[1].videoPath, "", "the next shot must remain unsubmitted");
  } finally {
    fs.rmSync(stoppedVault, { recursive: true, force: true });
  }
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

  assert.strictEqual(generatedTextPrompts.length, 3, "the legacy people-containing scene asset must be regenerated");
  assert.match(generatedTextPrompts[0], /固定人物参考板/);
  assert.match(generatedTextPrompts[0], /【项目视觉风格】/);
  assert.match(generatedTextPrompts[1], /纯环境空镜[\s\S]*海边集装箱场景/);
  assert.match(generatedTextPrompts[2], /纯环境空镜[\s\S]*摄影棚场景/);
  assert.strictEqual(editCalls.length, 3);
  assert.deepStrictEqual(editCalls.map((call) => call.references), [
    [`text:${generatedTextPrompts[0]}`, `text:${generatedTextPrompts[1]}`],
    [`text:${generatedTextPrompts[0]}`, `text:${generatedTextPrompts[2]}`],
    [`text:${generatedTextPrompts[0]}`, `text:${generatedTextPrompts[2]}`],
  ]);
  assert.match(editCalls[0].prompt, /【项目视觉风格】[\s\S]*人物走在港口/);
  assert.match(editCalls[1].prompt, /【项目视觉风格】[\s\S]*人物走入摄影棚/);
  assert.match(editCalls[2].prompt, /【项目视觉风格】[\s\S]*人物停在灯光下/);
  assert(editCalls.every((call) => !call.references.includes("source-frame-must-not-be-used")));
  assert(editCalls.every((call) => /参考图1是人物设定板/.test(call.prompt)));
  assert(editCalls.every((call) => /参考图2是纯环境场景板/.test(call.prompt)));
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
  assert.strictEqual(generatedTextPrompts.length, 3, "existing assets must be reused");
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

  const generatedV3Folder = "山竹视频复刻/产品资产生成";
  const generatedV3 = path.join(vault, ...generatedV3Folder.split("/"));
  fs.mkdirSync(generatedV3, { recursive: true });
  fs.writeFileSync(path.join(generatedV3, "project.json"), JSON.stringify({ folder: generatedV3Folder, title: "产品资产生成", frames: [], shots: [] }));
  const generatedV3Prompts = [];
  const generatedV3Edits = [];
  const imageV3 = generationImage({
    generateText: async (prompt) => {
      generatedV3Prompts.push(prompt);
      return { candidate: { kind: "base64", value: Buffer.from(`v3:${prompt}`).toString("base64") } };
    },
    generateEditMulti: async (prompt, images) => {
      generatedV3Edits.push({ prompt, references: images.map((file) => file.buffer.toString()) });
      return { candidate: { kind: "base64", value: Buffer.from(`v3-edit:${prompt}`).toString("base64") } };
    },
    extractResults: (response) => response?.candidate ? [response.candidate] : [],
  });
  const videoV3 = {
    settings: { model: "MiniMax-H3", resolution: "768p" },
    refreshAgentAccess: async () => ({ videoModelKeys: { "MiniMax-H3": "test-key" } }),
    submitVideo: async () => ({ id: "task-v3" }),
  };
  plugin.getGenerationPlugins = () => ({ image: imageV3, video: videoV3 });
  await plugin.runGeneration(generatedV3Folder, {
    version: 3,
    confirmed: true,
    character: { id: "v3-hero", prompt: "固定人物参考板" },
    products: [{ id: "headphones", prompt: "白色头戴式耳机与白色包装盒，产品外观固定" }],
    scenes: [{ id: "v3-studio", prompt: "纯白摄影棚，弧形背景墙和左侧柔光灯。关键产品是白色耳机盒。" }],
    settings: { ratio: "9:16", resolution: "768p", videoModel: "MiniMax-H3" },
    shots: [{ id: "001", title: "产品展示", sceneId: "v3-studio", productIds: ["headphones"], duration: 4, imagePrompt: "人物手持白色耳机盒", videoPrompt: "人物举起耳机盒" }],
  }, 470);
  assert.strictEqual(generatedV3Prompts.length, 3);
  assert.match(generatedV3Prompts[0], /固定人物参考板/);
  assert.match(generatedV3Prompts[1], /纯产品参考板/);
  assert.match(generatedV3Prompts[2], /纯环境空镜/);
  assert.doesNotMatch(generatedV3Prompts[2], /关键产品|耳机盒/);
  assert.strictEqual(generatedV3Edits.length, 1);
  assert.strictEqual(generatedV3Edits[0].references.length, 3);
  assert.match(generatedV3Edits[0].prompt, /参考图3是产品设定板/);
  const completedV3 = JSON.parse(fs.readFileSync(path.join(generatedV3, "project.json"), "utf8"));
  assert.strictEqual(completedV3.productAssets[0].imagePath, "山竹视频资产库/产品/headphones/产品参考板.png");
  assert(fs.existsSync(path.join(vault, "山竹视频资产库", "产品", "headphones", "product.json")));

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
      const promptKey = prompt.includes("并发场景参考图")
        ? "并发场景参考图"
        : prompt.includes("并发人物参考板")
          ? "并发人物参考板"
          : prompt;
      concurrentPrompts[promptKey] += 1;
      const count = concurrentPrompts[promptKey];
      if (promptKey === "并发人物参考板" && count === 1) {
        markCharacterStarted();
        await characterGate;
      }
      if (promptKey === "并发场景参考图" && count === 1) {
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
  fs.rmSync(projectSymlinkVault, { recursive: true, force: true });
  fs.rmSync(escapedProjectOutside, { recursive: true, force: true });
  fs.rmSync(rootSymlinkVault, { recursive: true, force: true });
  fs.rmSync(escapedRootOutside, { recursive: true, force: true });
  fs.rmSync(workSymlinkVault, { recursive: true, force: true });
  fs.rmSync(escapedWorkOutside, { recursive: true, force: true });
  fs.rmSync(escapedMediaOutside, { recursive: true, force: true });
  fs.rmSync(jsonLinkOutside, { recursive: true, force: true });
  fs.rmSync(childLinkOutside, { recursive: true, force: true });
  delete global.window;
  Module._load = originalLoad;
  console.log("plugin-load: ok");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
