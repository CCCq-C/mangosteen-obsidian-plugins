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
global.window = {
  setInterval(callback, delay) {
    const id = timerCalls.length + 1;
    timerCalls.push({ callback, delay, id });
    return id;
  },
  clearInterval(id) { clearedTimers.push(id); },
};
global.ResizeObserver = class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.disconnected = false; resizeObservers.push(this); }
  observe(element) { this.element = element; }
  disconnect() { this.disconnected = true; }
};

const {
  VIEW_TYPE,
  VideoReplicaWorkbenchView,
} = require("../replica-workbench.cjs");

const request = {
  version: 3,
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
    dialogue: "你好",
    voiceDirection: "亲切，语速中等，句尾上扬",
    plot: "人物举起手机",
    environment: "白色背景",
    camera: "缓慢推进",
    imagePrompt: "人物手持手机",
    lastImagePrompt: "人物看向镜头",
    videoPrompt: "人物举起手机，镜头推进",
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
  generationState: {},
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createPlugin(snapshot = readySnapshot, projects = [{ folder: readySnapshot.project.folder, title: "测试项目" }]) {
  return {
    snapshot: clone(snapshot),
    projects: clone(projects),
    loadCalls: 0,
    saveCalls: [],
    confirmCalls: [],
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
    async confirmWorkbenchDraft(folder) { this.confirmCalls.push(folder); },
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

  const titleInput = view.contentEl.find((element) => (
    element.tagName === "INPUT"
      && element.dataset.section === "shot"
      && element.dataset.field === "title"
  ));
  assert(titleInput, "shot title input should render");
  const voiceDirectionInput = view.contentEl.find((element) => (
    element.tagName === "TEXTAREA"
      && element.dataset.section === "shot"
      && element.dataset.field === "voiceDirection"
  ));
  assert(voiceDirectionInput, "per-shot voice direction should be editable in the workbench");
  assert.strictEqual(voiceDirectionInput.value, "亲切，语速中等，句尾上扬");
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

  await view.onOpen();
  assert.strictEqual(timerCalls.length, 1, "reopening an open view must not duplicate polling");
  await view.onClose();
  assert.strictEqual(view.refreshTimer, null);
  assert.deepStrictEqual(clearedTimers, [1]);
  assert.strictEqual(resizeObservers[0].disconnected, true);

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
  const ineligibleConfirm = ineligibleView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "确认并生成");
  assert.strictEqual(ineligibleConfirm.disabled, true, "dirty state must not bypass confirmation eligibility");
  await ineligibleView.confirmDraft();
  assert.strictEqual(ineligiblePlugin.confirmCalls.length, 0, "confirmDraft must enforce eligibility before the plugin call");
  await ineligibleView.onClose();

  const concurrentPlugin = createPlugin();
  let releaseConfirm;
  let confirmStarted;
  const confirmBlocker = new Promise((resolve) => { releaseConfirm = resolve; });
  const started = new Promise((resolve) => { confirmStarted = resolve; });
  concurrentPlugin.confirmWorkbenchDraft = async function confirmWorkbenchDraft(folder) {
    this.confirmCalls.push(folder);
    confirmStarted();
    await confirmBlocker;
  };
  const concurrentView = createView(concurrentPlugin);
  await concurrentView.onOpen();
  const firstConfirm = concurrentView.confirmDraft();
  await started;
  const pendingConfirmButton = concurrentView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "确认并生成");
  assert.strictEqual(pendingConfirmButton.disabled, true, "confirm must disable synchronously while pending");
  const secondConfirm = concurrentView.confirmDraft();
  assert.strictEqual(concurrentPlugin.confirmCalls.length, 1, "concurrent confirmation must call the plugin once");
  releaseConfirm();
  await Promise.all([firstConfirm, secondConfirm]);
  assert.strictEqual(concurrentView.confirmPending, false);
  assert.strictEqual(concurrentView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "确认并生成").disabled, false);
  await concurrentView.onClose();

  const failedConfirmPlugin = createPlugin();
  failedConfirmPlugin.confirmWorkbenchDraft = async () => { throw new Error("确认调用失败"); };
  const failedConfirmView = createView(failedConfirmPlugin);
  await failedConfirmView.onOpen();
  await assert.rejects(() => failedConfirmView.confirmDraft(), /确认调用失败/);
  assert.strictEqual(failedConfirmView.confirmPending, false, "failed confirmation must release the pending guard");
  assert.strictEqual(failedConfirmView.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "确认并生成").disabled, false);
  await failedConfirmView.onClose();

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
  await lockedView.onClose();

  const failedPlugin = createPlugin({
    project: {
      ...clone(readySnapshot.project),
      status: "completed_with_errors",
      statusText: "部分镜头失败",
      shots: [{ id: "001", title: "开场", status: "失败", error: "上游生成失败" }],
    },
    request: { ...clone(request), confirmed: true },
    generationState: { status: "failed", error: "上游生成失败" },
  });
  const failedView = createView(failedPlugin);
  await assert.doesNotReject(() => failedView.onOpen());
  assert(failedView.contentEl.find((element) => element.textContent.includes("上游生成失败")));
  await failedView.onClose();

  const css = fs.readFileSync(path.join(__dirname, "../styles.css"), "utf8");
  const fallbackStart = css.indexOf("@supports not (container-type: inline-size)");
  assert.notStrictEqual(fallbackStart, -1, "CSS must provide an explicit no-container-query fallback");
  const fallbackCss = css.slice(fallbackStart, css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(fallbackCss, /--replica-gap:\s*14px/);
  assert.match(fallbackCss, /--replica-pad:\s*18px/);
  assert.match(fallbackCss, /@media \(max-width: 1099px\)/);
  assert.match(fallbackCss, /@media \(max-width: 759px\)/);
  assert.match(fallbackCss, /@media \(max-width: 519px\)/);
  assert.match(fallbackCss, /\.mangosteen-replica-summary-grid/);
  assert.match(fallbackCss, /\.mangosteen-replica-page-header/);
  assert.match(fallbackCss, /\.mangosteen-replica-toolbar-actions/);
  assert.match(fallbackCss, /\.mangosteen-replica-inline-actions/);

  Module._load = originalLoad;
  console.log("replica-workbench: ok");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
