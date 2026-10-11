const { normalizeGenerationRequest } = require("./replica-core.cjs");
const { normalizeVideoDuration, resolveVideoPrompt, videoDurationRange } = require("./generation-policy.cjs");
const { fitTimelineDuration, legacyTimeline } = require("./shot-timeline.cjs");
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
  return next;
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function list(value) {
  return Array.isArray(value) ? value : [];
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
    this.activeTab = "overview";
    this.selectedFolder = "";
    this.projects = [];
    this.snapshot = { project: {}, request: {}, generationState: {} };
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
        : { project: {}, request: {}, generationState: {} };
      const nextSnapshot = {
        project: loaded?.project && typeof loaded.project === "object" ? loaded.project : {},
        request: loaded?.request && typeof loaded.request === "object" ? loaded.request : {},
        requestMtimeMs: typeof loaded?.requestMtimeMs === "number" && Number.isFinite(loaded.requestMtimeMs)
          ? loaded.requestMtimeMs
          : null,
        generationState: loaded?.generationState && typeof loaded.generationState === "object"
          ? loaded.generationState
          : {},
        generationQueue: loaded?.generationQueue && typeof loaded.generationQueue === "object"
          ? loaded.generationQueue
          : {},
      };
      const folderChanged = previousFolder !== text(nextSnapshot.project.folder);
      if (folderChanged) this.dirty = false;
      if (!this.dirty || folderChanged || !this.draft) {
        const sourceVersion = Number(nextSnapshot.request?.version || 1);
        this.draft = editableRequest(nextSnapshot.request);
        if (sourceVersion < 4 && Number(this.draft?.version) === 4) this.dirty = true;
      }
      this.snapshot = nextSnapshot;
      this.viewModel = deriveWorkbenchState(nextSnapshot);
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
      selectedShotIds: [...this.selectedShotIds],
    });
  }

  captureUiState() {
    if (this.contentScrollEl) this.savedScrollTop = Number(this.contentScrollEl.scrollTop) || 0;
    for (const { key, element } of this.detailElements) this.collapsedSections.set(key, Boolean(element.open));
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
    status.createEl("span", { text: text(this.viewModel.statusText, text(this.viewModel.status, "未开始")) });
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
    heading.createEl("p", { text: text(this.viewModel.statusText, "等待下一步") });
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
    progressHeading.createEl("span", { text: `${this.viewModel.progress.percent}%` });
    const track = progressCard.createDiv({ cls: "mangosteen-replica-progress-track" });
    const bar = track.createDiv({ cls: `mangosteen-replica-progress-bar${this.viewModel.progress.indeterminate ? " is-indeterminate" : ""}` });
    bar.style.width = `${Math.max(0, Math.min(100, this.viewModel.progress.percent))}%`;

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
    const durationRange = videoDurationRange(this.draft?.settings?.videoModel);
    this.renderPageTitle(parent, "分镜编辑", "勾选一个或多个镜头，确认最终视频提示词后按草案顺序生成。");
    const queueTools = parent.createDiv({ cls: "mangosteen-replica-shot-queue-tools" });
    const selectAllLabel = queueTools.createEl("label", { cls: "mangosteen-replica-shot-select-all" });
    const selectAll = selectAllLabel.createEl("input", { attr: { type: "checkbox", "aria-label": "选择全部分镜" } });
    const selectableShotIds = list(this.draft?.shots)
      .map((shot) => String(shot.id))
      .filter((id) => !this.shotLocked(id));
    selectAll.checked = selectableShotIds.length > 0 && selectableShotIds.every((id) => this.selectedShotIds.has(id));
    selectAll.disabled = !this.viewModel.canGenerate || this.confirmPending || !selectableShotIds.length;
    selectAllLabel.createEl("span", { text: "全选" });
    selectAll.addEventListener("change", () => {
      for (const id of selectableShotIds) {
        if (selectAll.checked) this.selectedShotIds.add(id);
        else this.selectedShotIds.delete(id);
      }
      this.render();
      this.renderSignature = this.buildRenderSignature();
    });
    const selectedCount = [...this.selectedShotIds].filter((id) => selectableShotIds.includes(id)).length;
    this.confirmButtons.push(this.createButton(
      queueTools,
      `生成所选（${selectedCount}）`,
      () => this.generateShots([...this.selectedShotIds]),
      "mod-cta",
      this.confirmPending || !this.viewModel.canGenerate || selectedCount === 0,
    ));
    if (this.viewModel.queueStatus) {
      queueTools.createEl("span", {
        cls: "mangosteen-replica-muted",
        text: `当前队列：${this.queueStatusLabel(this.viewModel.queueStatus)}${this.viewModel.current.step ? ` · ${this.viewModel.current.step}` : ""}`,
      });
    }
    const shotGrid = parent.createDiv({ cls: "mangosteen-replica-shot-list" });
    list(this.draft?.shots).forEach((shot, index) => {
      const projectShot = this.viewModel.shots[index] || {};
      const shotId = String(shot.id);
      const queueShot = list(this.viewModel.queueShots).find((item) => String(item.id) === shotId) || {};
      const shotLocked = this.shotLocked(shotId);
      const card = shotGrid.createDiv({ cls: `mangosteen-replica-shot-card${projectShot.status === "失败" ? " is-failed" : ""}` });
      const summaryRow = card.createDiv({ cls: "mangosteen-replica-shot-summary-row" });
      const identity = summaryRow.createDiv({ cls: "mangosteen-replica-shot-identity" });
      const checkbox = identity.createEl("input", { attr: { type: "checkbox", "aria-label": `选择镜头 ${shotId}` } });
      checkbox.dataset.shotId = shotId;
      checkbox.checked = this.selectedShotIds.has(shotId);
      checkbox.disabled = shotLocked || !this.viewModel.canGenerate || this.confirmPending;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedShotIds.add(shotId);
        else this.selectedShotIds.delete(shotId);
        this.render();
        this.renderSignature = this.buildRenderSignature();
      });
      identity.createEl("strong", { text: text(shot.id, String(index + 1).padStart(3, "0")) });
      identity.createEl("span", {
        cls: "mangosteen-replica-shot-status",
        text: queueShot.status ? this.queueStatusLabel(queueShot.status) : text(projectShot.status, "草案"),
      });
      this.createDraftControl(summaryRow, "标题", "input", shot.title, {
        section: "shot", index, field: "title",
      }, { className: "is-title", disabled: shotLocked });
      this.createDraftControl(summaryRow, "时长（秒）", "input", shot.duration, {
        section: "shot", index, field: "duration",
      }, {
        inputType: "number",
        min: String(durationRange.min),
        max: String(durationRange.max),
        step: String(durationRange.step),
        className: "is-duration",
        disabled: shotLocked,
      });
      this.createDraftControl(summaryRow, "场景", "select", shot.sceneId, {
        section: "shot", index, field: "sceneId",
      }, {
        options: list(this.draft?.scenes).map((scene) => [scene.id, scene.id]),
        className: "is-scene",
        disabled: shotLocked,
      });
      const cardActions = summaryRow.createDiv({ cls: "mangosteen-replica-shot-actions" });
      this.createButton(cardActions, "上移", () => this.reorderShot(index, "up"), "", this.editingLocked() || shotLocked || index === 0 || this.shotLocked(this.draft.shots[index - 1]?.id));
      this.createButton(cardActions, "下移", () => this.reorderShot(index, "down"), "", this.editingLocked() || shotLocked || index === this.draft.shots.length - 1 || this.shotLocked(this.draft.shots[index + 1]?.id));
      this.confirmButtons.push(this.createButton(
        cardActions,
        "生成此镜头",
        () => this.generateShots([shotId]),
        "",
        this.confirmPending || !this.viewModel.canGenerate || shotLocked,
      ));
      if (projectShot.videoPath) this.createButton(cardActions, "打开视频", () => this.plugin.openVaultPath(projectShot.videoPath));

      const details = this.createDetails(card, `shot-${shot.id || index}`, "展开镜头内容", projectShot.status === "失败");
      const timelineList = details.createDiv({ cls: "mangosteen-replica-timeline-list" });
      const lockedOptions = { disabled: shotLocked };
      const timeline = list(shot.timeline).length ? list(shot.timeline) : legacyTimeline(shot);
      timeline.forEach((segment, segmentIndex) => {
        const row = timelineList.createDiv({ cls: "mangosteen-replica-timeline-row" });
        const rowHeader = row.createDiv({ cls: "mangosteen-replica-timeline-header" });
        rowHeader.createEl("strong", { text: `时间段 ${segmentIndex + 1}` });
        const rowActions = rowHeader.createDiv({ cls: "mangosteen-replica-timeline-actions" });
        this.createButton(rowActions, "在后面添加", () => this.addTimelineRow(index, segmentIndex), "", shotLocked);
        this.createButton(rowActions, "删除此段", () => this.removeTimelineRow(index, segmentIndex), "", shotLocked || timeline.length <= 1);
        const timeGrid = row.createDiv({ cls: "mangosteen-replica-timeline-time" });
        this.createDraftControl(timeGrid, "开始（秒）", "input", segment.start, {
          section: "timeline", shotIndex: index, segmentIndex, field: "start",
        }, { inputType: "number", min: "0", max: String(shot.duration), step: "0.1", disabled: shotLocked });
        this.createDraftControl(timeGrid, "结束（秒）", "input", segment.end, {
          section: "timeline", shotIndex: index, segmentIndex, field: "end",
        }, { inputType: "number", min: "0", max: String(shot.duration), step: "0.1", disabled: shotLocked });
        const contentGrid = row.createDiv({ cls: "mangosteen-replica-timeline-fields" });
        this.createDraftControl(contentGrid, "画面动作", "textarea", segment.action, { section: "timeline", shotIndex: index, segmentIndex, field: "action" }, lockedOptions);
        this.createDraftControl(contentGrid, "人物台词", "textarea", segment.dialogue, { section: "timeline", shotIndex: index, segmentIndex, field: "dialogue" }, lockedOptions);
        this.createDraftControl(contentGrid, "情绪与声音", "textarea", segment.performance, { section: "timeline", shotIndex: index, segmentIndex, field: "performance" }, lockedOptions);
        this.createDraftControl(contentGrid, "景别与运镜", "textarea", segment.camera, { section: "timeline", shotIndex: index, segmentIndex, field: "camera" }, lockedOptions);
        this.createDraftControl(contentGrid, "环境", "textarea", segment.environment, { section: "timeline", shotIndex: index, segmentIndex, field: "environment" }, lockedOptions);
      });
      const previewLabel = details.createEl("label", { cls: "mangosteen-replica-field mangosteen-replica-prompt-preview" });
      previewLabel.createEl("span", { text: "最终视频提示词预览" });
      const preview = previewLabel.createEl("textarea", { attr: { readonly: "true", "aria-label": "最终视频提示词预览" } });
      try {
        preview.value = resolveVideoPrompt({
          timeline,
          duration: shot.duration,
          videoPrompt: shot.videoPrompt,
          videoPromptOverride: shot.videoPromptOverride,
          dialogue: shot.dialogue,
          voiceProfile: this.draft?.character?.voiceProfile,
          voiceDirection: shot.voiceDirection,
        });
      } catch (error) {
        preview.value = `时间轴待修正：${String(error?.message || error)}`;
      }
      this.promptPreviewElements.set(index, preview);

      if (projectShot.error) card.createDiv({ cls: "mangosteen-replica-error", text: projectShot.error });
    });
    if (!list(this.draft?.shots).length) parent.createDiv({ cls: "mangosteen-replica-empty-inline", text: "当前草案没有分镜。" });
    this.renderSaveRow(parent);
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
        if (this.activeTab === "settings") {
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
      try {
        this.draft = updateDraftField(this.draft, target, nextValue);
        this.dirty = true;
        this.feedback = "";
        this.syncSaveState();
        if (target.section === "timeline") this.refreshPromptPreview(target.shotIndex);
        else if (target.section === "shot" && target.field === "duration") this.refreshPromptPreview(target.index);
        else if (target.section === "character" && target.field === "voiceProfile") this.refreshAllPromptPreviews();
        this.renderSignature = this.buildRenderSignature();
        if (typeof options.onChange === "function") await options.onChange(nextValue, control);
      } catch (error) {
        this.setFeedback(String(error?.message || error));
      }
    });
    return control;
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
    for (const button of this.confirmButtons) button.disabled = disabled;
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
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }

  addTimelineRow(shotIndex, segmentIndex) {
    if (this.editingLocked() || this.shotLocked(this.draft?.shots?.[shotIndex]?.id)) return;
    this.draft = addTimelineSegment(this.draft, shotIndex, segmentIndex);
    this.dirty = true;
    this.render();
    this.renderSignature = this.buildRenderSignature();
  }

  removeTimelineRow(shotIndex, segmentIndex) {
    if (this.editingLocked() || this.shotLocked(this.draft?.shots?.[shotIndex]?.id)) return;
    this.draft = removeTimelineSegment(this.draft, shotIndex, segmentIndex);
    this.dirty = true;
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
