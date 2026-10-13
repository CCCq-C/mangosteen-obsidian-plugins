const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.filter(Boolean).forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tagName = "div", ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.parentElement = null;
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.open = false;
    this.emptyCalls = 0;
    this.ownerDocument = ownerDocument || { activeElement: null };
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = "none";
  }

  set innerHTML(_) { throw new Error("runtime UI must not inject HTML strings"); }
  get innerHTML() { return ""; }

  addClass(...names) { this.classList.add(...names.flatMap((name) => String(name).split(/\s+/))); }
  removeClass(...names) { this.classList.remove(...names); }
  setText(value) { this.textContent = String(value); }
  setAttr(name, value) { this.attributes[name] = String(value); }

  createEl(tagName, options = {}) {
    const child = new FakeElement(tagName, this.ownerDocument);
    child.parentElement = this;
    if (options.cls) child.addClass(...(Array.isArray(options.cls) ? options.cls : [options.cls]));
    if (options.text !== undefined) child.setText(options.text);
    for (const [name, value] of Object.entries(options.attr || {})) child.setAttr(name, value);
    this.children.push(child);
    return child;
  }

  createDiv(options = {}) { return this.createEl("div", options); }

  empty() {
    this.emptyCalls += 1;
    this.children = [];
    this.textContent = "";
  }

  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  async dispatch(type) {
    for (const listener of this.listeners[type] || []) await listener({ currentTarget: this, target: this });
  }

  focus() { this.ownerDocument.activeElement = this; }

  setSelectionRange(start, end, direction = "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match) return match;
    }
    return null;
  }

  findAll(predicate, output = []) {
    if (predicate(this)) output.push(this);
    for (const child of this.children) child.findAll(predicate, output);
    return output;
  }
}

class FakeItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.contentEl = leaf.contentEl;
  }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") return { ItemView: FakeItemView };
  return originalLoad.call(this, request, parent, isMain);
};

const timerCalls = [];
const clearedTimers = [];
const resizeObservers = [];
const confirmMessages = [];
global.window = {
  setInterval(callback, delay) {
    const id = timerCalls.length + 1;
    timerCalls.push({ callback, delay, id });
    return id;
  },
  clearInterval(id) { clearedTimers.push(id); },
  confirm(message) { confirmMessages.push(String(message)); return true; },
};
global.ResizeObserver = class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.disconnected = false; resizeObservers.push(this); }
  observe(element) { this.element = element; }
  disconnect() { this.disconnected = true; }
};

const {
  VIEW_TYPE,
  createVideoReplicaWorkbenchView,
} = require("../replica-workbench.cjs");
const VideoReplicaWorkbenchView = createVideoReplicaWorkbenchView(FakeItemView);

assert.strictEqual(
  fs.readFileSync(path.resolve(__dirname, "../replica-workbench.cjs"), "utf8").includes('require("obsidian")'),
  false,
  "dynamically loaded workbench modules must receive Obsidian APIs from main.js",
);

const request = {
  version: 5,
  confirmed: false,
  visualStyle: { category: "真人写实", prompt: "真人电影质感，自然皮肤纹理，暖色电影光影。" },
  character: { id: "hero", prompt: "短发人物，蓝色工装", voiceProfile: "年轻清亮女声，轻微四川口音" },
  products: [{ id: "phone", prompt: "银色手机" }],
  scenes: [{ id: "room", prompt: "明亮摄影棚" }],
  settings: { imageModel: "gpt-image-2", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
  shots: [{
    id: "001",
    title: "开场",
    sceneId: "room",
    productIds: ["phone"],
    duration: 4,
    timeline: [
      { start: 0, end: 2, action: "人物走入画面", dialogue: "", performance: "自然", camera: "远景跟拍", environment: "白色背景" },
      { start: 2, end: 4, action: "人物举起手机", dialogue: "你好", performance: "亲切，语速中等，句尾上扬", camera: "缓慢推进", environment: "同一摄影棚" },
    ],
  }],
};

const readySnapshot = {
  project: {
    folder: "山竹视频复刻/测试项目",
    title: "测试项目",
    status: "analysis_ready",
    statusText: "等待确认",
    shots: [{ id: "001", title: "开场", status: "等待生成" }],
  },
  request,
  requestMtimeMs: 100,
  generationState: {},
  generationQueue: {},
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createPlugin(snapshot = readySnapshot, projects = [{ folder: readySnapshot.project.folder, title: "测试项目" }]) {
  return {
    snapshot: clone(snapshot),
    projects: clone(projects),
    loadCalls: 0,
    saveCalls: [],
    previewCalls: [],
    queueCalls: [],
    stopCalls: [],
    generationCatalogCalls: 0,
    generationSelectionCalls: [],
    analysisCalls: [],
    openedPaths: [],
    async listWorkbenchProjects() { return clone(this.projects); },
    async loadWorkbenchProject(folder) {
      this.loadCalls += 1;
      assert.strictEqual(folder, this.snapshot.project.folder);
      return clone(this.snapshot);
    },
    async saveWorkbenchDraft(folder, nextRequest) {
      this.saveCalls.push({ folder, request: clone(nextRequest) });
      this.snapshot.request = clone(nextRequest);
    },
    async previewWorkbenchGeneration(folder, shotIds) {
      this.previewCalls.push({ folder, shotIds: [...shotIds] });
      const selected = new Set(shotIds);
      return {
        warning: "确认后，所选分镜在本次生成期间将无法更改。",
        selectedShotIds: this.snapshot.request.shots.filter((shot) => selected.has(shot.id)).map((shot) => shot.id),
        shots: this.snapshot.request.shots.filter((shot) => selected.has(shot.id)).map((shot) => ({
          ...clone(shot),
          effectiveVideoPrompt: shot.videoPromptOverride || "最终结构化时间轴提示词",
        })),
      };
    },
    async startWorkbenchGeneration(folder, plan) {
      this.queueCalls.push({ folder, plan: clone(plan) });
      return { queueId: "queue-1", status: "processing" };
    },
    async stopWorkbenchGeneration(folder) { this.stopCalls.push(folder); },
    async refreshGenerationModelCatalog() {
      this.generationCatalogCalls += 1;
      return {
        imageModels: ["gpt-image-2", "gpt-image-2-w"],
        videoModels: ["MiniMax-H3", "seedance-2.5"],
      };
    },
    async setGenerationSelection(imageModel, videoModel) {
      this.generationSelectionCalls.push({ imageModel, videoModel });
      return true;
    },
    async analyzeWorkbenchProject(folder) {
      this.analysisCalls.push(folder);
      this.snapshot.project.status = "analysis_ready";
      this.snapshot.project.statusText = "分析完成，等待确认";
      this.snapshot.request.analysisStatus = "analysis_ready";
      this.snapshot.request.analysisStatusText = "分析完成，等待确认";
      return true;
    },
    async openVaultPath(vaultPath) { this.openedPaths.push(vaultPath); },
    openPrepareModal() {},
    openAnalysisModelModal() {},
    openGenerationModelModal() {},
  };
}

function createView(plugin) {
  return new VideoReplicaWorkbenchView({ contentEl: new FakeElement("div") }, plugin);
}

(async () => {
  const plugin = createPlugin();
  const view = createView(plugin);
  assert.strictEqual(view.getViewType(), VIEW_TYPE);
  assert.strictEqual(VIEW_TYPE, "mangosteen-video-replica-workbench");
  assert.strictEqual(view.getDisplayText(), "山竹视频复刻");
  assert.strictEqual(typeof view.getIcon(), "string");

  await view.onOpen();
  assert.strictEqual(plugin.loadCalls, 1);
  assert.strictEqual(timerCalls.length, 1);
  assert.strictEqual(timerCalls[0].delay, 2000);
  assert.strictEqual(view.contentEl.classList.contains("mangosteen-replica-workbench"), true);
  assert.strictEqual(view.contentEl.style.containerType, "inline-size");
  assert.strictEqual(resizeObservers.length, 1);

  const firstRenderCount = view.contentEl.emptyCalls;
  await view.refresh();
  assert.strictEqual(plugin.loadCalls, 2);
  assert.strictEqual(view.contentEl.emptyCalls, firstRenderCount, "unchanged polling must preserve the DOM");

  const shotsTab = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜");
  assert(shotsTab, "shots navigation should render");
  await shotsTab.dispatch("click");
  const renderedTags = view.contentEl.findAll(() => true).map((element) => element.tagName);
  assert(renderedTags.includes("INPUT"));
  assert(renderedTags.includes("TEXTAREA"));
  assert(renderedTags.includes("SELECT"));
  for (const element of view.contentEl.findAll(() => true)) {
    assert.strictEqual(element.listeners.pointerdown, undefined);
    assert.strictEqual(element.listeners.mousedown, undefined);
  }
  const cockpitGrid = view.contentEl.find((element) => element.classList.contains("mangosteen-replica-cockpit-grid"));
  assert(cockpitGrid, "the production tab must render the three-pane cockpit");
  assert.deepStrictEqual(
    cockpitGrid.children.map((element) => ["shot-rail", "shot-editor", "generation-monitor"].find((name) => element.classList.contains(name))),
    ["shot-rail", "shot-editor", "generation-monitor"],
  );
  const shotList = cockpitGrid.find((element) => element.classList.contains("mangosteen-replica-shot-list"));
  assert.strictEqual(
    shotList.findAll((element) => element.classList.contains("mangosteen-replica-shot-item")).length,
    view.draft.shots.length,
    "the rail must render one compact row per shot",
  );
  assert(view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "生成所选（0）"));
  assert(view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "生成此镜头"));
  const firstShotCheckbox = view.contentEl.find((element) => (
    element.tagName === "INPUT" && element.attributes.type === "checkbox" && element.dataset.shotId === "001"
  ));
  assert(firstShotCheckbox, "each shot must expose a selection checkbox");
  const durationInput = view.contentEl.find((element) => (
    element.tagName === "INPUT"
      && element.dataset.section === "shot"
      && element.dataset.field === "duration"
  ));
  assert(durationInput, "each shot must expose an integer duration input");
  assert.strictEqual(durationInput.attributes.min, "4");
  assert.strictEqual(durationInput.attributes.max, "15");
  assert.strictEqual(durationInput.attributes.step, "1");
  firstShotCheckbox.checked = true;
  await firstShotCheckbox.dispatch("change");
  const selectedGenerateButton = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "生成所选（1）");
  assert(selectedGenerateButton, "batch generation must reflect the selected shot count");
  await selectedGenerateButton.dispatch("click");
  assert.deepStrictEqual(plugin.previewCalls.at(-1).shotIds, ["001"]);
  assert.strictEqual(plugin.queueCalls.length, 1);
  assert.strictEqual(
    confirmMessages.at(-1),
    "是否生成（分镜 001）？\n\n确认后，所选分镜在本次生成期间将无法更改。",
  );
  assert.doesNotMatch(confirmMessages.at(-1), /最终提示词|人物举起手机|镜头推进/);
  assert.strictEqual(plugin.snapshot.request.confirmed, false, "the UI must not revive the legacy confirmed=true workflow");

  const titleInput = view.contentEl.find((element) => (
    element.tagName === "INPUT"
      && element.dataset.section === "shot"
      && element.dataset.field === "title"
  ));
  assert(titleInput, "shot title input should render");
  const timelineRows = view.contentEl.findAll((element) => element.classList.contains("mangosteen-replica-timeline-row"));
  assert.strictEqual(timelineRows.length, 2, "every dynamic timeline segment must render as one editable row");
  const timelineFields = new Set(view.contentEl.findAll((element) => element.dataset.section === "timeline").map((element) => element.dataset.field));
  assert.deepStrictEqual([...timelineFields].sort(), ["action", "camera", "dialogue", "end", "environment", "performance", "start"]);
  for (const removedField of ["imagePrompt", "lastImagePrompt", "videoPrompt", "plot", "voiceDirection"]) {
    assert.strictEqual(view.contentEl.find((element) => element.dataset.field === removedField), null, `${removedField} must not remain as a duplicate editor`);
  }
  const performanceInput = view.contentEl.find((element) => (
    element.tagName === "TEXTAREA"
      && element.dataset.section === "timeline"
      && element.dataset.field === "performance"
  ));
  assert(performanceInput, "per-segment performance should be editable in the workbench");
  assert.strictEqual(performanceInput.value, "自然");
  const livePromptPreview = view.contentEl.find((element) => element.attributes["aria-label"] === "最终视频提示词预览");
  const promptDisclosure = view.contentEl.find((element) => element.classList.contains("mangosteen-replica-prompt-disclosure"));
  assert.strictEqual(promptDisclosure.open, false, "the full prompt must stay collapsed by default");
  performanceInput.value = "紧张低声说话";
  await performanceInput.dispatch("input");
  assert.match(livePromptPreview.value, /紧张低声说话/, "the final prompt preview must update before paid confirmation");
  const addSegmentButton = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "在后面添加");
  await addSegmentButton.dispatch("click");
  assert.strictEqual(view.draft.shots[0].timeline.length, 3);
  const deleteSegmentButton = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "删除此段");
  await deleteSegmentButton.dispatch("click");
  assert.strictEqual(view.draft.shots[0].timeline.length, 2);
  titleInput.value = "本地改名";
  await titleInput.dispatch("input");
  assert.strictEqual(view.dirty, true);
  assert.strictEqual(view.draft.shots[0].title, "本地改名");

  const immediateSaveButton = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "保存草案");
  assert.strictEqual(immediateSaveButton.disabled, false, "editing must enable Save without waiting for refresh");
  assert(view.contentEl.find((element) => element.textContent === "有未保存修改"), "dirty status must update immediately");
  await immediateSaveButton.dispatch("click");
  assert.strictEqual(plugin.saveCalls.length, 1, "editing then saving must work without an intervening refresh");
  assert.strictEqual(plugin.saveCalls[0].request.shots[0].title, "本地改名");

  const refreshedTitleInput = view.contentEl.find((element) => (
    element.tagName === "INPUT"
      && element.dataset.section === "shot"
      && element.dataset.field === "title"
  ));
  refreshedTitleInput.value = "本地未保存改名";
  await refreshedTitleInput.dispatch("input");

  const assetsTab = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "资产");
  await assetsTab.dispatch("click");
  const voiceProfileInput = view.contentEl.find((element) => (
    element.tagName === "TEXTAREA"
      && element.dataset.section === "character"
      && element.dataset.field === "voiceProfile"
  ));
  assert(voiceProfileInput, "stable character voice profile should be editable in the workbench");
  assert.strictEqual(voiceProfileInput.value, "年轻清亮女声，轻微四川口音");
  const stylePromptInput = view.contentEl.find((element) => (
    element.tagName === "TEXTAREA"
      && element.dataset.section === "visualStyle"
      && element.dataset.field === "prompt"
  ));
  assert(stylePromptInput, "project visual style must be editable once for every asset and shot");
  assert.strictEqual(stylePromptInput.value, "真人电影质感，自然皮肤纹理，暖色电影光影。");
  await view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");

  plugin.snapshot.request.shots[0].title = "外部改名";
  plugin.snapshot.project.statusText = "轮询状态变化";
  await view.refresh();
  assert.strictEqual(view.draft.shots[0].title, "本地未保存改名", "polling must not replace a dirty draft");

  const saveButton = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "保存草案");
  assert(saveButton, "save button should render");
  await saveButton.dispatch("click");
  assert.strictEqual(plugin.saveCalls.length, 2);
  assert.strictEqual(plugin.saveCalls[1].request.shots[0].title, "本地未保存改名");
  assert.strictEqual(view.dirty, false);

  view.contentScrollEl.scrollTop = 137;
  view.activeTab = "shots";
  await view.refresh({ force: true });
  assert.strictEqual(view.activeTab, "shots");
  assert.strictEqual(view.contentScrollEl.scrollTop, 137);

  const settingsTab = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "设置");
  await settingsTab.dispatch("click");
  await view.generationCatalogPromise;
  const imageModelSelect = view.contentEl.find((element) => (
    element.tagName === "SELECT"
      && element.dataset.section === "settings"
      && element.dataset.field === "imageModel"
  ));
  const videoModelSelect = view.contentEl.find((element) => (
    element.tagName === "SELECT"
      && element.dataset.section === "settings"
      && element.dataset.field === "videoModel"
  ));
  assert(imageModelSelect, "image model must be selectable directly in Settings");
  assert(videoModelSelect, "video model must be selectable directly in Settings");
  assert(imageModelSelect.children.some((option) => option.textContent === "gpt-image-2-w"));
  assert(videoModelSelect.children.some((option) => option.textContent === "seedance-2.5"));
  assert.strictEqual(
    view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "选择生成模型"),
    null,
    "Settings must not add a redundant model-picker button below the selectors",
  );
  videoModelSelect.value = "seedance-2.5";
  await videoModelSelect.dispatch("change");
  assert.strictEqual(view.draft.settings.videoModel, "seedance-2.5");
  assert.strictEqual(plugin.generationSelectionCalls.length, 0, "project model changes must not mutate shared global selection");

  await view.onOpen();
  assert.strictEqual(timerCalls.length, 1, "reopening an open view must not duplicate polling");
  await view.onClose();
  assert.strictEqual(view.refreshTimer, null);
  assert.deepStrictEqual(clearedTimers, [1]);
  assert.strictEqual(resizeObservers[0].disconnected, true);

  const retiredModelPlugin = createPlugin({
    ...clone(readySnapshot),
    request: {
      ...clone(request),
      settings: { ...clone(request.settings), imageModel: "retired-image-model" },
    },
  });
  const retiredModelView = createView(retiredModelPlugin);
  await retiredModelView.onOpen();
  await retiredModelView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "设置").dispatch("click");
  await retiredModelView.generationCatalogPromise;
  const retiredSelect = retiredModelView.contentEl.find((element) => (
    element.tagName === "SELECT" && element.dataset.field === "imageModel"
  ));
  assert.strictEqual(retiredSelect.value, "retired-image-model");
  assert(retiredSelect.children.some((option) => option.textContent.includes("当前项目（不可用）")));
  await retiredModelView.onClose();

  const retryCatalogPlugin = createPlugin();
  retryCatalogPlugin.refreshGenerationModelCatalog = async function refreshGenerationModelCatalog() {
    this.generationCatalogCalls += 1;
    if (this.generationCatalogCalls === 1) throw new Error("目录暂时不可用");
    return { imageModels: ["gpt-image-2"], videoModels: ["MiniMax-H3"] };
  };
  const retryCatalogView = createView(retryCatalogPlugin);
  await retryCatalogView.onOpen();
  await retryCatalogView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "设置").dispatch("click");
  await retryCatalogView.generationCatalogPromise;
  assert(retryCatalogView.contentEl.find((element) => element.textContent.includes("目录暂时不可用")));
  const retryButton = retryCatalogView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "重新读取");
  assert(retryButton, "failed model catalog loads must expose an inline retry");
  await retryButton.dispatch("click");
  assert.strictEqual(retryCatalogPlugin.generationCatalogCalls, 2);
  assert.strictEqual(retryCatalogView.generationCatalogStatus, "ready");
  assert.strictEqual(retryCatalogView.contentEl.find((element) => element.textContent.includes("目录暂时不可用")), null);
  await retryCatalogView.onClose();

  const overrideRequest = clone(request);
  overrideRequest.shots[0].videoPromptOverride = "旧项目保留的最终视频提示词。";
  const overrideView = createView(createPlugin({ ...clone(readySnapshot), request: overrideRequest }));
  await overrideView.onOpen();
  await overrideView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");
  const overridePreview = overrideView.contentEl.find((element) => element.attributes["aria-label"] === "最终视频提示词预览");
  assert.match(overridePreview.value, /旧项目保留的最终视频提示词。/, "preview and paid submission must resolve the same final prompt");
  assert.match(overridePreview.value, /【项目视觉风格】/);
  await overrideView.onClose();

  const v1Request = {
    version: 1,
    confirmed: false,
    character: { prompt: "旧版固定人物" },
    settings: { imageModel: "gpt-image-2", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
    shots: [{
      title: "旧版开场",
      duration: 4,
      dialogue: "旧版台词",
      plot: "人物走入画面",
      environment: "明亮客厅",
      camera: "中景推进",
      imagePrompt: "人物在明亮客厅走入画面",
      videoPrompt: "人物走入画面",
    }],
  };
  const v1Plugin = createPlugin({
    ...clone(readySnapshot),
    request: v1Request,
    project: { ...clone(readySnapshot.project), shots: [{ id: "001", title: "旧版开场", status: "等待生成" }] },
  });
  const v1View = createView(v1Plugin);
  await v1View.onOpen();
  assert.strictEqual(v1View.dirty, true, "an in-memory legacy migration must be saved before previewing paid generation");
  assert.strictEqual(v1View.draft.version, 5, "v1 drafts must migrate in memory before the timeline editor opens");
  assert.strictEqual(v1View.draft.shots[0].timeline.length, 1);
  assert.strictEqual(v1View.draft.shots[0].sceneId, "legacy-scene-001");
  assert.strictEqual(v1View.draft.shots[0].legacyFrameMode, false, "migrated drafts must use the simplified timeline generation route");
  assert.strictEqual(v1View.draft.shots[0].imagePrompt, "人物在明亮客厅走入画面");
  assert.strictEqual(v1View.draft.shots[0].videoPrompt, "人物走入画面");
  await v1View.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");
  const v1Action = v1View.contentEl.find((element) => element.dataset.section === "timeline" && element.dataset.field === "action");
  v1Action.value = "用户修改后的旧版动作";
  await v1Action.dispatch("input");
  assert.strictEqual(v1View.draft.shots[0].timeline[0].action, "用户修改后的旧版动作");
  await v1View.onClose();

  const v1DirectPlugin = createPlugin({
    ...clone(readySnapshot),
    request: v1Request,
    project: { ...clone(readySnapshot.project), shots: [{ id: "001", title: "旧版开场", status: "等待生成" }] },
  });
  const v1DirectView = createView(v1DirectPlugin);
  await v1DirectView.onOpen();
  assert.strictEqual(await v1DirectView.generateShots(["001"]), true);
  assert.strictEqual(v1DirectPlugin.saveCalls.length, 1, "direct generation must persist the migrated v5 draft first");
  assert.strictEqual(v1DirectPlugin.saveCalls[0].request.version, 5);
  assert.strictEqual(v1DirectPlugin.queueCalls.length, 1);
  await v1DirectView.onClose();

  const fractionalV3Request = {
    version: 3,
    confirmed: false,
    character: { id: "hero", prompt: "旧版固定人物", voiceProfile: "固定女声" },
    products: [],
    scenes: [{ id: "meadow", prompt: "夕阳草地" }],
    settings: { imageModel: "gpt-image-2", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
    shots: [{
      id: "001", title: "旧版小数时长", sceneId: "meadow", productIds: [], duration: 13.5,
      dialogue: "测试台词", voiceDirection: "自然", plot: "人物说话", environment: "夕阳草地", camera: "中景",
      imagePrompt: "人物站在夕阳草地", lastImagePrompt: "", videoPrompt: "人物在夕阳草地说话",
    }],
  };
  const fractionalV3View = createView(createPlugin({
    ...clone(readySnapshot),
    request: fractionalV3Request,
    project: { ...clone(readySnapshot.project), shots: [{ id: "001", title: "旧版小数时长", status: "失败" }] },
  }));
  await fractionalV3View.onOpen();
  assert.strictEqual(fractionalV3View.draft.shots[0].duration, 14, "legacy fractional durations must migrate to a provider-supported integer");
  assert.strictEqual(fractionalV3View.draft.shots[0].timeline.at(-1).end, 14, "timeline end must follow the migrated duration");
  assert.strictEqual(await fractionalV3View.saveDraft(), true, "a migrated fractional legacy draft must save without manual timing repair");
  await fractionalV3View.onClose();

  const duplicateIdentityRequest = {
    ...clone(request),
    shots: [
      { ...clone(request.shots[0]), id: "001", workbenchId: "001", title: "A 草案" },
      { ...clone(request.shots[0]), id: "001", workbenchId: "001~2", title: "B 草案", dialogue: "B 台词" },
    ],
  };
  const duplicateIdentityPlugin = createPlugin({
    ...clone(readySnapshot),
    request: duplicateIdentityRequest,
    project: {
      ...clone(readySnapshot.project),
      shots: [
        { id: "001", workbenchId: "001", title: "A 草案" },
        { id: "001", workbenchId: "001~2", title: "B 草案" },
      ],
    },
  });
  const duplicateIdentityView = createView(duplicateIdentityPlugin);
  await duplicateIdentityView.onOpen();
  duplicateIdentityView.reorderShot(1, "up");
  await duplicateIdentityView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");
  const reorderedTitleInput = duplicateIdentityView.contentEl.find((element) => (
    element.tagName === "INPUT"
      && element.dataset.section === "shot"
      && element.dataset.index === "0"
      && element.dataset.field === "title"
  ));
  assert(reorderedTitleInput, "the reordered first shot title input should render");
  reorderedTitleInput.value = "B 视图编辑";
  await reorderedTitleInput.dispatch("input");
  await duplicateIdentityView.saveDraft();
  assert.deepStrictEqual(
    duplicateIdentityPlugin.saveCalls[0].request.shots.map((shot) => ({
      id: shot.id,
      workbenchId: shot.workbenchId,
      title: shot.title,
    })),
    [
      { id: "001", workbenchId: "001~2", title: "B 视图编辑" },
      { id: "002", workbenchId: "001", title: "A 草案" },
    ],
    "the real View save route must pass the original enriched draft to the plugin",
  );
  assert.deepStrictEqual(
    duplicateIdentityView.draft.shots.map((shot) => shot.workbenchId),
    ["001~2", "001"],
    "the reloaded View draft must retain stable identities after save",
  );
  const secondViewTitleInput = duplicateIdentityView.contentEl.find((element) => (
    element.tagName === "INPUT"
      && element.dataset.section === "shot"
      && element.dataset.index === "0"
      && element.dataset.field === "title"
  ));
  secondViewTitleInput.value = "B 视图二次编辑";
  await secondViewTitleInput.dispatch("input");
  await duplicateIdentityView.saveDraft();
  assert.deepStrictEqual(
    duplicateIdentityPlugin.saveCalls[1].request.shots.map((shot) => shot.workbenchId),
    ["001~2", "001"],
    "a second real View save must retain the same stable identities",
  );
  await duplicateIdentityView.onClose();

  const unavailablePlugin = createPlugin();
  const unavailableView = createView(unavailablePlugin);
  await unavailableView.onOpen();
  await unavailableView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");
  const unavailableInput = unavailableView.contentEl.find((element) => (
    element.tagName === "INPUT" && element.dataset.section === "shot" && element.dataset.field === "title"
  ));
  unavailableInput.value = "项目消失时保留的修改";
  await unavailableInput.dispatch("input");
  const originalFolder = unavailableView.selectedFolder;
  const replacementFolder = "山竹视频复刻/另一个项目";
  unavailablePlugin.projects = [{ folder: replacementFolder, title: "另一个项目" }];
  unavailablePlugin.snapshot = {
    ...clone(readySnapshot),
    project: { ...clone(readySnapshot.project), folder: replacementFolder, title: "另一个项目" },
    request: { ...clone(request), shots: [{ ...clone(request.shots[0]), title: "外部替代项目" }] },
  };
  const loadCallsBeforeUnavailableRefresh = unavailablePlugin.loadCalls;
  await unavailableView.refresh();
  assert.strictEqual(unavailableView.selectedFolder, originalFolder, "dirty view must not auto-switch when its project disappears");
  assert.strictEqual(unavailableView.dirty, true);
  assert.strictEqual(unavailableView.draft.shots[0].title, "项目消失时保留的修改");
  assert.strictEqual(unavailablePlugin.loadCalls, loadCallsBeforeUnavailableRefresh, "unavailable dirty project must not load a replacement");
  assert(unavailableView.contentEl.find((element) => element.textContent.includes("当前项目暂不可用")));
  const unavailableRenderCount = unavailableView.contentEl.emptyCalls;
  await unavailableView.refresh();
  assert.strictEqual(unavailableView.contentEl.emptyCalls, unavailableRenderCount, "unchanged unavailable polling must preserve the DOM");
  await unavailableView.onClose();

  const guardedOpenPlugin = createPlugin();
  const guardedOpenView = createView(guardedOpenPlugin);
  await guardedOpenView.onOpen();
  guardedOpenView.dirty = true;
  const guardedOriginalFolder = guardedOpenView.selectedFolder;
  const guardedOriginalTitle = guardedOpenView.draft.shots[0].title;
  await assert.rejects(
    () => guardedOpenView.openProject("山竹视频复刻/自动跳转新项目", "overview"),
    /未保存修改/,
    "automatic project opening must not discard another project's dirty draft",
  );
  assert.strictEqual(guardedOpenView.selectedFolder, guardedOriginalFolder);
  assert.strictEqual(guardedOpenView.draft.shots[0].title, guardedOriginalTitle);
  await guardedOpenView.onClose();

  const refreshErrorPlugin = createPlugin();
  const refreshErrorView = createView(refreshErrorPlugin);
  await refreshErrorView.onOpen();
  refreshErrorPlugin.listWorkbenchProjects = async () => { throw new Error("轮询读取失败"); };
  await refreshErrorView.refresh();
  assert(refreshErrorView.contentEl.find((element) => element.textContent === "刷新失败：轮询读取失败"), "polling failure must be visible immediately");
  refreshErrorPlugin.listWorkbenchProjects = async function listWorkbenchProjects() { return clone(this.projects); };
  await refreshErrorView.refresh();
  assert.strictEqual(
    refreshErrorView.contentEl.find((element) => element.textContent.includes("轮询读取失败")),
    null,
    "successful polling must clear the stale refresh error",
  );
  await refreshErrorView.onClose();

  const ineligiblePlugin = createPlugin({
    ...clone(readySnapshot),
    project: { ...clone(readySnapshot.project), status: "prepared", statusText: "等待分析" },
  });
  const ineligibleView = createView(ineligiblePlugin);
  await ineligibleView.onOpen();
  await ineligibleView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");
  const ineligibleInput = ineligibleView.contentEl.find((element) => (
    element.tagName === "INPUT" && element.dataset.section === "shot" && element.dataset.field === "title"
  ));
  ineligibleInput.value = "未完成分析的本地修改";
  await ineligibleInput.dispatch("input");
  await ineligibleView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "总览").dispatch("click");
  assert.strictEqual(
    ineligibleView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "确认并生成"),
    null,
    "the overview must not expose the legacy whole-project confirmation flow",
  );
  await ineligibleView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "选择分镜生成").dispatch("click");
  const ineligibleGenerate = ineligibleView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "生成此镜头");
  assert.strictEqual(ineligibleGenerate.disabled, true, "unfinished analysis must not allow a paid shot queue");
  assert.strictEqual(ineligiblePlugin.queueCalls.length, 0);
  await ineligibleView.onClose();

  const concurrentPlugin = createPlugin();
  let releaseQueue;
  let queueStarted;
  const queueBlocker = new Promise((resolve) => { releaseQueue = resolve; });
  const started = new Promise((resolve) => { queueStarted = resolve; });
  concurrentPlugin.startWorkbenchGeneration = async function startWorkbenchGeneration(folder, plan) {
    this.queueCalls.push({ folder, plan: clone(plan) });
    queueStarted();
    await queueBlocker;
  };
  const concurrentView = createView(concurrentPlugin);
  await concurrentView.onOpen();
  const firstConfirm = concurrentView.generateShots(["001"]);
  await started;
  const secondConfirm = concurrentView.generateShots(["001"]);
  assert.strictEqual(concurrentPlugin.queueCalls.length, 1, "concurrent generation confirmation must enqueue once");
  releaseQueue();
  await Promise.all([firstConfirm, secondConfirm]);
  assert.strictEqual(concurrentView.confirmPending, false);
  await concurrentView.onClose();

  const failedConfirmPlugin = createPlugin();
  failedConfirmPlugin.startWorkbenchGeneration = async () => { throw new Error("确认调用失败"); };
  const failedConfirmView = createView(failedConfirmPlugin);
  await failedConfirmView.onOpen();
  await assert.rejects(() => failedConfirmView.generateShots(["001"]), /确认调用失败/);
  assert.strictEqual(failedConfirmView.confirmPending, false, "failed confirmation must release the pending guard");
  await failedConfirmView.onClose();

  const partialLockRequest = {
    ...clone(request),
    shots: [
      clone(request.shots[0]),
      { ...clone(request.shots[0]), id: "002", title: "第二镜", videoPrompt: "第二镜动作" },
      { ...clone(request.shots[0]), id: "003", title: "第三镜", videoPrompt: "第三镜动作" },
    ],
  };
  const currentRunPlugin = createPlugin({
    ...clone(readySnapshot),
    request: partialLockRequest,
    project: {
      ...clone(readySnapshot.project),
      status: "generating",
      shots: [
        {
          id: "001",
          title: "开场",
          status: "已完成",
          videoPath: "旧成片-001.mp4",
          videoTaskId: "legacy-task",
          videoTaskProgress: 72,
        },
        { id: "002", title: "第二镜", status: "等待生成" },
        { id: "003", title: "第三镜", status: "等待生成" },
      ],
    },
    currentRun: {
      runId: "current-run-authoritative",
      status: "processing",
      activeShotId: "001",
      queue: ["001", "002"],
      shots: {
        "001": {
          id: "001",
          status: "video-processing",
          stage: "provider-generation",
          taskId: "task-current",
          paidTaskSubmitted: true,
          progress: null,
        },
        "002": {
          id: "002",
          status: "queued",
          stage: "queued",
          taskId: null,
          paidTaskSubmitted: false,
          progress: null,
        },
      },
    },
    generationQueue: {
      status: "processing",
      shots: [
        { id: "001", status: "processing" },
        { id: "002", status: "queued" },
      ],
    },
  });
  const currentRunView = createView(currentRunPlugin);
  await currentRunView.onOpen();
  assert.strictEqual(currentRunView.snapshot.currentRun.runId, "current-run-authoritative", "the loaded currentRun must survive the workbench snapshot boundary");
  assert.deepStrictEqual(currentRunView.viewModel.lockedShotIds, ["001", "002"], "processing and queued current-run shots must both be locked");
  assert.strictEqual(currentRunView.viewModel.cockpit.rail.items[1].locked, true, "a confirmed queued shot must lock before paid submission starts");
  assert.strictEqual(currentRunView.viewModel.cockpit.rail.items[2].locked, false, "a shot outside the queue must remain editable");
  assert.strictEqual(currentRunView.viewModel.cockpit.monitor.taskId, "task-current");
  assert.strictEqual(currentRunView.viewModel.cockpit.monitor.progress, null, "missing provider progress must remain null through the workbench snapshot");
  assert.strictEqual(currentRunView.viewModel.progress.percent, null);
  await currentRunView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "总览").dispatch("click");
  assert.strictEqual(
    currentRunView.contentEl.find((element) => element.textContent === "null%"),
    null,
    "overview must not invent a percentage when the provider has not returned one",
  );
  assert(currentRunView.contentEl.find((element) => element.textContent === "活动中"));
  await currentRunView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");
  await currentRunView.contentEl.find((element) => element.tagName === "BUTTON" && element.dataset.selectShotId === "002").dispatch("click");
  const queuedTitle = currentRunView.contentEl.find((element) => (
    element.tagName === "INPUT" && element.dataset.shotIndex === "1" && element.dataset.field === "title"
  ));
  assert.strictEqual(queuedTitle.disabled, true, "queued shot fields must be disabled in the cockpit");
  const queuedCheckbox = currentRunView.contentEl.find((element) => (
    element.tagName === "INPUT" && element.attributes.type === "checkbox" && element.dataset.shotId === "002"
  ));
  assert.strictEqual(queuedCheckbox.disabled, true, "queued shots must not be selectable again");
  await currentRunView.contentEl.find((element) => element.tagName === "BUTTON" && element.dataset.selectShotId === "003").dispatch("click");
  const monitorWhileEditing = currentRunView.contentEl.find((element) => element.classList.contains("generation-monitor"));
  assert(monitorWhileEditing.find((element) => element.textContent === "镜头 001"), "selecting an unqueued shot must keep shot 001 in the monitor");
  assert(monitorWhileEditing.find((element) => element.textContent === "task-current"));

  const editingTitle = currentRunView.contentEl.find((element) => (
    element.tagName === "INPUT" && element.dataset.shotIndex === "2" && element.dataset.field === "title"
  ));
  assert.strictEqual(editingTitle.disabled, false, "a shot outside the queue must remain editable");
  const editableCheckbox = currentRunView.contentEl.find((element) => (
    element.tagName === "INPUT" && element.attributes.type === "checkbox" && element.dataset.shotId === "003"
  ));
  assert.strictEqual(editableCheckbox.disabled, false, "a shot outside the queue must remain selectable");
  editingTitle.value = "第三镜后台更新不打断";
  await editingTitle.dispatch("input");
  editingTitle.focus();
  editingTitle.setSelectionRange(3, 7, "forward");
  const openPrompt = currentRunView.contentEl.find((element) => element.classList.contains("mangosteen-replica-prompt-disclosure"));
  openPrompt.open = true;
  currentRunPlugin.snapshot.currentRun.shots["001"].progress = 54;
  currentRunPlugin.snapshot.currentRun.shots["001"].elapsedMs = 405000;
  currentRunPlugin.snapshot.currentRun.shots["001"].stage = "saving";
  await currentRunView.refresh();
  const restoredTitle = currentRunView.contentEl.find((element) => (
    element.tagName === "INPUT" && element.dataset.shotIndex === "2" && element.dataset.field === "title"
  ));
  assert.notStrictEqual(restoredTitle, editingTitle, "the regression must exercise a background-triggered full render");
  assert.strictEqual(currentRunView.contentEl.ownerDocument.activeElement, restoredTitle, "background monitor updates must restore editor focus");
  assert.strictEqual(restoredTitle.selectionStart, 3);
  assert.strictEqual(restoredTitle.selectionEnd, 7);
  assert.strictEqual(restoredTitle.selectionDirection, "forward");
  assert.strictEqual(
    currentRunView.contentEl.find((element) => element.classList.contains("mangosteen-replica-prompt-disclosure")).open,
    true,
    "background monitor updates must preserve the full-prompt disclosure state",
  );
  await currentRunView.onClose();

  const partialLockView = createView(createPlugin({
    ...clone(readySnapshot),
    request: partialLockRequest,
    project: {
      ...clone(readySnapshot.project),
      status: "generating",
      shots: [
        { id: "001", title: "开场", status: "正在生成视频" },
        { id: "002", title: "第二镜", status: "等待生成" },
      ],
    },
    generationQueue: {
      status: "processing",
      stopRequested: false,
      shots: [
        { id: "001", status: "processing" },
      ],
    },
  }));
  await partialLockView.onOpen();
  await partialLockView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");
  const lockedPrompt = partialLockView.contentEl.find((element) => (
    element.tagName === "TEXTAREA" && element.dataset.shotIndex === "0" && element.dataset.field === "action"
  ));
  assert.strictEqual(lockedPrompt.disabled, true, "queued or processing shots must be locked");
  const partialShotCheckboxes = partialLockView.contentEl.findAll((element) => (
    element.tagName === "INPUT" && element.attributes.type === "checkbox" && element.dataset.shotId
  ));
  assert.strictEqual(partialShotCheckboxes[0].disabled, true, "the processing shot must not be selectable again");
  assert.strictEqual(partialShotCheckboxes[1].disabled, false, "an unqueued shot must remain selectable during generation");
  assert.strictEqual(
    partialLockView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "生成此镜头").disabled,
    true,
    "the processing shot generation button must stay locked",
  );
  const secondShotButton = partialLockView.contentEl.find((element) => (
    element.tagName === "BUTTON" && element.dataset.selectShotId === "002"
  ));
  await secondShotButton.dispatch("click");
  const editablePrompt = partialLockView.contentEl.find((element) => (
    element.tagName === "TEXTAREA" && element.dataset.shotIndex === "1" && element.dataset.field === "action"
  ));
  assert.strictEqual(editablePrompt.disabled, false, "unselected shots must remain editable");
  assert.strictEqual(
    partialLockView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "生成此镜头").disabled,
    false,
    "an unqueued shot must be appendable to the running queue",
  );
  const secondTitle = partialLockView.contentEl.find((element) => (
    element.tagName === "INPUT" && element.dataset.shotIndex === "1" && element.dataset.field === "title"
  ));
  secondTitle.value = "未保存的第二镜草案";
  await secondTitle.dispatch("input");
  await partialLockView.contentEl.find((element) => element.tagName === "BUTTON" && element.dataset.selectShotId === "001").dispatch("click");
  await partialLockView.contentEl.find((element) => element.tagName === "BUTTON" && element.dataset.selectShotId === "002").dispatch("click");
  assert.strictEqual(partialLockView.draft.shots[1].title, "未保存的第二镜草案", "shot switching must retain another shot's unsaved draft");
  assert.strictEqual(
    partialLockView.contentEl.find((element) => element.tagName === "INPUT" && element.dataset.shotIndex === "1" && element.dataset.field === "title").value,
    "未保存的第二镜草案",
  );
  assert(partialLockView.contentEl.find((element) => element.textContent.includes("镜头 001")), "the active shot progress must be visible in the workbench");
  await partialLockView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "资产").dispatch("click");
  const lockedStylePrompt = partialLockView.contentEl.find((element) => (
    element.dataset.section === "visualStyle" && element.dataset.field === "prompt"
  ));
  assert.strictEqual(lockedStylePrompt.disabled, true, "project style must stay locked while any shot is queued or processing");
  await partialLockView.onClose();

  const emptyView = createView(createPlugin({ project: {}, request: {}, generationState: {} }, []));
  await assert.doesNotReject(() => emptyView.onOpen());
  assert(emptyView.contentEl.find((element) => element.textContent === "还没有视频复刻项目"));
  await emptyView.onClose();

  const failedAnalysisSnapshot = {
    project: {
      folder: "山竹视频复刻/分析失败项目",
      title: "分析失败项目",
      status: "analysis_model_error",
      statusText: "分析模型 gpt-5.6-sol 返回错误：openai_error。请更换分析模型后重试。",
      shots: [],
    },
    request: {
      schemaVersion: 6,
      version: 5,
      confirmed: false,
      analysisStatus: "analysis_model_error",
      analysisStatusText: "分析模型 gpt-5.6-sol 返回错误：openai_error。请更换分析模型后重试。",
      visualStyle: { category: "", prompt: "" },
      character: { id: "main-character", prompt: "", voiceProfile: "" },
      products: [],
      scenes: [],
      settings: { imageModel: "", videoModel: "", ratio: "", resolution: "" },
      shots: [],
    },
    generationState: {},
    generationQueue: {},
  };
  const failedAnalysisPlugin = createPlugin(
    failedAnalysisSnapshot,
    [{ folder: failedAnalysisSnapshot.project.folder, title: failedAnalysisSnapshot.project.title }],
  );
  const failedAnalysisView = createView(failedAnalysisPlugin);
  await failedAnalysisView.onOpen();
  assert.strictEqual(failedAnalysisView.draft.visualStyle.category, "继承参考资产");
  assert.strictEqual(failedAnalysisView.draft.visualStyle.prompt.includes("全片一致"), true);
  assert(
    failedAnalysisView.contentEl.find((element) => element.textContent === "当前项目记录：上次分析失败，尚未重新发起请求"),
    "opening a saved failed project must label the message as history instead of a new startup failure",
  );
  const retryAnalysisButton = failedAnalysisView.contentEl.find((element) => (
    element.tagName === "BUTTON" && element.textContent === "重新分析"
  ));
  assert(retryAnalysisButton, "a failed project must expose an inline retry without relying on Obsidian's command palette");
  await retryAnalysisButton.dispatch("click");
  assert.deepStrictEqual(failedAnalysisPlugin.analysisCalls, [failedAnalysisSnapshot.project.folder]);
  assert.strictEqual(failedAnalysisView.analysisPending, false);
  assert(
    failedAnalysisView.contentEl.find((element) => element.textContent === "分析完成，等待确认"),
    "a successful inline retry must refresh the project state",
  );
  await failedAnalysisView.onClose();

  const lockedPlugin = createPlugin({
    ...clone(readySnapshot),
    request: { ...clone(request), confirmed: true },
  });
  const lockedView = createView(lockedPlugin);
  await assert.doesNotReject(() => lockedView.onOpen());
  await lockedView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "分镜").dispatch("click");
  assert.strictEqual(lockedView.contentEl.find((element) => element.tagName === "INPUT").disabled, true);
  await lockedView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "设置").dispatch("click");
  await lockedView.generationCatalogPromise;
  assert.strictEqual(
    lockedView.contentEl.find((element) => element.tagName === "SELECT" && element.dataset.field === "imageModel").disabled,
    true,
    "locked projects must disable model switching",
  );
  await lockedView.onClose();

  const failedPlugin = createPlugin({
    project: {
      ...clone(readySnapshot.project),
      status: "completed_with_errors",
      statusText: "部分镜头失败",
      shots: [{ id: "001", title: "开场", status: "失败", error: "上游生成失败" }],
    },
    request: { ...clone(request), confirmed: true },
    requestMtimeMs: 122,
    generationState: { status: "failed", requestMtimeMs: 122, error: "上游生成失败" },
  });
  const failedView = createView(failedPlugin);
  await assert.doesNotReject(() => failedView.onOpen());
  assert(failedView.contentEl.find((element) => element.textContent.includes("上游生成失败")));
  await failedView.onClose();

  const processingPlugin = createPlugin({
    project: {
      ...clone(readySnapshot.project),
      status: "generating",
      statusText: "正在生成镜头",
    },
    request: { ...clone(request), confirmed: true },
    requestMtimeMs: 123,
    generationState: { status: "processing", currentStep: "镜头 001", requestMtimeMs: 123 },
  });
  const processingView = createView(processingPlugin);
  await processingView.onOpen();
  const stopButton = processingView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "停止后续生成");
  assert(stopButton, "processing projects must expose a graceful stop button");
  let releaseStop;
  let stopStarted;
  const stopBlocker = new Promise((resolve) => { releaseStop = resolve; });
  const stopStartedPromise = new Promise((resolve) => { stopStarted = resolve; });
  processingPlugin.stopWorkbenchGeneration = async function stopWorkbenchGeneration(folder) {
    this.stopCalls.push(folder);
    this.snapshot.generationState.stopRequestedAt = "2026-10-11T00:01:00Z";
    stopStarted();
    await stopBlocker;
  };
  processingView.draft.shots[0].title = "停止期间保留的本地草案";
  processingView.dirty = true;
  const firstStop = processingView.stopGeneration();
  await stopStartedPromise;
  assert.strictEqual(processingView.stopPending, true);
  assert.strictEqual(
    processingView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "停止后续生成").disabled,
    true,
    "stop must disable synchronously while pending",
  );
  const secondStop = processingView.stopGeneration();
  assert.deepStrictEqual(processingPlugin.stopCalls, [readySnapshot.project.folder]);
  releaseStop();
  await Promise.all([firstStop, secondStop]);
  assert.strictEqual(processingView.stopPending, false);
  assert.strictEqual(processingView.draft.shots[0].title, "停止期间保留的本地草案", "stop refresh must preserve a dirty draft");
  assert.strictEqual(
    processingView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "停止后续生成").disabled,
    true,
    "a persisted stop request must keep the stop action disabled after refresh",
  );
  await processingView.onClose();

  const failedStopPlugin = createPlugin({
    project: { ...clone(readySnapshot.project), status: "generating" },
    request: { ...clone(request), confirmed: true },
    requestMtimeMs: 124,
    generationState: { status: "processing", requestMtimeMs: 124 },
  });
  failedStopPlugin.stopWorkbenchGeneration = async () => { throw new Error("停止调用失败"); };
  const failedStopView = createView(failedStopPlugin);
  await failedStopView.onOpen();
  await assert.rejects(() => failedStopView.stopGeneration(), /停止调用失败/);
  assert.strictEqual(failedStopView.stopPending, false, "failed stop must release the pending guard");
  assert.strictEqual(
    failedStopView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "停止后续生成").disabled,
    false,
  );
  await failedStopView.onClose();

  const invalidTimelineRequest = clone(request);
  invalidTimelineRequest.shots[0].timeline = [
    { ...invalidTimelineRequest.shots[0].timeline[0], end: 1 },
    { ...invalidTimelineRequest.shots[0].timeline[1], start: 2, end: 4 },
  ];
  const invalidTimelinePlugin = createPlugin({ ...clone(readySnapshot), request: invalidTimelineRequest });
  const invalidTimelineView = createView(invalidTimelinePlugin);
  await invalidTimelineView.onOpen();
  invalidTimelineView.dirty = true;
  assert.strictEqual(await invalidTimelineView.saveDraft(), false, "a timeline gap must block saving");
  assert.strictEqual(await invalidTimelineView.generateShots(["001"]), false, "a timeline gap must block paid generation");
  assert.strictEqual(invalidTimelinePlugin.saveCalls.length, 0);
  assert.strictEqual(invalidTimelinePlugin.queueCalls.length, 0);
  await invalidTimelineView.onClose();

  const css = fs.readFileSync(path.join(__dirname, "../styles.css"), "utf8");
  const fallbackStart = css.indexOf("@supports not (container-type: inline-size)");
  assert.notStrictEqual(fallbackStart, -1, "CSS must provide an explicit no-container-query fallback");
  const fallbackCss = css.slice(fallbackStart, css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(fallbackCss, /--replica-gap:\s*14px/);
  assert.match(fallbackCss, /--replica-pad:\s*18px/);
  assert.match(fallbackCss, /@media \(max-width: 1099px\)/);
  assert.match(fallbackCss, /\.mangosteen-replica-page-header \{ align-items: stretch; flex-direction: column; \}/);
  assert.match(fallbackCss, /\.mangosteen-replica-inline-actions \{ flex-wrap: wrap; justify-content: flex-start; \}/);
  assert.match(fallbackCss, /@media \(max-width: 759px\)/);
  assert.match(fallbackCss, /@media \(max-width: 519px\)/);
  assert.match(fallbackCss, /\.mangosteen-replica-summary-grid/);
  assert.match(fallbackCss, /\.mangosteen-replica-page-header/);
  assert.match(fallbackCss, /\.mangosteen-replica-toolbar-actions/);
  assert.match(fallbackCss, /\.mangosteen-replica-inline-actions/);
  assert.match(css, /@container\s+replica-cockpit\s+\(min-width:\s*1100px\)/);
  assert.match(css, /@container\s+replica-cockpit\s+\(min-width:\s*760px\)\s+and\s+\(max-width:\s*1099px\)/);
  assert.match(css, /grid-template-areas:\s*"rail editor monitor"/);
  assert.match(css, /grid-template-areas:\s*"rail editor"\s*"monitor monitor"/);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient/i, "the cockpit must not use AI-style gradients");

  Module._load = originalLoad;
  console.log("replica-workbench: ok");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
