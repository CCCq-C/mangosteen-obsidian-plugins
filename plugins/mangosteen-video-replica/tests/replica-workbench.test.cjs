const assert = require("assert");
const Module = require("module");

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
  character: { id: "hero", prompt: "短发人物，蓝色工装" },
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
  titleInput.value = "本地改名";
  await titleInput.dispatch("input");
  assert.strictEqual(view.dirty, true);
  assert.strictEqual(view.draft.shots[0].title, "本地改名");

  plugin.snapshot.request.shots[0].title = "外部改名";
  plugin.snapshot.project.statusText = "轮询状态变化";
  await view.refresh();
  assert.strictEqual(view.draft.shots[0].title, "本地改名", "polling must not replace a dirty draft");

  const saveButton = view.contentEl.find((element) => element.tagName === "BUTTON" && element.textContent === "保存草案");
  assert(saveButton, "save button should render");
  await saveButton.dispatch("click");
  assert.strictEqual(plugin.saveCalls.length, 1);
  assert.strictEqual(plugin.saveCalls[0].request.shots[0].title, "本地改名");
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

  Module._load = originalLoad;
  console.log("replica-workbench: ok");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
