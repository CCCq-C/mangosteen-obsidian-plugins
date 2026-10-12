const assert = require("assert");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.filter(Boolean).forEach((name) => this.values.add(name)); }
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
    this.checked = false;
    this.open = false;
  }

  set innerHTML(_) { throw new Error("cockpit rendering must not inject HTML strings"); }
  get innerHTML() { return ""; }

  addClass(...names) { this.classList.add(...names.flatMap((name) => String(name).split(/\s+/))); }
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
  empty() { this.children = []; this.textContent = ""; }
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

function textTree(element) {
  return [element.textContent, ...element.children.map(textTree)].filter(Boolean).join(" ");
}

function cockpitModel(selectedShotId = "001", progress = 68) {
  const shots = [
    {
      id: "001",
      title: "正在生成的镜头",
      status: "processing",
      selected: selectedShotId === "001",
      locked: true,
      lockReason: "当前镜头正在生成",
      paidTaskSubmitted: true,
      taskId: "task_real_001",
      progress,
    },
    {
      id: "002",
      title: "未保存的下一镜",
      status: "ready",
      selected: selectedShotId === "002",
      locked: false,
      lockReason: null,
      paidTaskSubmitted: false,
      taskId: null,
      progress: null,
    },
  ];
  const selected = shots.find((shot) => shot.id === selectedShotId);
  const draftShots = {
    "001": {
      id: "001",
      title: "正在生成的镜头",
      duration: 8,
      sceneId: "city",
      productIds: [],
      timeline: [{
        start: 0,
        end: 8,
        action: "人物向前走",
        dialogue: "继续走。",
        performance: "低声、坚定",
        camera: "中景跟拍",
        environment: "城市后街",
      }],
      videoPath: "03-分镜/001/视频.mp4",
    },
    "002": {
      id: "002",
      title: "未保存的下一镜",
      duration: 6,
      sceneId: "cafe",
      productIds: ["cup"],
      timeline: [{
        start: 0,
        end: 6,
        action: "人物放下咖啡",
        dialogue: "明天见。",
        performance: "轻松自然",
        camera: "近景固定",
        environment: "街角咖啡店",
      }],
    },
  };
  return {
    header: {
      title: "驾驶舱测试项目",
      completed: 7,
      total: 10,
      currentText: `镜头 ${selectedShotId} · ${selected.status === "processing" ? "生成中" : "可编辑"}`,
      percent: selectedShotId === "001" ? progress : null,
    },
    rail: { items: shots },
    editor: {
      shot: draftShots[selectedShotId],
      shotIndex: selectedShotId === "001" ? 0 : 1,
      locked: selected.locked,
      lockReason: selected.lockReason,
      references: ["人物.png", `${draftShots[selectedShotId].sceneId}.png`],
      referenceGroups: [
        { id: "character", label: "人物参考", value: "人物.png", state: "已绑定" },
        { id: "scene", label: "场景参考", value: `${draftShots[selectedShotId].sceneId}.png`, state: "已绑定" },
        { id: "product", label: "产品参考", value: selectedShotId === "002" ? "cup.png" : "本镜头无产品", state: selectedShotId === "002" ? "已绑定" : "无需绑定" },
      ],
      timeline: draftShots[selectedShotId].timeline,
      effectivePrompt: `完整最终提示词 ${selectedShotId}`,
    },
    monitor: {
      status: selectedShotId === "001" ? "processing" : "ready",
      model: "MiniMax-H3",
      taskId: selectedShotId === "001" ? "task_real_001" : null,
      elapsedMs: 402000,
      progress: selectedShotId === "001" ? progress : null,
      stages: [
        { id: "references", label: "参考资产", status: "done" },
        { id: "first-frame", label: "首帧", status: "done" },
        { id: "last-frame", label: "尾帧", status: "done" },
        { id: "provider", label: "视频生成", status: selectedShotId === "001" ? "active" : "waiting" },
        { id: "saving", label: "保存成片", status: "waiting" },
      ],
      error: selectedShotId === "001"
        ? { message: "平台查询失败", nextAction: "继续查询原任务，禁止重复提交" }
        : null,
    },
    controls: {
      canGenerate: true,
      canStop: true,
      confirmPending: false,
      stopPending: false,
      dirty: true,
      editingLocked: false,
      selectedShotIds: ["002"],
      durationRange: { min: 4, max: 15, step: 1 },
      settings: { videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
      sceneOptions: [["city", "city"], ["cafe", "cafe"]],
      organizeDisabled: true,
    },
  };
}

const {
  renderCockpit,
  renderGenerationMonitor,
  renderShotEditor,
  renderShotRail,
} = require("../replica-cockpit.cjs");

assert.deepStrictEqual(
  Object.keys(require("../replica-cockpit.cjs")).sort(),
  ["renderCockpit", "renderGenerationMonitor", "renderShotEditor", "renderShotRail"],
);

(async () => {
  const drafts = {
    "001": { title: "镜头 001 未保存草案" },
    "002": { title: "镜头 002 未保存草案" },
  };
  let selectedShotId = "001";
  const selectedForGeneration = new Set(["002"]);
  const calls = { save: 0, generate: [], stop: 0, refresh: 0, open: [], organize: 0, fields: [] };
  const parent = new FakeElement();
  const actions = {
    selectShot(id) {
      selectedShotId = id;
      parent.empty();
      renderCockpit(parent, cockpitModel(selectedShotId), actions);
    },
    toggleShotSelected(id, checked) {
      if (checked) selectedForGeneration.add(id);
      else selectedForGeneration.delete(id);
    },
    updateDraftField(target, value) { calls.fields.push({ target, value }); },
    addTimelineSegment() {},
    removeTimelineSegment() {},
    saveDraft() { calls.save += 1; },
    generateSelected(ids) { calls.generate.push([...ids]); },
    stopGeneration() { calls.stop += 1; },
    refreshModels() { calls.refresh += 1; },
    openArtifact(path) { calls.open.push(path); },
    organizeProject() { calls.organize += 1; },
  };

  const originalModel = cockpitModel();
  const originalSnapshot = JSON.stringify(originalModel);
  renderCockpit(parent, originalModel, actions);
  assert.strictEqual(JSON.stringify(originalModel), originalSnapshot, "rendering must not mutate the cockpit ViewModel");

  const workspace = parent.find((element) => element.classList.contains("mangosteen-replica-cockpit-grid"));
  assert(workspace, "cockpit workspace must render");
  assert.deepStrictEqual(
    workspace.children.map((element) => ["shot-rail", "shot-editor", "generation-monitor"].find((name) => element.classList.contains(name))),
    ["shot-rail", "shot-editor", "generation-monitor"],
    "wide-screen DOM order must stay rail, editor, monitor",
  );

  const lockedTitle = parent.find((element) => (
    element.tagName === "INPUT" && element.dataset.section === "shot" && element.dataset.field === "title"
  ));
  assert.strictEqual(lockedTitle.disabled, true, "the processing shot editor must be disabled");
  const secondCheckbox = parent.find((element) => element.dataset.shotId === "002" && element.attributes.type === "checkbox");
  assert.strictEqual(secondCheckbox.disabled, false, "other shots must remain selectable while one shot is processing");

  const secondShot = parent.find((element) => element.tagName === "BUTTON" && element.dataset.selectShotId === "002");
  await secondShot.dispatch("click");
  assert.strictEqual(selectedShotId, "002");
  assert.deepStrictEqual(drafts, {
    "001": { title: "镜头 001 未保存草案" },
    "002": { title: "镜头 002 未保存草案" },
  }, "switching shots must not reset any unsaved draft");
  const editableTitle = parent.find((element) => (
    element.tagName === "INPUT" && element.dataset.section === "shot" && element.dataset.field === "title"
  ));
  assert.strictEqual(editableTitle.disabled, false, "a non-processing shot must remain editable");
  assert.doesNotMatch(
    textTree(parent.find((element) => element.classList.contains("mangosteen-replica-cockpit-header"))),
    /活动中/,
    "an idle editable shot must not be labeled as active just because progress is unknown",
  );

  parent.empty();
  renderCockpit(parent, cockpitModel("001"), actions);
  const monitorText = textTree(parent.find((element) => element.classList.contains("generation-monitor")));
  assert.match(monitorText, /task_real_001/, "monitor must show the real task ID");
  assert.match(monitorText, /68%/, "monitor must show only the supplied numeric progress");
  assert.match(monitorText, /已等待 06:42/, "monitor must show elapsed waiting time");
  assert.match(monitorText, /参考资产/);
  assert.match(monitorText, /视频生成/);
  assert.match(monitorText, /平台查询失败/);
  assert.match(monitorText, /继续查询原任务，禁止重复提交/, "monitor errors must include a clear next action");

  const promptDisclosure = parent.find((element) => element.classList.contains("mangosteen-replica-prompt-disclosure"));
  assert(promptDisclosure, "the final prompt must remain available on demand");
  assert.strictEqual(promptDisclosure.tagName, "DETAILS");
  assert.strictEqual(promptDisclosure.open, false, "the complete prompt must be collapsed by default");
  assert.strictEqual(
    parent.findAll((element) => element.attributes["aria-label"] === "最终视频提示词预览").length,
    1,
    "only the selected shot prompt may be present",
  );

  const unknownParent = new FakeElement();
  renderCockpit(unknownParent, cockpitModel("001", null), actions);
  const unknownMonitor = textTree(unknownParent.find((element) => element.classList.contains("generation-monitor")));
  assert.match(unknownMonitor, /平台未提供百分比/);
  assert.doesNotMatch(unknownMonitor, /(?:^|\s)\d+%(?:\s|$)/, "unknown progress must not be converted into a percentage");

  console.log("replica-cockpit: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
