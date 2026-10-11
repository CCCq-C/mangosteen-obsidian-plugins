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
  constructor(tagName = "div") {
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
  }

  set innerHTML(_) { throw new Error("runtime UI must not inject HTML strings"); }
  get innerHTML() { return ""; }

  addClass(...names) { this.classList.add(...names.flatMap((name) => String(name).split(/\s+/))); }
  removeClass(...names) { this.classList.remove(...names); }
  setText(value) { this.textContent = String(value); }
  setAttr(name, value) { this.attributes[name] = String(value); }

  createEl(tagName, options = {}) {
    const child = new FakeElement(tagName);
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
  version: 4,
  confirmed: false,
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
  const shotList = view.contentEl.find((element) => element.classList.contains("mangosteen-replica-shot-list"));
  assert(shotList, "storyboards must render as one vertical shot list");
  assert.strictEqual(
    shotList.findAll((element) => element.classList.contains("mangosteen-replica-shot-summary-row")).length,
    view.draft.shots.length,
    "each storyboard shot must have one compact summary row",
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
    ],
  };
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
  const editablePrompt = partialLockView.contentEl.find((element) => (
    element.tagName === "TEXTAREA" && element.dataset.shotIndex === "1" && element.dataset.field === "action"
  ));
  assert.strictEqual(lockedPrompt.disabled, true, "queued or processing shots must be locked");
  assert.strictEqual(editablePrompt.disabled, false, "unselected shots must remain editable");
  const partialShotCheckboxes = partialLockView.contentEl.findAll((element) => (
    element.tagName === "INPUT" && element.attributes.type === "checkbox" && element.dataset.shotId
  ));
  assert.strictEqual(partialShotCheckboxes[0].disabled, true, "the processing shot must not be selectable again");
  assert.strictEqual(partialShotCheckboxes[1].disabled, false, "an unqueued shot must remain selectable during generation");
  const partialGenerateButtons = partialLockView.contentEl.findAll((element) => (
    element.tagName === "BUTTON" && element.textContent === "生成此镜头"
  ));
  assert.strictEqual(partialGenerateButtons[0].disabled, true, "the processing shot generation button must stay locked");
  assert.strictEqual(partialGenerateButtons[1].disabled, false, "an unqueued shot must be appendable to the running queue");
  assert(partialLockView.contentEl.find((element) => element.textContent.includes("镜头 001")), "the active shot progress must be visible in the workbench");
  await partialLockView.onClose();

  const emptyView = createView(createPlugin({ project: {}, request: {}, generationState: {} }, []));
  await assert.doesNotReject(() => emptyView.onOpen());
  assert(emptyView.contentEl.find((element) => element.textContent === "还没有视频复刻项目"));
  await emptyView.onClose();

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
  assert.match(css, /\.mangosteen-replica-shot-list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);

  Module._load = originalLoad;
  console.log("replica-workbench: ok");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
