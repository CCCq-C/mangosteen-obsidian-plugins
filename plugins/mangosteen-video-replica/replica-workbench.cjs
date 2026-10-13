const { normalizeGenerationRequest } = require("./replica-core.cjs");
const { normalizeVideoDuration, resolveVideoPrompt, videoDurationRange } = require("./generation-policy.cjs");
const { fitTimelineDuration, legacyTimeline } = require("./shot-timeline.cjs");
const { normalizeVisualStyle } = require("./visual-style.cjs");
const {
  addTimelineSegment,
  isDraftLocked,
  moveShot,
  removeTimelineSegment,
  updateDraftField,
  validateDraft,
} = require("./replica-editor.cjs");
const {
  deriveWorkbenchState,
  stateSignature,
} = require("./replica-ui-state.cjs");
const { renderCockpit } = require("./replica-cockpit.cjs");

const VIEW_TYPE = "mangosteen-video-replica-workbench";
const TABS = [
  ["overview", "总览"],
  ["assets", "资产"],
  ["shots", "分镜"],
  ["output", "成片"],
  ["settings", "设置"],
];

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = clone(item);
  return output;
}

function editableRequest(request) {
  const next = clone(request || {});
  const version = Number(next.version || 1);
  if (version === 1 && Array.isArray(next.shots)) {
    const videoModel = text(next.settings?.videoModel, "MiniMax-H3");
    const sourceShots = list(next.shots).slice(0, 12);
    next.version = 4;
    next.confirmed = false;
    next.character = {
      id: text(next.character?.id, "main-character"),
      prompt: text(next.character?.prompt),
      voiceProfile: text(next.character?.voiceProfile),
    };
    next.products = [];
    next.scenes = sourceShots.map((shot, index) => ({
      id: `legacy-scene-${String(index + 1).padStart(3, "0")}`,
      prompt: text(shot?.environment, text(shot?.imagePrompt, text(shot?.prompt, "延续原视频对应场景的空间、光线和固定陈设。"))),
    }));
    next.settings = { ...(next.settings || {}), videoModel };
    next.shots = sourceShots.map((shot, index) => {
      const duration = normalizeVideoDuration(shot?.duration, videoModel);
      return {
        ...shot,
        id: String(index + 1).padStart(3, "0"),
        sceneId: next.scenes[index].id,
        productIds: [],
        duration,
        timeline: fitTimelineDuration(legacyTimeline({ ...shot, duration }), duration),
        legacyFrameMode: true,
      };
    });
  } else if (version >= 2 && version < 4 && Array.isArray(next.scenes)) {
    const videoModel = text(next.settings?.videoModel, "MiniMax-H3");
    next.version = 4;
    next.confirmed = false;
    if (!Array.isArray(next.products)) next.products = [];
    next.settings = { ...(next.settings || {}), videoModel };
    next.shots = list(next.shots).map((shot) => {
      const duration = normalizeVideoDuration(shot?.duration, videoModel);
      const sourceTimeline = Array.isArray(shot.timeline) && shot.timeline.length ? shot.timeline : legacyTimeline(shot);
      return {
        ...shot,
        productIds: Array.isArray(shot.productIds) ? shot.productIds : [],
        duration,
        timeline: fitTimelineDuration(sourceTimeline, duration),
        legacyFrameMode: true,
      };
    });
  }
  if (version < 5) {
    next.version = 5;
    next.confirmed = false;
    next.shots = list(next.shots).map((shot) => ({
      ...shot,
      legacyFrameMode: false,
    }));
  }
  next.visualStyle = normalizeVisualStyle(next.visualStyle);
  return next;
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function storedProjectStatus(status, statusText, { compact = false } = {}) {
  const value = text(status);
  if (value === "analysis_model_error" || value === "analysis_failed") {
    return compact
      ? "当前项目记录：上次分析失败，尚未重新发起请求"
      : `上次保存的项目状态：${text(statusText, "分析失败，请更换模型后重试。")}`;
  }
  return text(statusText, text(status, "未开始"));
}

function normalizeProjects(value) {
  return list(value).map((item) => {
    if (typeof item === "string") {
      return { folder: item, title: item.split("/").filter(Boolean).pop() || item };
    }
    const folder = text(item?.folder);
    return folder ? { ...item, folder, title: text(item?.title, folder.split("/").pop()) } : null;
  }).filter(Boolean);
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function createVideoReplicaWorkbenchView(ItemView) {
  if (typeof ItemView !== "function") throw new Error("视频复刻工作台缺少 Obsidian ItemView。请重新加载插件。");

  return class VideoReplicaWorkbenchView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = "shots";
    this.selectedFolder = "";
    this.selectedShotId = "";
    this.projects = [];
    this.snapshot = { project: {}, request: {}, activeRun: {}, currentRun: {}, generationState: {} };
    this.viewModel = deriveWorkbenchState();
    this.draft = null;
    this.dirty = false;
    this.refreshTimer = null;
    this.resizeObserver = null;
    this.refreshPromise = null;
    this.renderSignature = "";
    this.feedback = "";
    this.refreshFeedback = "";
    this.savedScrollTop = 0;
    this.collapsedSections = new Map();
    this.detailElements = [];
    this.activeControlState = null;
    this.contentScrollEl = null;
    this.widthLabelEl = null;
    this.saveButtons = [];
    this.saveStatusElements = [];
    this.confirmButtons = [];
    this.confirmPending = false;
    this.selectedShotIds = new Set();
    this.stopButtons = [];
    this.stopPending = false;
    this.promptPreviewElements = new Map();
    this.generationModelCatalog = { imageModels: [], videoModels: [] };
    this.generationCatalogStatus = "idle";
    this.generationCatalogError = "";
    this.generationCatalogPromise = null;
  }

  getViewType() { return VIEW_TYPE; }

  getDisplayText() { return "山竹视频复刻"; }

  getIcon() { return "clapperboard"; }

  async onOpen() {
    this.contentEl.addClass("mangosteen-replica-workbench");
    this.contentEl.style.containerType = "inline-size";
    if (!this.resizeObserver && typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver((entries) => {
        const width = Number(entries?.[0]?.contentRect?.width);
        if (this.widthLabelEl && Number.isFinite(width)) this.widthLabelEl.setText(`${Math.round(width)} px`);
      });
      this.resizeObserver.observe(this.contentEl);
    }
    await this.refresh({ force: !this.renderSignature });
    if (this.refreshTimer === null) {
      const timerHost = typeof window !== "undefined" ? window : globalThis;
      this.refreshTimer = timerHost.setInterval(() => { void this.refresh(); }, 2000);
    }
  }

  async onClose() {
    if (this.refreshTimer !== null) {
      const timerHost = typeof window !== "undefined" ? window : globalThis;
      timerHost.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.widthLabelEl = null;
  }

  async refresh({ force = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.loadAndRender(force).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async openProject(folder, tab = "overview") {
    const nextFolder = text(folder);
    if (!nextFolder) throw new Error("项目路径不能为空。");
    if (this.dirty && this.selectedFolder && this.selectedFolder !== nextFolder) {
      throw new Error("当前项目还有未保存修改，不能覆盖打开新项目。");
    }
    this.selectedFolder = nextFolder;
    this.activeTab = TABS.some(([id]) => id === tab) ? tab : "overview";
    this.savedScrollTop = 0;
    await this.refresh({ force: true });
    if (text(this.snapshot.project?.folder) !== nextFolder) {
      throw new Error(this.refreshFeedback || "未能打开项目总览，请手动刷新后重试。");
    }
    return true;
  }

  async loadAndRender(force) {
    try {
      const nextProjects = normalizeProjects(await this.plugin.listWorkbenchProjects());
      this.projects = nextProjects;
      const availableFolders = new Set(this.projects.map((project) => project.folder));
      if (!availableFolders.has(this.selectedFolder)) {
        if (this.dirty && this.selectedFolder) {
          this.refreshFeedback = `当前项目暂不可用：${this.selectedFolder}。本地未保存草案已保留。`;
          const unavailableSignature = this.buildRenderSignature();
          if (force || unavailableSignature !== this.renderSignature) {
            this.render();
            this.renderSignature = this.buildRenderSignature();
          }
          return;
        }
        this.selectedFolder = this.projects[0]?.folder || "";
      }

      const previousFolder = text(this.snapshot.project?.folder);
      const loaded = this.selectedFolder
        ? await this.plugin.loadWorkbenchProject(this.selectedFolder)
        : { project: {}, request: {}, activeRun: {}, currentRun: {}, generationState: {} };
      const nextSnapshot = {
        project: loaded?.project && typeof loaded.project === "object" ? loaded.project : {},
        request: loaded?.request && typeof loaded.request === "object" ? loaded.request : {},
        requestMtimeMs: typeof loaded?.requestMtimeMs === "number" && Number.isFinite(loaded.requestMtimeMs)
          ? loaded.requestMtimeMs
          : null,
        activeRun: loaded?.activeRun && typeof loaded.activeRun === "object"
          ? loaded.activeRun
          : {},
        currentRun: loaded?.currentRun?.runId
          ? loaded.currentRun
          : loaded?.latestRun?.runId
            ? loaded.latestRun
            : {},
        generationState: loaded?.generationState && typeof loaded.generationState === "object"
          ? loaded.generationState
          : {},
        generationQueue: loaded?.generationQueue && typeof loaded.generationQueue === "object"
          ? loaded.generationQueue
          : {},
      };
      const folderChanged = previousFolder !== text(nextSnapshot.project.folder);
      if (folderChanged) {
        this.dirty = false;
        this.selectedShotId = "";
      }
      if (!this.dirty || folderChanged || !this.draft) {
        const sourceVersion = Number(nextSnapshot.request?.version || 1);
        this.draft = editableRequest(nextSnapshot.request);
        if (sourceVersion < 5 && Number(this.draft?.version) === 5) this.dirty = true;
      }
      this.snapshot = nextSnapshot;
      this.updateViewModel();
      const availableShotIds = new Set(list(this.draft?.shots).map((shot) => String(shot.id)));
      this.selectedShotIds = new Set([...this.selectedShotIds].filter((id) => availableShotIds.has(id)));
      this.refreshFeedback = "";
      const nextSignature = this.buildRenderSignature();
      if (!force && nextSignature === this.renderSignature) return;
      this.render();
      this.renderSignature = this.buildRenderSignature();
    } catch (error) {
      const message = `刷新失败：${String(error?.message || error)}`;
      if (message !== this.refreshFeedback || !this.renderSignature || force) {
        this.refreshFeedback = message;
        this.render();
        this.renderSignature = this.buildRenderSignature();
      }
    }
  }

  buildRenderSignature() {
    return JSON.stringify({
      activeTab: this.activeTab,
      draft: this.draft,
      projects: this.projects.map(({ folder, title }) => ({ folder, title })),
      refreshFeedback: this.refreshFeedback,
      selectedFolder: this.selectedFolder,
      generationCatalog: {
        status: this.generationCatalogStatus,
        error: this.generationCatalogError,
        imageModels: this.generationModelCatalog.imageModels,
        videoModels: this.generationModelCatalog.videoModels,
      },
      state: stateSignature(this.viewModel),
      selectedShotId: this.selectedShotId,
      selectedShotIds: [...this.selectedShotIds],
    });
  }

  updateViewModel() {
    this.viewModel = deriveWorkbenchState({
      ...this.snapshot,
      request: this.draft || this.snapshot.request,
      selectedShotId: this.selectedShotId,
    });
    const selected = list(this.viewModel?.cockpit?.rail?.items).find((shot) => shot.selected);
    this.selectedShotId = text(selected?.id);
    return this.viewModel;
  }

  captureUiState() {
    if (this.contentScrollEl) this.savedScrollTop = Number(this.contentScrollEl.scrollTop) || 0;
    for (const { key, element } of this.detailElements) this.collapsedSections.set(key, Boolean(element.open));
    const activeElement = this.contentEl?.ownerDocument?.activeElement;
    const editableTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);
    if (!activeElement || !editableTags.has(String(activeElement.tagName || "").toUpperCase()) || !this.containsElement(activeElement)) {
      this.activeControlState = null;
      return;
    }
    const dataset = {};
    for (const key of ["section", "field", "index", "shotIndex", "segmentIndex", "shotId", "selectShotId"]) {
      if (activeElement.dataset?.[key] !== undefined) dataset[key] = String(activeElement.dataset[key]);
    }
    this.activeControlState = {
      tagName: String(activeElement.tagName || "").toUpperCase(),
      ariaLabel: this.elementAttribute(activeElement, "aria-label"),
      dataset,
      selectionStart: Number.isInteger(activeElement.selectionStart) ? activeElement.selectionStart : null,
      selectionEnd: Number.isInteger(activeElement.selectionEnd) ? activeElement.selectionEnd : null,
      selectionDirection: String(activeElement.selectionDirection || "none"),
    };
  }

  elementAttribute(element, name) {
    if (typeof element?.getAttribute === "function") return String(element.getAttribute(name) || "");
    return String(element?.attributes?.[name] || "");
  }

  containsElement(element) {
    if (typeof this.contentEl?.contains === "function") return this.contentEl.contains(element);
    let current = element;
    while (current) {
      if (current === this.contentEl) return true;
      current = current.parentElement;
    }
    return false;
  }

  editableControls() {
    if (typeof this.contentEl?.querySelectorAll === "function") {
      return [...this.contentEl.querySelectorAll("input, textarea, select")];
    }
    if (typeof this.contentEl?.findAll === "function") {
      return this.contentEl.findAll((element) => ["INPUT", "TEXTAREA", "SELECT"].includes(String(element.tagName || "").toUpperCase()));
    }
    return [];
  }

  restoreActiveControl() {
    const state = this.activeControlState;
    if (!state) return;
    const control = this.editableControls().find((element) => {
      if (String(element.tagName || "").toUpperCase() !== state.tagName) return false;
      if (this.elementAttribute(element, "aria-label") !== state.ariaLabel) return false;
      return Object.entries(state.dataset).every(([key, value]) => String(element.dataset?.[key]) === value);
    });
    if (!control || control.disabled || typeof control.focus !== "function") return;
    try { control.focus({ preventScroll: true }); } catch (_) { control.focus(); }
    if (state.selectionStart === null || state.selectionEnd === null) return;
    if (typeof control.setSelectionRange === "function") {
      control.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection);
    }
  }

  render() {
    this.captureUiState();
    this.contentEl.empty();
    this.detailElements = [];
    this.widthLabelEl = null;
    this.saveButtons = [];
    this.saveStatusElements = [];
    this.confirmButtons = [];
    this.stopButtons = [];
    this.promptPreviewElements = new Map();

    const frame = this.contentEl.createDiv({ cls: "mangosteen-replica-frame" });
    this.renderToolbar(frame);
    const shell = frame.createDiv({ cls: "mangosteen-replica-shell" });
    this.renderNavigation(shell);
    const content = shell.createDiv({ cls: "mangosteen-replica-content" });
    this.contentScrollEl = content;

    if (this.refreshFeedback) content.createDiv({ cls: "mangosteen-replica-feedback", text: this.refreshFeedback });
    if (this.feedback) content.createDiv({ cls: "mangosteen-replica-feedback", text: this.feedback });
    if (this.viewModel.empty) this.renderEmpty(content);
    else if (this.activeTab === "assets") this.renderAssets(content);
    else if (this.activeTab === "shots") this.renderShots(content);
    else if (this.activeTab === "output") this.renderOutput(content);
    else if (this.activeTab === "settings") this.renderSettings(content);
    else this.renderOverview(content);

    content.scrollTop = this.savedScrollTop;
    this.restoreActiveControl();
  }

  renderToolbar(parent) {
    const toolbar = parent.createDiv({ cls: "mangosteen-replica-toolbar" });
    const primary = toolbar.createDiv({ cls: "mangosteen-replica-toolbar-primary" });
    const brand = primary.createDiv({ cls: "mangosteen-replica-brand" });
    brand.createEl("span", { cls: "mangosteen-replica-brand-mark", text: "M" });
    const brandCopy = brand.createDiv();
    brandCopy.createEl("strong", { text: "山竹视频复刻" });
    brandCopy.createEl("small", { text: "MANGOSTEEN STUDIO" });
    const projectGroup = primary.createDiv({ cls: "mangosteen-replica-toolbar-group" });
    projectGroup.createEl("span", { cls: "mangosteen-replica-eyebrow", text: "项目" });
    const projectSelect = projectGroup.createEl("select", {
      cls: "mangosteen-replica-project-select",
      attr: { "aria-label": "选择视频复刻项目" },
    });
    if (!this.projects.length) projectSelect.createEl("option", { text: "暂无项目", attr: { value: "" } });
    for (const project of this.projects) {
      projectSelect.createEl("option", { text: project.title, attr: { value: project.folder } });
    }
    projectSelect.value = this.selectedFolder;
    projectSelect.disabled = !this.projects.length;
    projectSelect.addEventListener("change", async () => {
      if (this.dirty) {
        projectSelect.value = this.selectedFolder;
        this.setFeedback("请先保存当前草案，再切换项目。");
        return;
      }
      this.selectedFolder = projectSelect.value;
      this.savedScrollTop = 0;
      await this.refresh({ force: true });
    });

    const actions = toolbar.createDiv({ cls: "mangosteen-replica-toolbar-actions" });
    this.createButton(actions, "新建", () => this.plugin.openPrepareModal(), "mod-cta");
    this.createButton(actions, "刷新", () => this.refreshWorkbench());
    const status = actions.createDiv({ cls: "mangosteen-replica-status-pill" });
    status.createEl("span", {
      text: storedProjectStatus(this.viewModel.status, this.viewModel.statusText, { compact: true }),
    });
    this.widthLabelEl = status.createEl("span", { cls: "mangosteen-replica-width-label", text: "" });
  }

  renderNavigation(parent) {
    const navigation = parent.createEl("nav", {
      cls: "mangosteen-replica-nav",
      attr: { "aria-label": "视频复刻工作台" },
    });
    for (const [id, label] of TABS) {
      const button = navigation.createEl("button", {
        cls: id === this.activeTab ? "is-active" : "",
        text: label,
        attr: { type: "button", "aria-current": id === this.activeTab ? "page" : "false" },
      });
      button.addEventListener("click", () => {
        if (this.activeTab === id) return;
        this.activeTab = id;
        this.savedScrollTop = 0;
        this.render();
        this.renderSignature = this.buildRenderSignature();
      });
    }
  }

  renderEmpty(parent) {
    const empty = parent.createDiv({ cls: "mangosteen-replica-empty" });
    empty.createEl("h2", { text: "还没有视频复刻项目" });
    empty.createEl("p", { text: "新建项目后，这里会显示分析、资产、分镜和成片进度。" });
    this.createButton(empty, "新建视频复刻", () => this.plugin.openPrepareModal(), "mod-cta");
  }

  renderOverview(parent) {
    const header = parent.createDiv({ cls: "mangosteen-replica-page-header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "mangosteen-replica-eyebrow", text: "视频复刻工作台" });
    heading.createEl("h2", { text: text(this.viewModel.title, "未命名项目") });
    heading.createEl("p", { text: storedProjectStatus(this.viewModel.status, this.viewModel.statusText) });
    const actions = header.createDiv({ cls: "mangosteen-replica-inline-actions" });
    this.saveButtons.push(this.createButton(actions, "保存草案", () => this.saveDraft(), "mod-cta", this.editingLocked() || !this.dirty));
    this.createButton(actions, "选择分镜生成", () => {
      this.activeTab = "shots";
      this.savedScrollTop = 0;
      this.render();
      this.renderSignature = this.buildRenderSignature();
    }, "");
    this.stopButtons.push(this.createButton(
      actions,
      "停止后续生成",
      () => this.stopGeneration(),
      "mod-warning",
      this.stopPending || !this.viewModel.canStop,
    ));
    this.createButton(actions, "打开项目总览", () => this.plugin.openVaultPath(`${this.viewModel.folder}/00-项目总览.md`));

    const progressCard = parent.createDiv({ cls: "mangosteen-replica-card mangosteen-replica-progress-card" });
    const progressHeading = progressCard.createDiv({ cls: "mangosteen-replica-card-heading" });
    progressHeading.createEl("strong", { text: this.viewModel.progress.label });
    const knownProgress = typeof this.viewModel.progress.percent === "number" && Number.isFinite(this.viewModel.progress.percent);
    progressHeading.createEl("span", { text: knownProgress ? `${this.viewModel.progress.percent}%` : this.viewModel.progress.indeterminate ? "活动中" : "—" });
    const track = progressCard.createDiv({ cls: "mangosteen-replica-progress-track" });
    const bar = track.createDiv({ cls: `mangosteen-replica-progress-bar${this.viewModel.progress.indeterminate ? " is-indeterminate" : ""}` });
    bar.style.width = knownProgress ? `${Math.max(0, Math.min(100, this.viewModel.progress.percent))}%` : "0%";

    const summary = parent.createDiv({ cls: "mangosteen-replica-summary-grid" });
    this.renderMetric(summary, "当前步骤", text(this.viewModel.current.step, "等待开始"));
    this.renderMetric(summary, "当前模型", text(this.viewModel.current.model, "尚未选择"));
    this.renderMetric(summary, "已用时间", formatElapsed(this.viewModel.current.elapsedMs));
    this.renderMetric(summary, "分镜数量", String(this.viewModel.shots.length || list(this.draft?.shots).length));
    if (this.viewModel.error) parent.createDiv({ cls: "mangosteen-replica-error", text: this.viewModel.error });
  }

  renderMetric(parent, label, value) {
    const metric = parent.createDiv({ cls: "mangosteen-replica-metric" });
    metric.createEl("span", { text: label });
    metric.createEl("strong", { text: value });
  }

  async stopGeneration() {
    if (this.stopPending || !this.viewModel.canStop || !this.selectedFolder) return false;
    const confirmed = typeof window === "undefined" || typeof window.confirm !== "function" || window.confirm(
      "停止后不会再提交新的付费生成任务；已经提交到平台的当前任务仍会完成并可能产生费用。确定停止吗？",
    );
    if (!confirmed) return false;
    this.stopPending = true;
    this.syncStopState();
    try {
      await this.plugin.stopWorkbenchGeneration(this.selectedFolder);
      this.feedback = "已请求停止：当前已提交的任务完成后，不再生成后续内容。";
      await this.refresh({ force: true });
      return true;
    } finally {
      this.stopPending = false;
      this.syncStopState();
    }
  }

  renderAssets(parent) {
    this.renderPageTitle(parent, "参考资产", "编辑人物、产品和场景提示词；本地修改保存前不会被轮询覆盖。");
    const projectStyleLocked = list(this.viewModel?.lockedShotIds).length > 0;
    const styleCard = parent.createDiv({ cls: "mangosteen-replica-card mangosteen-replica-style-card" });
    styleCard.createEl("h3", { text: "项目统一视觉风格" });
    this.createDraftControl(styleCard, "风格分类", "input", this.draft?.visualStyle?.category, {
      section: "visualStyle", field: "category",
    }, { disabled: projectStyleLocked });
    this.createDraftControl(styleCard, "风格生成提示词", "textarea", this.draft?.visualStyle?.prompt, {
      section: "visualStyle", field: "prompt",
    }, { disabled: projectStyleLocked });
    styleCard.createEl("p", { cls: "mangosteen-replica-muted", text: "人物、产品、场景、首帧和视频都会自动继承这里的风格。" });
    const grid = parent.createDiv({ cls: "mangosteen-replica-asset-grid" });
    const character = this.draft?.character || {};
    const characterCard = grid.createDiv({ cls: "mangosteen-replica-card" });
    characterCard.createEl("h3", { text: `人物 · ${text(character.id, "主角")}` });
    this.createDraftControl(characterCard, "人物提示词", "textarea", character.prompt, {
      section: "character", field: "prompt",
    });
    this.createDraftControl(characterCard, "固定声音设定（语言、口音、音色、年龄感）", "textarea", character.voiceProfile, {
      section: "character", field: "voiceProfile",
    });
    this.renderAssetPath(characterCard, this.viewModel.assets.character?.imagePath);

    list(this.draft?.products).forEach((product, index) => {
      const card = grid.createDiv({ cls: "mangosteen-replica-card" });
      card.createEl("h3", { text: `产品 · ${text(product.id, String(index + 1))}` });
      this.createDraftControl(card, "产品提示词", "textarea", product.prompt, {
        section: "product", index, field: "prompt",
      });
      const asset = this.viewModel.assets.products.find((item) => item.id === product.id);
      this.renderAssetPath(card, asset?.imagePath);
    });

    list(this.draft?.scenes).forEach((scene, index) => {
      const card = grid.createDiv({ cls: "mangosteen-replica-card" });
      card.createEl("h3", { text: `场景 · ${text(scene.id, String(index + 1))}` });
      this.createDraftControl(card, "场景提示词", "textarea", scene.prompt, {
        section: "scene", index, field: "prompt",
      });
      const asset = this.viewModel.assets.scenes.find((item) => item.id === scene.id);
      this.renderAssetPath(card, asset?.imagePath);
    });
    this.renderSaveRow(parent);
  }

  renderAssetPath(parent, vaultPath) {
    if (!text(vaultPath)) {
      parent.createEl("p", { cls: "mangosteen-replica-muted", text: "参考图尚未生成" });
      return;
    }
    this.createButton(parent, "打开参考图", () => this.plugin.openVaultPath(vaultPath));
  }

  renderShots(parent) {
    this.updateViewModel();
    const model = this.cockpitRenderModel();
    renderCockpit(parent, model, {
      selectShot: (shotId) => this.selectCockpitShot(shotId),
      toggleShotSelected: (shotId, checked) => this.toggleCockpitShot(shotId, checked),
      toggleAllShots: (shotIds, checked) => this.toggleAllCockpitShots(shotIds, checked),
      updateDraftField: (target, value) => this.applyDraftControl(target, value),
      addTimelineSegment: (shotIndex, segmentIndex) => this.addTimelineRow(shotIndex, segmentIndex),
      removeTimelineSegment: (shotIndex, segmentIndex) => this.removeTimelineRow(shotIndex, segmentIndex),
      saveDraft: () => this.saveDraft(),
      generateSelected: (shotIds) => this.generateShots(shotIds),
      stopGeneration: () => this.stopGeneration(),
      refreshModels: () => this.ensureGenerationModelCatalog({ force: true }),
      openArtifact: (vaultPath) => this.plugin.openVaultPath(vaultPath),
      organizeProject: () => this.organizeCurrentProject(),
      reportError: (error) => this.setFeedback(String(error?.message || error)),
      registerButton: (kind, button, guardDisabled) => this.registerCockpitButton(kind, button, guardDisabled),
      registerSaveStatus: (element) => this.saveStatusElements.push(element),
      registerPromptPreview: (shotIndex, element) => this.promptPreviewElements.set(Number(shotIndex), element),
      registerDisclosure: (key, element) => {
        const storageKey = `cockpit:${key}`;
        element.open = this.collapsedSections.has(storageKey) ? this.collapsedSections.get(storageKey) : Boolean(element.open);
        element.addEventListener("toggle", () => this.collapsedSections.set(storageKey, Boolean(element.open)));
        this.detailElements.push({ key: storageKey, element });
      },
    });
  }

  cockpitRenderModel() {
    const cockpit = this.viewModel?.cockpit || { header: {}, rail: { items: [] }, editor: {}, monitor: {} };
    const shot = cockpit.editor?.shot || {};
    const shotId = text(shot.id);
    const editorLocked = Boolean(cockpit.editor?.locked || this.shotLocked(shotId));
    const shotIndex = Math.max(0, list(this.draft?.shots).findIndex((item) => String(item.id) === shotId));
    const draftShot = this.draft?.shots?.[shotIndex] || shot;
    const characterPath = text(this.viewModel.assets?.character?.imagePath);
    const scenePath = text(list(this.viewModel.assets?.scenes).find((item) => String(item.id) === String(draftShot.sceneId))?.imagePath);
    const productIds = new Set(list(draftShot.productIds).map(String));
    const productPaths = list(this.viewModel.assets?.products)
      .filter((item) => productIds.has(String(item.id)))
      .map((item) => text(item.imagePath))
      .filter(Boolean);
    const referenceGroups = [
      { id: "character", label: "人物参考", value: characterPath || "尚未生成", state: characterPath ? "已绑定" : "未绑定" },
      { id: "scene", label: "场景参考", value: scenePath || "尚未生成", state: scenePath ? "已绑定" : "未绑定" },
      {
        id: "product",
        label: "产品参考",
        value: productIds.size ? productPaths.join("、") || "尚未生成" : "本镜头无产品",
        state: productIds.size ? productPaths.length ? "已绑定" : "未绑定" : "无需绑定",
      },
    ];
    let effectivePrompt = text(cockpit.editor?.effectivePrompt);
    if (!editorLocked) {
      try {
        effectivePrompt = resolveVideoPrompt({
          timeline: list(draftShot.timeline).length ? draftShot.timeline : legacyTimeline(draftShot),
          duration: draftShot.duration,
          videoPrompt: draftShot.videoPrompt,
          videoPromptOverride: draftShot.videoPromptOverride,
          dialogue: draftShot.dialogue,
          voiceProfile: this.draft?.character?.voiceProfile,
          voiceDirection: draftShot.voiceDirection,
          visualStyle: this.draft?.visualStyle,
        });
      } catch (error) {
        effectivePrompt = `时间轴待修正：${String(error?.message || error)}`;
      }
    }
    const projectShot = list(this.viewModel.shots).find((item) => String(item.id) === shotId) || {};
    const activeMonitorStatus = ["processing", "reserved", "recovery-pending"].includes(text(cockpit.monitor?.status));
    return {
      ...cockpit,
      rail: {
        ...cockpit.rail,
        items: list(cockpit.rail?.items).map((item) => this.shotLocked(item.id)
          ? { ...item, locked: true, lockReason: text(item.lockReason, "当前镜头正在生成") }
          : item),
      },
      editor: {
        ...cockpit.editor,
        shot: { ...shot, ...draftShot, videoPath: text(shot.videoPath, text(projectShot.videoPath)) },
        shotIndex,
        locked: editorLocked,
        lockReason: editorLocked ? text(cockpit.editor?.lockReason, "当前镜头正在生成") : null,
        referenceGroups,
        timeline: list(draftShot.timeline).length ? draftShot.timeline : legacyTimeline(draftShot),
        effectivePrompt,
      },
      controls: {
        canGenerate: this.viewModel.canGenerate,
        canStop: this.viewModel.canStop,
        confirmPending: this.confirmPending,
        stopPending: this.stopPending,
        dirty: this.dirty,
        editingLocked: this.editingLocked(),
        selectedShotIds: [...this.selectedShotIds].filter((id) => !this.shotLocked(id)),
        durationRange: videoDurationRange(this.draft?.settings?.videoModel),
        settings: { ...(this.draft?.settings || {}) },
        sceneOptions: list(this.draft?.scenes).map((scene) => [scene.id, scene.id]),
        modelCatalogLoading: this.generationCatalogStatus === "loading",
        selectedArtifactPath: text(projectShot.videoPath),
        outputPath: text(this.viewModel.output?.finalVideoPath),
        organizeDisabled: activeMonitorStatus || list(this.viewModel.lockedShotIds).length > 0,
      },
    };
  }

  selectCockpitShot(shotId) {
    const selected = String(shotId || "");
    if (!list(this.draft?.shots).some((shot) => String(shot.id) === selected)) return;
    this.selectedShotId = selected;
    this.updateViewModel();
    this.savedScrollTop = 0;
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }

  toggleCockpitShot(shotId, checked) {
    const id = String(shotId || "");
    if (!id || this.shotLocked(id)) return;
    if (checked) this.selectedShotIds.add(id);
    else this.selectedShotIds.delete(id);
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }

  toggleAllCockpitShots(shotIds, checked) {
    for (const id of list(shotIds).map(String)) {
      if (this.shotLocked(id)) continue;
      if (checked) this.selectedShotIds.add(id);
      else this.selectedShotIds.delete(id);
    }
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }

  registerCockpitButton(kind, button, guardDisabled = false) {
    if (kind === "save") this.saveButtons.push(button);
    if (kind === "confirm") {
      button.dataset.guardDisabled = guardDisabled ? "true" : "false";
      this.confirmButtons.push(button);
    }
    if (kind === "stop") this.stopButtons.push(button);
  }

  async organizeCurrentProject() {
    if (typeof this.plugin.organizeCurrentReplicaProject !== "function") {
      this.setFeedback("当前版本不支持从工作台整理项目。");
      return false;
    }
    const organized = await this.plugin.organizeCurrentReplicaProject();
    await this.refresh({ force: true });
    return organized;
  }

  renderOutput(parent) {
    this.renderPageTitle(parent, "最终成片", "查看并打开已拼接的视频文件。");
    const card = parent.createDiv({ cls: "mangosteen-replica-card mangosteen-replica-output-card" });
    if (this.viewModel.output.finalVideoPath) {
      card.createEl("h3", { text: "成片已就绪" });
      card.createEl("p", { text: this.viewModel.output.finalVideoPath });
      this.createButton(card, "打开最终成片", () => this.plugin.openVaultPath(this.viewModel.output.finalVideoPath), "mod-cta");
    } else {
      card.createEl("h3", { text: "成片尚未生成" });
      card.createEl("p", { cls: "mangosteen-replica-muted", text: "分镜全部完成后会自动拼接。" });
    }
    if (this.viewModel.output.concatError) card.createDiv({ cls: "mangosteen-replica-error", text: this.viewModel.output.concatError });
  }

  renderSettings(parent) {
    this.renderPageTitle(parent, "生成设置", "调整草案使用的图片模型、视频模型和输出规格。");
    if (this.generationCatalogStatus === "idle") void this.ensureGenerationModelCatalog();
    const card = parent.createDiv({ cls: "mangosteen-replica-card mangosteen-replica-settings" });
    const settings = this.draft?.settings || {};
    const modelGrid = card.createDiv({ cls: "mangosteen-replica-model-grid" });
    this.createModelControl(modelGrid, "图片模型", "imageModel", settings.imageModel, this.generationModelCatalog.imageModels);
    this.createModelControl(modelGrid, "视频模型", "videoModel", settings.videoModel, this.generationModelCatalog.videoModels);
    if (this.generationCatalogStatus === "loading") {
      card.createEl("p", { cls: "mangosteen-replica-muted", text: "正在读取当前账号可用模型…" });
    } else if (this.generationCatalogError) {
      const errorRow = card.createDiv({ cls: "mangosteen-replica-model-error" });
      errorRow.createDiv({ cls: "mangosteen-replica-error", text: `模型读取失败：${this.generationCatalogError}` });
      this.createButton(errorRow, "重新读取", () => this.ensureGenerationModelCatalog({ force: true }));
    }
    const row = card.createDiv({ cls: "mangosteen-replica-form-row" });
    this.createDraftControl(row, "画面比例", "select", settings.ratio, { section: "settings", field: "ratio" }, {
      options: [["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"]],
    });
    this.createDraftControl(row, "清晰度", "select", settings.resolution, { section: "settings", field: "resolution" }, {
      options: [["720p", "720p"], ["768p", "768p"], ["1080p", "1080p"]],
    });
    this.renderSaveRow(parent);
  }

  createModelControl(parent, labelText, field, currentValue, availableModels) {
    const current = text(currentValue);
    const available = [...new Set(list(availableModels).map(String).filter(Boolean))];
    const models = current && !available.includes(current) ? [current, ...available] : available;
    const options = models.length
      ? models.map((model) => [model, available.includes(model) ? model : `${model} · 当前项目（不可用）`])
      : [[current, current || "正在读取可用模型…"]];
    return this.createDraftControl(parent, labelText, "select", current, {
      section: "settings", field,
    }, {
      options,
      disabled: this.generationCatalogStatus !== "ready" || !available.length,
    });
  }

  ensureGenerationModelCatalog({ force = false } = {}) {
    if (!force && this.generationCatalogStatus === "ready") return Promise.resolve(this.generationModelCatalog);
    if (this.generationCatalogStatus === "loading" && this.generationCatalogPromise) return this.generationCatalogPromise;
    this.generationCatalogStatus = "loading";
    this.generationCatalogError = "";
    this.generationCatalogPromise = Promise.resolve(this.plugin.refreshGenerationModelCatalog())
      .then((catalog) => {
        this.generationModelCatalog = {
          imageModels: [...new Set(list(catalog?.imageModels).map(String).filter(Boolean))],
          videoModels: [...new Set(list(catalog?.videoModels).map(String).filter(Boolean))],
        };
        this.generationCatalogStatus = "ready";
        return this.generationModelCatalog;
      })
      .catch((error) => {
        this.generationCatalogStatus = "error";
        this.generationCatalogError = String(error?.message || error);
        return this.generationModelCatalog;
      })
      .finally(() => {
        if (this.activeTab === "settings" || this.activeTab === "shots") {
          this.render();
          this.renderSignature = this.buildRenderSignature();
        }
      });
    return this.generationCatalogPromise;
  }

  async refreshWorkbench() {
    if (this.activeTab === "settings") await this.ensureGenerationModelCatalog({ force: true });
    return this.refresh({ force: true });
  }

  renderPageTitle(parent, title, description) {
    const header = parent.createDiv({ cls: "mangosteen-replica-page-header" });
    const copy = header.createDiv();
    copy.createEl("h2", { text: title });
    copy.createEl("p", { text: description });
  }

  renderSaveRow(parent) {
    const actions = parent.createDiv({ cls: "mangosteen-replica-save-row" });
    this.saveStatusElements.push(actions.createEl("span", {
      text: this.editingLocked() ? "草案已锁定" : this.dirty ? "有未保存修改" : "草案已保存",
    }));
    this.saveButtons.push(this.createButton(actions, "保存草案", () => this.saveDraft(), "mod-cta", this.editingLocked() || !this.dirty));
  }

  createDraftControl(parent, labelText, tagName, value, target, options = {}) {
    const label = parent.createEl("label", { cls: "mangosteen-replica-field" });
    if (options.className) label.addClass(options.className);
    label.createEl("span", { text: labelText });
    const control = label.createEl(tagName, { attr: { "aria-label": labelText } });
    control.dataset.section = target.section;
    control.dataset.field = target.field;
    if (target.index !== undefined) control.dataset.index = String(target.index);
    if (target.shotIndex !== undefined) control.dataset.shotIndex = String(target.shotIndex);
    if (target.segmentIndex !== undefined) control.dataset.segmentIndex = String(target.segmentIndex);
    if (tagName === "select") {
      for (const [optionValue, optionLabel] of options.options || []) {
        control.createEl("option", { text: optionLabel, attr: { value: optionValue } });
      }
    }
    if (options.inputType) control.setAttr("type", options.inputType);
    if (options.min) control.setAttr("min", options.min);
    if (options.max) control.setAttr("max", options.max);
    if (options.step) control.setAttr("step", options.step);
    control.value = value === undefined || value === null ? "" : String(value);
    control.disabled = this.editingLocked() || Boolean(options.disabled);
    control.addEventListener(tagName === "select" ? "change" : "input", async () => {
      const nextValue = ["duration", "start", "end"].includes(target.field) ? Number(control.value) : control.value;
      await this.applyDraftControl(target, nextValue, control, options);
    });
    return control;
  }

  async applyDraftControl(target, nextValue, control = null, options = {}) {
    try {
      this.draft = updateDraftField(this.draft, target, nextValue);
      this.dirty = true;
      this.feedback = "";
      this.updateViewModel();
      this.syncSaveState();
      if (target.section === "timeline") this.refreshPromptPreview(target.shotIndex);
      else if (target.section === "shot" && target.field === "duration") this.refreshPromptPreview(target.index);
      else if ((target.section === "character" && target.field === "voiceProfile") || target.section === "visualStyle") this.refreshAllPromptPreviews();
      this.renderSignature = this.buildRenderSignature();
      if (typeof options.onChange === "function") await options.onChange(nextValue, control);
      return true;
    } catch (error) {
      this.setFeedback(String(error?.message || error));
      return false;
    }
  }

  refreshPromptPreview(shotIndex) {
    const preview = this.promptPreviewElements.get(Number(shotIndex));
    const shot = this.draft?.shots?.[Number(shotIndex)];
    if (!preview || !shot) return;
    const timeline = list(shot.timeline).length ? list(shot.timeline) : legacyTimeline(shot);
    try {
      preview.value = resolveVideoPrompt({
        timeline,
        duration: shot.duration,
        videoPrompt: shot.videoPrompt,
        videoPromptOverride: shot.videoPromptOverride,
        dialogue: shot.dialogue,
        voiceProfile: this.draft?.character?.voiceProfile,
        voiceDirection: shot.voiceDirection,
        visualStyle: this.draft?.visualStyle,
      });
    } catch (error) {
      preview.value = `时间轴待修正：${String(error?.message || error)}`;
    }
  }

  refreshAllPromptPreviews() {
    for (const shotIndex of this.promptPreviewElements.keys()) this.refreshPromptPreview(shotIndex);
  }

  createButton(parent, label, action, className = "", disabled = false) {
    const button = parent.createEl("button", {
      cls: className,
      text: label,
      attr: { type: "button" },
    });
    button.disabled = Boolean(disabled);
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      try {
        await action();
      } catch (error) {
        this.setFeedback(String(error?.message || error));
      }
    });
    return button;
  }

  syncSaveState() {
    const locked = this.editingLocked();
    for (const button of this.saveButtons) button.disabled = locked || !this.dirty;
    const label = locked ? "草案已锁定" : this.dirty ? "有未保存修改" : "草案已保存";
    for (const element of this.saveStatusElements) element.setText(label);
  }

  syncConfirmState() {
    const disabled = this.confirmPending || !this.viewModel.canGenerate;
    for (const button of this.confirmButtons) {
      button.disabled = disabled || button.dataset.guardDisabled === "true";
    }
  }

  syncStopState() {
    const disabled = this.stopPending || !this.viewModel.canStop;
    for (const button of this.stopButtons) button.disabled = disabled;
  }

  createDetails(parent, key, label, defaultOpen) {
    const details = parent.createEl("details", { cls: "mangosteen-replica-details" });
    details.open = this.collapsedSections.has(key) ? this.collapsedSections.get(key) : defaultOpen;
    details.createEl("summary", { text: label });
    details.addEventListener("toggle", () => this.collapsedSections.set(key, Boolean(details.open)));
    this.detailElements.push({ key, element: details });
    return details;
  }

  editingLocked() {
    return this.viewModel.empty
      || this.viewModel.locked
      || isDraftLocked(this.draft, this.snapshot.generationState);
  }

  shotLocked(shotId) {
    return list(this.viewModel.lockedShotIds).includes(String(shotId));
  }

  queueStatusLabel(status) {
    return ({
      idle: "等待开始",
      queued: "排队中",
      processing: "生成中",
      completed: "已完成",
      completed_with_errors: "部分失败",
      failed: "失败",
      stopped: "已停止",
    })[String(status)] || String(status || "");
  }

  reorderShot(index, direction) {
    if (this.editingLocked()) return;
    this.draft = moveShot(this.draft, index, direction);
    this.dirty = true;
    this.updateViewModel();
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }

  addTimelineRow(shotIndex, segmentIndex) {
    if (this.editingLocked() || this.shotLocked(this.draft?.shots?.[shotIndex]?.id)) return;
    this.draft = addTimelineSegment(this.draft, shotIndex, segmentIndex);
    this.dirty = true;
    this.updateViewModel();
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }

  removeTimelineRow(shotIndex, segmentIndex) {
    if (this.editingLocked() || this.shotLocked(this.draft?.shots?.[shotIndex]?.id)) return;
    this.draft = removeTimelineSegment(this.draft, shotIndex, segmentIndex);
    this.dirty = true;
    this.updateViewModel();
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }

  async saveDraft() {
    if (this.editingLocked() || !this.draft || !this.selectedFolder) return false;
    const validation = validateDraft(this.draft, normalizeGenerationRequest);
    if (!validation.ok) {
      this.setFeedback(validation.errors.map((error) => `${error.path}：${error.message}`).join("；"));
      return false;
    }
    const savedDraft = await this.plugin.saveWorkbenchDraft(this.selectedFolder, this.draft);
    this.draft = clone(savedDraft || this.draft);
    this.dirty = false;
    this.feedback = "草案已保存。";
    await this.refresh({ force: true });
    return true;
  }

  async generateShots(selectedShotIds) {
    if (this.confirmPending || !this.viewModel.canGenerate || !this.selectedFolder) return false;
    const selected = [...new Set(list(selectedShotIds).map(String).filter(Boolean))];
    if (!selected.length) return false;
    this.confirmPending = true;
    this.syncConfirmState();
    try {
      if (this.dirty && !(await this.saveDraft())) return false;
      if (!this.viewModel.canGenerate || !this.selectedFolder) return false;
      const plan = await this.plugin.previewWorkbenchGeneration(this.selectedFolder, selected);
      const plannedShotIds = list(plan?.selectedShotIds).map((id) => String(id)).filter(Boolean);
      const message = `是否生成（分镜 ${(plannedShotIds.length ? plannedShotIds : selected).join("、")}）？\n\n${text(
        plan?.warning,
        "确认后，所选分镜在本次生成期间将无法更改。",
      )}`;
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function" || window.confirm(message);
      if (!confirmed) return false;
      await this.plugin.startWorkbenchGeneration(this.selectedFolder, plan);
      for (const id of selected) this.selectedShotIds.delete(id);
      this.feedback = `已加入生成队列：${selected.length} 个镜头。`;
      await this.refresh({ force: true });
      return true;
    } finally {
      this.confirmPending = false;
      this.syncConfirmState();
    }
  }

  setFeedback(message) {
    this.feedback = text(message, "操作失败。");
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }
  };
}

module.exports = {
  VIEW_TYPE,
  createVideoReplicaWorkbenchView,
};
