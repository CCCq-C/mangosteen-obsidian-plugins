const { normalizeGenerationRequest } = require("./replica-core.cjs");
const {
  isDraftLocked,
  moveShot,
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
    this.stopButtons = [];
    this.stopPending = false;
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
      };
      const folderChanged = previousFolder !== text(nextSnapshot.project.folder);
      if (folderChanged) this.dirty = false;
      if (!this.dirty || folderChanged || !this.draft) this.draft = clone(nextSnapshot.request);
      this.snapshot = nextSnapshot;
      this.viewModel = deriveWorkbenchState(nextSnapshot);
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
      state: stateSignature(this.viewModel),
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
    const projectGroup = toolbar.createDiv({ cls: "mangosteen-replica-toolbar-group" });
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
    this.createButton(actions, "刷新", () => this.refresh({ force: true }));
    this.createButton(actions, "分析模型", () => this.plugin.openAnalysisModelModal());
    this.createButton(actions, "生成模型", () => this.plugin.openGenerationModelModal());
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
    this.confirmButtons.push(this.createButton(
      actions,
      "确认并生成",
      () => this.confirmDraft(),
      "",
      this.confirmPending || this.editingLocked() || !this.viewModel.canConfirm,
    ));
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
    this.renderPageTitle(parent, "分镜编辑", "调整内容和顺序；保存前仅修改内存草案。");
    const shotGrid = parent.createDiv({ cls: "mangosteen-replica-shot-grid" });
    list(this.draft?.shots).forEach((shot, index) => {
      const projectShot = this.viewModel.shots[index] || {};
      const card = shotGrid.createDiv({ cls: `mangosteen-replica-shot-card${projectShot.status === "失败" ? " is-failed" : ""}` });
      const cardHeader = card.createDiv({ cls: "mangosteen-replica-card-heading" });
      cardHeader.createEl("strong", { text: `${text(shot.id, String(index + 1).padStart(3, "0"))} · ${text(shot.title, "未命名分镜")}` });
      cardHeader.createEl("span", { cls: "mangosteen-replica-shot-status", text: text(projectShot.status, "草案") });

      this.createDraftControl(card, "标题", "input", shot.title, { section: "shot", index, field: "title" });
      const formRow = card.createDiv({ cls: "mangosteen-replica-form-row" });
      this.createDraftControl(formRow, "时长（秒）", "input", shot.duration, {
        section: "shot", index, field: "duration",
      }, { inputType: "number", min: "2", max: "15" });
      this.createDraftControl(formRow, "场景", "select", shot.sceneId, {
        section: "shot", index, field: "sceneId",
      }, { options: list(this.draft?.scenes).map((scene) => [scene.id, scene.id]) });

      const details = this.createDetails(card, `shot-${shot.id || index}`, "镜头内容", true);
      this.createDraftControl(details, "剧情 / 动作", "textarea", shot.plot, { section: "shot", index, field: "plot" });
      this.createDraftControl(details, "台词", "textarea", shot.dialogue, { section: "shot", index, field: "dialogue" });
      this.createDraftControl(details, "情绪与语调（语速、重音、停顿）", "textarea", shot.voiceDirection, { section: "shot", index, field: "voiceDirection" });
      this.createDraftControl(details, "环境", "textarea", shot.environment, { section: "shot", index, field: "environment" });
      this.createDraftControl(details, "镜头语言", "textarea", shot.camera, { section: "shot", index, field: "camera" });
      this.createDraftControl(details, "首帧提示词", "textarea", shot.imagePrompt, { section: "shot", index, field: "imagePrompt" });
      this.createDraftControl(details, "尾帧提示词", "textarea", shot.lastImagePrompt, { section: "shot", index, field: "lastImagePrompt" });
      this.createDraftControl(details, "视频提示词", "textarea", shot.videoPrompt, { section: "shot", index, field: "videoPrompt" });

      const cardActions = card.createDiv({ cls: "mangosteen-replica-inline-actions" });
      this.createButton(cardActions, "上移", () => this.reorderShot(index, "up"), "", this.editingLocked() || index === 0);
      this.createButton(cardActions, "下移", () => this.reorderShot(index, "down"), "", this.editingLocked() || index === this.draft.shots.length - 1);
      if (projectShot.videoPath) this.createButton(cardActions, "打开视频", () => this.plugin.openVaultPath(projectShot.videoPath));
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
    const card = parent.createDiv({ cls: "mangosteen-replica-card mangosteen-replica-settings" });
    const settings = this.draft?.settings || {};
    this.createDraftControl(card, "图片模型", "input", settings.imageModel, { section: "settings", field: "imageModel" });
    this.createDraftControl(card, "视频模型", "input", settings.videoModel, { section: "settings", field: "videoModel" });
    const row = card.createDiv({ cls: "mangosteen-replica-form-row" });
    this.createDraftControl(row, "画面比例", "select", settings.ratio, { section: "settings", field: "ratio" }, {
      options: [["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"]],
    });
    this.createDraftControl(row, "清晰度", "select", settings.resolution, { section: "settings", field: "resolution" }, {
      options: [["720p", "720p"], ["768p", "768p"], ["1080p", "1080p"]],
    });
    const modelActions = card.createDiv({ cls: "mangosteen-replica-inline-actions" });
    this.createButton(modelActions, "选择分析模型", () => this.plugin.openAnalysisModelModal());
    this.createButton(modelActions, "选择生成模型", () => this.plugin.openGenerationModelModal());
    this.renderSaveRow(parent);
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
    label.createEl("span", { text: labelText });
    const control = label.createEl(tagName, { attr: { "aria-label": labelText } });
    control.dataset.section = target.section;
    control.dataset.field = target.field;
    if (target.index !== undefined) control.dataset.index = String(target.index);
    if (tagName === "select") {
      for (const [optionValue, optionLabel] of options.options || []) {
        control.createEl("option", { text: optionLabel, attr: { value: optionValue } });
      }
    }
    if (options.inputType) control.setAttr("type", options.inputType);
    if (options.min) control.setAttr("min", options.min);
    if (options.max) control.setAttr("max", options.max);
    control.value = value === undefined || value === null ? "" : String(value);
    control.disabled = this.editingLocked();
    control.addEventListener(tagName === "select" ? "change" : "input", () => {
      const nextValue = target.field === "duration" ? Number(control.value) : control.value;
      try {
        this.draft = updateDraftField(this.draft, target, nextValue);
        this.dirty = true;
        this.feedback = "";
        this.syncSaveState();
        this.renderSignature = this.buildRenderSignature();
      } catch (error) {
        this.setFeedback(String(error?.message || error));
      }
    });
    return control;
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
    const disabled = this.confirmPending || this.editingLocked() || !this.viewModel.canConfirm;
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

  reorderShot(index, direction) {
    if (this.editingLocked()) return;
    this.draft = moveShot(this.draft, index, direction);
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

  async confirmDraft() {
    if (this.confirmPending || this.editingLocked() || !this.viewModel.canConfirm || !this.selectedFolder) return false;
    this.confirmPending = true;
    this.syncConfirmState();
    try {
      if (this.dirty && !(await this.saveDraft())) return false;
      if (this.editingLocked() || !this.viewModel.canConfirm || !this.selectedFolder) return false;
      await this.plugin.confirmWorkbenchDraft(this.selectedFolder);
      this.feedback = "已确认草案，生成任务已启动。";
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
