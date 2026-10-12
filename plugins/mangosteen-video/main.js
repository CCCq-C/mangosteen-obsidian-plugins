const { Plugin, Modal, Notice, requestUrl } = require("obsidian");
const path = require("path");
const fs = require("fs");

const API_BASE = "https://apimodel.aihubkit.com";
const MIGRATION_SAFE_FS_UNAVAILABLE_FALLBACK = "MIGRATION_SAFE_FS_UNAVAILABLE";
const DEFAULT_SETTINGS = {
  model: "",
  duration: 5,
  ratio: "16:9",
  resolution: "720p",
  resolutionsByModel: {},
  videoTasks: [],
  submissionMarkers: [],
};

const addField = (root, label, tag, options = {}) => {
  const row = root.createDiv({ cls: "mangosteen-video-field" });
  row.createEl("label", { text: label });
  return row.createEl(tag, options);
};

const splitUrls = (value) => String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
const supportsImageToVideo = (model) => String(model || "").trim().toLowerCase() === "minimax-h3";

class VideoStudioModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.balance = null;
    this.status = "正在连接山竹账号中心～";
    this.accessLoaded = false;
    this.catalogRevision = 0;
  }

  onOpen() {
    this.modalEl?.addClass?.("mangosteen-video-modal");
    (this.plugin.videoTaskViews ||= new Set()).add(this);
    const bridge = this.plugin.app?.plugins?.getPlugin?.("mangosteen-agent")?.getAccountBridge?.();
    this.unsubscribeCatalog = bridge?.subscribeCatalog?.((ready) => {
      this.catalogRevision += 1;
      this.accessLoaded = false;
      this.balance = null;
      this.status = "正在同步平台最新视频模型…";
      this.render();
      if (ready) void this.load();
    });
    this.render();
    void this.load();
  }

  onClose() { this.catalogRevision += 1; this.unsubscribeCatalog?.(); this.plugin.videoTaskViews?.delete(this); }

  async load() {
    const revision = ++this.catalogRevision;
    try {
      await this.plugin.refreshAgentAccess();
      if (revision !== this.catalogRevision) return;
      this.accessLoaded = true;
      this.balance = await this.plugin.getQuota().catch(() => null);
      await this.plugin.refreshVideoTasks();
      await this.plugin.refreshTaskUsageRecords();
      this.status = "可以直接描述想生成什么视频哟～";
    } catch (error) {
      if (revision !== this.catalogRevision) return;
      this.accessLoaded = false;
      this.status = this.plugin.api.toChineseVideoError(error);
    }
    if (revision !== this.catalogRevision) return;
    this.render();
  }

  modelLabel(model) {
    const candidate = this.plugin.getVideoKeyCandidates(model)[0];
    const ratio = Number(this.plugin.videoAccess?.groupRatios?.[candidate?.group]?.ratio);
    return `${model}${Number.isFinite(ratio) ? ` · ${candidate.group} ×${ratio}` : ""}`;
  }

  renderFrameUpload(root, slot, label) {
    const fileKey = `${slot}ImageFile`;
    const previewKey = `${slot}ImagePreview`;
    const item = root.createDiv({ cls: "mangosteen-video-frame-item" });
    const upload = item.createEl("label", { cls: "mangosteen-video-frame-upload", attr: { "aria-label": `选择本地${label}图片` } });
    const input = upload.createEl("input", { attr: { type: "file", accept: "image/png,image/jpeg,image/webp" } });
    if (this[previewKey]) {
      upload.createEl("img", { cls: "mangosteen-video-frame-preview", attr: { src: this[previewKey], alt: `${label}图片预览` } });
      upload.createEl("span", { cls: "mangosteen-video-frame-caption", text: "点击更换" });
    } else {
      const placeholder = upload.createDiv({ cls: "mangosteen-video-frame-placeholder" });
      placeholder.createEl("strong", { text: `选择${label}图片` });
      placeholder.createEl("span", { text: "PNG、JPG、WebP" });
    }
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        this.plugin.api.assertLocalImageUploadSize(file);
        this[fileKey] = file;
        const type = this.plugin.api.localImageMimeType(file);
        this[previewKey] = `data:${type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
        this.advancedOpen = true;
        this.render();
      } catch (error) { this.status = error?.message || String(error); this.render(); }
    });
    if (this[fileKey]) {
      const clear = item.createEl("button", { cls: "mangosteen-video-frame-clear", text: "移除", attr: { type: "button", "aria-label": `移除${label}图片` } });
      clear.addEventListener("click", () => { this[fileKey] = null; this[previewKey] = ""; this.render(); });
    }
  }

  renderTasks(root) {
    const list = root.createDiv({ cls: "mangosteen-video-task-list" });
    const tasks = this.plugin.settings.videoTasks || [];
    if (!tasks.length) {
      list.createEl("p", { text: "还没有视频任务，第一支小片子就从这里开始吧～" });
      return;
    }
    for (const task of tasks) {
      const card = list.createDiv({ cls: "mangosteen-video-task-card" });
      card.createEl("strong", { text: task.prompt || task.id });
      const terminal = task.status === "failed" || task.status === "completed";
      const progressValue = Number.isFinite(task.progress) ? task.progress : task.status === "completed" ? 100 : task.status === "failed" ? 0 : null;
      const progress = card.createDiv({ cls: `mangosteen-video-progress${progressValue === null && !terminal ? " is-indeterminate" : ""}` });
      const bar = progress.createEl("span");
      if (progressValue !== null) bar.setAttr?.("style", `--mangosteen-progress:${progressValue}%`);
      const status = task.lastError || this.plugin.api.videoProgressText(task.status);
      card.createEl("div", { text: `${status}${Number.isFinite(task.progress) ? ` ${task.progress}%` : ""}` });
      const cost = Number.isFinite(task.cost) ? `$${task.cost.toFixed(4)}` : terminal ? "正在同步任务详情" : "生成中";
      card.createEl("div", { cls: "mangosteen-video-task-meta", text: `${task.model} · ${task.createdAt || ""} · ${cost}` });
      if (task.usageLogDetail) {
        card.createEl("div", { cls: "mangosteen-video-task-log-detail", text: task.usageLogDetail });
        card.createEl("div", { cls: "mangosteen-video-task-log-meta", text: `请求ID：${task.usageRequestId || "未知"} · 令牌：${task.usageTokenName || "未知"} · 分组：${task.usageGroup || task.group || "未知"}` });
      }
      if (task.localPath) {
        const resource = this.plugin.app?.vault?.adapter?.getResourcePath?.(task.localPath);
        if (resource) {
          const video = card.createEl("video");
          video.setAttr?.("src", resource);
          video.setAttr?.("controls", "true");
        }
        const open = card.createEl("button", { text: "打开视频文件" });
        open.addEventListener("click", () => void this.plugin.app?.workspace?.openLinkText?.(task.localPath, "", true));
      }
    }
  }

  refreshTasks() {
    if (!this.taskSection) return;
    this.taskSection.empty();
    this.taskSection.createEl("h3", { text: "最近任务" });
    this.renderTasks(this.taskSection);
  }

  render() {
    const root = this.contentEl;
    root.empty();
    const shell = root.createDiv({ cls: "mangosteen-video-shell" });
    const hero = shell.createDiv({ cls: "mangosteen-video-hero" });
    const copy = hero.createDiv();
    copy.createEl("h2", { text: "山竹视频" });
    copy.createEl("p", { text: "把灵感交给山竹，慢慢长成一支小短片～" });
    hero.createEl("div", { cls: "mangosteen-video-balance", text: Number.isFinite(this.balance) ? `余额：约 $${this.balance.toFixed(2)}` : "余额：读取中" });

    const section = shell.createDiv({ cls: "mangosteen-video-section" });
    const heading = section.createDiv({ cls: "mangosteen-video-actions" });
    heading.createEl("h3", { text: "创作视频" });
    const history = heading.createEl("button", { text: "任务记录" });
    history.addEventListener("click", () => this.plugin.openHistory());

    const models = this.accessLoaded ? Object.keys(this.plugin.videoAccess?.videoModelKeys || {}) : [];
    const model = addField(section, "视频模型", "select");
    for (const id of models) {
      const option = model.createEl("option", { text: this.modelLabel(id) });
      option.value = id;
    }
    model.value = models.includes(this.plugin.settings.model) ? this.plugin.settings.model : models[0] || "";
    model.addEventListener("change", () => {
      this.plugin.settings.model = model.value;
      if (!supportsImageToVideo(model.value)) {
        this.firstImageFile = this.lastImageFile = null;
        this.firstImagePreview = this.lastImagePreview = "";
      }
      this.render();
    });

    const prompt = addField(section, "视频描述", "textarea");
    prompt.value = this.plugin.draftPrompt || "";
    prompt.addEventListener("input", () => { this.plugin.draftPrompt = prompt.value; });

    const capabilities = this.plugin.getVideoCapabilities(model.value);
    if (capabilities.maxPrompt) prompt.maxLength = capabilities.maxPrompt;
    const grid = section.createDiv({ cls: "mangosteen-video-grid" });
    const duration = addField(grid, `时长（${capabilities.minDuration}–${capabilities.maxDuration}秒）`, "input", { type: "number" });
    duration.min = String(capabilities.minDuration);
    duration.max = String(capabilities.maxDuration);
    if (this.plugin.settings.duration < capabilities.minDuration || this.plugin.settings.duration > capabilities.maxDuration) this.plugin.settings.duration = capabilities.minDuration;
    const draftDuration = Number(this.draftDuration ?? this.plugin.settings.duration);
    duration.value = String(draftDuration >= capabilities.minDuration && draftDuration <= capabilities.maxDuration ? draftDuration : capabilities.minDuration);
    duration.addEventListener("input", () => { this.draftDuration = duration.value; this.refreshPrice?.(); });
    grid.createEl("p", { cls: "mangosteen-video-help", text: this.plugin.api.videoDurationHint(capabilities) });
    const ratio = addField(grid, "画面比例", "select");
    for (const value of ["16:9", "9:16", "1:1"]) { const option = ratio.createEl("option", { text: value }); option.value = value; }
    ratio.value = this.draftRatio || this.plugin.settings.ratio;
    ratio.addEventListener("change", () => { this.draftRatio = ratio.value; });
    const resolution = addField(grid, "分辨率（平台拒绝后自动校准）", "select");
    const resolutionOptions = this.plugin.getResolutionOptions(model.value);
    if (!resolutionOptions.includes(this.plugin.settings.resolution)) this.plugin.settings.resolution = resolutionOptions[0];
    for (const value of resolutionOptions) { const option = resolution.createEl("option", { text: value }); option.value = value; }
    resolution.value = resolutionOptions.includes(this.draftResolution) ? this.draftResolution : this.plugin.settings.resolution;
    resolution.addEventListener("change", () => { this.draftResolution = resolution.value; this.refreshPrice?.(); });

    const advanced = section.createEl("details", { cls: "mangosteen-video-advanced" });
    advanced.open = Boolean(this.advancedOpen);
    advanced.addEventListener("toggle", () => { this.advancedOpen = advanced.open; });
    advanced.createEl("summary", { text: "高级参考材料" });
    const videos = capabilities.maxVideos ? addField(advanced, `参考视频 URL（每行一个，最多${capabilities.maxVideos}个）`, "textarea") : null;
    if (videos) { videos.value = this.draftReferenceVideos || ""; videos.addEventListener("input", () => { this.draftReferenceVideos = videos.value; this.refreshPrice?.(); }); }
    if (supportsImageToVideo(model.value)) {
      const frameGrid = advanced.createDiv({ cls: "mangosteen-video-frame-grid" });
      this.renderFrameUpload(frameGrid, "first", "首帧");
      this.renderFrameUpload(frameGrid, "last", "尾帧");
    }

    const price = section.createDiv({ cls: "mangosteen-video-price" });
    this.refreshPrice = () => {
      const selectedDuration = Number(duration.value) || 0;
      const quote = this.plugin.getVideoPrice(model.value, resolution.value, selectedDuration, splitUrls(videos?.value).length > 0);
      if (!quote) return price.setText("预计费用：首次使用该模型配置，完成后自动生成价格参考。");
      if (quote.unit === "output") return price.setText(`预计费用：约 $${quote.total.toFixed(4)}/条（参考上次实际结算）`);
      price.setText(`预计费用：约 $${quote.total.toFixed(4)}（参考上次实际结算 $${quote.amount.toFixed(4)}/秒 × ${selectedDuration}秒）`);
    };
    this.refreshPrice();

    const actions = section.createDiv({ cls: "mangosteen-video-actions" });
    const submit = actions.createEl("button", { cls: "mangosteen-video-primary", text: "生成视频" });
    submit.disabled = !models.length;
    const status = section.createEl("div", { cls: "mangosteen-video-status", text: this.status });
    submit.addEventListener("click", async () => {
      submit.disabled = true;
      let message = this.plugin.api.videoProgressText("in_progress");
      status.setText(message);
      const timer = window.setInterval(() => status.setText(message = this.plugin.api.videoProgressText("in_progress", message)), this.plugin.api.VIDEO_PROGRESS_INTERVAL_MS);
      try {
        this.plugin.settings.duration = Number(duration.value);
        this.plugin.settings.ratio = ratio.value;
        this.plugin.settings.resolution = resolution.value;
        await this.plugin.saveSettings();
        await this.plugin.submitVideo({
          model: model.value,
          prompt: prompt.value,
          duration: Number(duration.value),
          ratio: ratio.value,
          resolution: resolution.value,
          referenceImages: [],
          referenceVideos: splitUrls(videos?.value),
          referenceAudios: [],
          generateAudio: false,
          firstImageFile: this.firstImageFile || null,
          lastImageFile: this.lastImageFile || null,
        });
        this.plugin.draftPrompt = "";
        this.firstImageFile = null;
        this.lastImageFile = null;
        this.firstImagePreview = "";
        this.lastImagePreview = "";
        this.draftReferenceVideos = "";
        this.draftGenerateAudio = false;
        this.status = "任务已经收好啦，关闭窗口也会继续生成～";
        this.plugin.writeOperation("创建任务", model.value);
      } catch (error) {
        this.status = this.plugin.api.toChineseVideoError(error);
        this.plugin.writeOperation("创建失败", this.status);
      } finally {
        window.clearInterval(timer);
        submit.disabled = false;
        this.render();
      }
    });

    this.taskSection = shell.createDiv({ cls: "mangosteen-video-section" });
    this.refreshTasks();
  }
}

class VideoHistoryModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    this.modalEl?.addClass?.("mangosteen-video-modal");
    (this.plugin.videoTaskViews ||= new Set()).add(this);
    this.contentEl.empty();
    this.taskSection = this.contentEl.createDiv({ cls: "mangosteen-video-shell" });
    this.refreshTasks();
    void this.plugin.refreshVideoTasks(true).then(() => this.plugin.refreshTaskUsageRecords());
  }
  onClose() { this.plugin.videoTaskViews?.delete(this); }
  refreshTasks() {
    this.taskSection.empty();
    this.taskSection.createEl("h2", { text: "山竹视频任务记录" });
    new VideoStudioModal(this.plugin).renderTasks(this.taskSection);
  }
}

module.exports = class MangosteenVideoPlugin extends Plugin {
  async onload() {
    const adapter = this.app?.vault?.adapter;
    const vaultBasePath = adapter?.getBasePath?.() || adapter?.basePath;
    if (!vaultBasePath) throw new Error("无法定位山竹视频插件目录");
    const pluginRoot = path.join(vaultBasePath, ...String(this.manifest.dir || "").split(/[\\/]/).filter(Boolean));
    this.historyMigration = require(path.join(pluginRoot, "history-migration.cjs"));
    this.outputStorage = require(path.join(pluginRoot, "output-storage.cjs"));
    this.api = require(path.join(pluginRoot, "video-api.cjs"));
    this.migrationRuntime = require(path.join(path.dirname(pluginRoot), "migration-safe-fs.cjs"));
    this.createSafeMigrationFs = this.migrationRuntime.createSafeMigrationFs;
    this.migrationSafeFsUnavailable = this.migrationRuntime.MIGRATION_SAFE_FS_UNAVAILABLE;
    if (typeof this.createSafeMigrationFs !== "function") throw new Error("山竹视频迁移安全运行时无效");
    this._migrationSafeFs ||= this.createSafeMigrationFs({ vaultRoot: vaultBasePath });
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData?.());
    this.videoTaskViews = new Set();
    if (!this.settings.resolutionsByModel || typeof this.settings.resolutionsByModel !== "object") this.settings.resolutionsByModel = {};
    if (!Array.isArray(this.settings.submissionMarkers)) this.settings.submissionMarkers = [];
    this.addRibbonIcon?.("video", "打开山竹视频", () => this.openStudio());
    this.addCommand?.({ id: "organize-mangosteen-video-history", name: "整理山竹视频历史记录", callback: () => this.organizeVideoHistory() });
    if (typeof this.registerInterval === "function") {
      const poll = window.setInterval(() => {
        if ((this.settings.videoTasks || []).some((task) => !task.saved && task.status !== "failed")) void this.refreshVideoTasks();
        if ((this.settings.videoTasks || []).some((task) => ["completed", "failed"].includes(task.status) && !task.usageLogMatched)) void this.refreshTaskUsageRecords();
      }, 7000);
      const balance = window.setInterval(() => void this.updateBalance(), 30 * 60 * 1000);
      poll?.unref?.();
      balance?.unref?.();
      this.registerInterval(poll);
      this.registerInterval(balance);
    }
  }

  openStudio() { new VideoStudioModal(this).open(); }
  openHistory() { new VideoHistoryModal(this).open(); }

  async saveSettings() {
    if (typeof this.saveData === "function") await this.saveData(this.settings);
  }

  migrationSafeFs() {
    if (this._migrationSafeFs) return this._migrationSafeFs;
    const createSafeMigrationFs = this.createSafeMigrationFs || this.migrationRuntime?.createSafeMigrationFs;
    if (typeof createSafeMigrationFs !== "function") {
      const code = this.migrationSafeFsUnavailable || MIGRATION_SAFE_FS_UNAVAILABLE_FALLBACK;
      throw Object.assign(new Error(`${code}：共享迁移安全运行时尚未加载。`), { code });
    }
    this._migrationSafeFs = createSafeMigrationFs({
      vaultRoot: this.app?.vault?.adapter?.getBasePath?.() || this.app?.vault?.adapter?.basePath || "",
    });
    return this._migrationSafeFs;
  }

  videoHistoryMigrationFiles() {
    const output = [];
    const safe = this.migrationSafeFs();
    for (const root of ["山竹视频", "山竹创作记录/视频", ".mangosteen-video/migration-backup"]) {
      for (const item of safe.previewManifest(root) || []) output.push({ path: `${root}/${item.relativePath}`, size: item.size, sha256: item.sha256 });
    }
    return output;
  }

  latestVideoHistoryMigrationJournal() {
    const relativeRoot = ".mangosteen-video/migration-journal";
    const safe = this.migrationSafeFs();
    const name = (safe.previewManifest(relativeRoot) || []).map((item) => item.relativePath)
      .filter((item) => /^migration-\d{8}-\d{6}-\d{3}\.json$/.test(item)).sort().reverse()[0];
    if (!name) return null;
    const journal = safe.previewReadLastJournalRecord(`${relativeRoot}/${name}`);
    if (["completed", "rolled-back"].includes(String(journal?.state || ""))) return null;
    if (!journal?.planSnapshot || journal.planId !== journal.planSnapshot.planId
        || this.historyMigration.videoHistoryPlanId(journal.planSnapshot) !== journal.planId) throw new Error(`视频历史迁移 journal 与计划不一致：${name}`);
    return journal;
  }

  recoverableVideoHistoryMigrationPlan() {
    const journal = this.latestVideoHistoryMigrationJournal();
    if (!journal) return null;
    const plan = { ...journal.planSnapshot, journal };
    const reasons = [];
    for (const original of plan.originalTasks || []) {
      if (!(plan.operations || []).some((operation) => operation.from === original?.localPath)) continue;
      const expectedNext = (plan.nextTasks || []).find((task) => String(task?.id || "") === String(original?.id || ""));
      const current = (this.settings.videoTasks || []).find((task) => String(task?.id || "") === String(original?.id || ""));
      const status = String(current?.status || "").toLowerCase();
      if (!current || status !== "completed" || current.saved !== true || current.outputTarget
          || current.submissionUncertain === true || current.uncertain === true || this.submissionMarker(current.submissionFingerprint)) {
        reasons.push(`任务 ${String(original?.id || "未知")} 已不再满足安全整理条件。`);
        continue;
      }
      if (![String(original.localPath || ""), String(expectedNext?.localPath || "")].includes(String(current.localPath || ""))) {
        reasons.push(`任务 ${String(original?.id || "未知")} 的视频路径已变化。`);
      }
    }
    if (!reasons.length) return plan;
    return { ...plan, blocked: true, reasons, counts: { ...plan.counts, blocked: reasons.length } };
  }

  previewVideoHistoryMigration(now) {
    const recovery = this.recoverableVideoHistoryMigrationPlan();
    if (recovery) return recovery;
    return this.historyMigration.planVideoHistoryMigration({
      tasks: this.settings.videoTasks || [],
      submissionMarkers: this.settings.submissionMarkers || [],
      files: this.videoHistoryMigrationFiles(),
      now,
    });
  }

  confirmMigrationPlan(message) {
    return typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(message) : false;
  }

  migrationPlanText(plan, title) {
    const capability = this.migrationSafeFs().capability;
    const execution = capability.available ? `执行状态：可用（${capability.name}）` : `执行状态：不可用（${capability.code}）— ${capability.reason}`;
    return [title, `目标复制：${plan.counts.files} 个文件，${plan.counts.bytes} 字节`, `备份复制：${plan.counts.backupFiles} 个文件，${plan.counts.backupBytes} 字节`, `阻止项：${plan.counts.blocked}`, `跳过项：${plan.counts.skipped}`, `目标：${plan.destination}`, `备份：${plan.backupPath}`, "源目录处理：保留原位，不移动、不删除；完成后会记录 cleanupPending，后续清理必须另行确认。", execution].join("\n");
  }

  writeMigrationJournal(vaultPath, value) {
    const snapshot = value?.planSnapshot;
    if (!snapshot || value?.type !== "video-history-migration-journal" || value.planId !== snapshot.planId
        || this.historyMigration.videoHistoryPlanId(snapshot) !== value.planId
        || this.historyMigration.derivedVideoJournalPath(snapshot.plannedAt) !== vaultPath
        || snapshot.journalPath !== vaultPath) throw new Error("视频历史迁移 journal 路径或计划无效。");
    this.migrationSafeFs().appendJournalRecord(vaultPath, value, (existing) => existing?.type === value.type
      && existing?.planId === value.planId && existing?.journalPath === vaultPath
      && existing?.planSnapshot && this.historyMigration.videoHistoryPlanId(existing.planSnapshot) === existing.planId);
  }

  videoHistoryDirectoryManifest(vaultPath) {
    return this.migrationSafeFs().manifest(vaultPath);
  }

  async persistVideoMigrationTasks(tasks) {
    const desiredById = new Map(tasks.map((task) => [String(task?.id || ""), task]));
    const currentIds = new Set((this.settings.videoTasks || []).map((task) => String(task?.id || "")));
    for (const id of desiredById.keys()) if (!currentIds.has(id)) throw new Error(`视频任务记录已变化，缺少任务 ${id}。`);
    const merged = (this.settings.videoTasks || []).map((current) => {
      const desired = desiredById.get(String(current?.id || ""));
      if (!desired) return current;
      const next = { ...current, localPath: desired.localPath };
      for (const key of ["historyMigratedAt", "historyBackupPath"]) {
        if (Object.prototype.hasOwnProperty.call(desired, key)) next[key] = desired[key];
        else delete next[key];
      }
      return next;
    });
    const previous = this.settings.videoTasks;
    this.settings.videoTasks = merged;
    try { await this.saveSettings(); } catch (error) { this.settings.videoTasks = previous; throw error; }
    return merged;
  }

  async executeVideoHistoryMigration(plan) {
    const safe = this.migrationSafeFs();
    safe.assertExecutionAvailable();
    const result = await this.historyMigration.executeVideoHistoryMigration({
      plan,
      copy: async (from, to, expected) => safe.copyVerified(from, to, expected),
      backupCopy: async (from, to, expected) => safe.copyVerified(from, to, expected),
      hash: async (vaultPath) => safe.hashVerified(vaultPath),
      atomicWriteSettings: async (tasks) => this.persistVideoMigrationTasks(tasks, plan),
      writeJournal: async (vaultPath, value) => this.writeMigrationJournal(vaultPath, value),
      readManifest: async (vaultPath) => safe.manifest(vaultPath),
      readSettings: async () => JSON.parse(JSON.stringify(this.settings.videoTasks || [])),
      readSafetySnapshot: async () => this.historyMigration.videoHistorySafetySnapshot(this.settings.videoTasks || [], this.settings.submissionMarkers || []),
    });
    for (const view of this.videoTaskViews || []) { view.refreshTasks?.(); view.refreshPrice?.(); }
    return result;
  }

  async organizeVideoHistory() {
    try {
      const plan = await this.previewVideoHistoryMigration();
      if (plan.blocked) { new Notice(`视频历史整理已阻止：${plan.reasons.join("；")}`, 10000); return false; }
      if (!plan.operations.length) { new Notice(`没有可整理的视频历史；已跳过 ${plan.counts.skipped} 项。`, 6000); return false; }
      if (!this.confirmMigrationPlan(this.migrationPlanText(plan, "整理山竹视频历史记录"))) return false;
      const current = await this.previewVideoHistoryMigration(plan.plannedAt);
      if (current.blocked || this.historyMigration.videoHistoryPlanId(current) !== plan.planId) throw new Error(`确认后任务状态已变化：${current.reasons.join("；") || "整理清单不再一致"}`);
      if (!this.migrationSafeFs().capability.available) {
        new Notice(`${this.migrationSafeFsUnavailable || MIGRATION_SAFE_FS_UNAVAILABLE_FALLBACK}：${this.migrationSafeFs().capability.reason}`, 10000);
        return false;
      }
      await this.executeVideoHistoryMigration(current);
      new Notice(`视频历史整理完成；已复制备份到 ${plan.backupPath}，旧目录保留原位并标记待单独清理。`, 9000);
      return true;
    } catch (error) {
      new Notice(`视频历史整理失败：${String(error?.message || error)}`, 10000);
      return false;
    }
  }

  submissionMarker(fingerprint) {
    return (this.settings.submissionMarkers || []).find((item) => item.fingerprint === fingerprint);
  }

  blockedSubmissionError() {
    return new Error("检测到相同付费请求仍在处理中或待核对，已阻止重复提交。请先打开山竹视频任务记录刷新状态；确认平台未接收后再手动清理该状态。");
  }

  uncertaintyError() {
    return new Error("付费请求的提交结果待核对，系统不会自动重复提交。请先打开山竹视频任务记录核对平台状态。");
  }

  async prepareSubmissionMarker(fingerprint, requestShape) {
    if (this.submissionMarker(fingerprint)) throw this.blockedSubmissionError();
    const marker = {
      fingerprint,
      kind: "video",
      status: "prepared",
      requestShape,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.settings.submissionMarkers = [marker, ...(this.settings.submissionMarkers || [])];
    try {
      await this.saveSettings();
    } catch (error) {
      this.settings.submissionMarkers = (this.settings.submissionMarkers || []).filter((item) => item !== marker);
      throw new Error(`无法保存付费提交安全标记，已取消视频提交：${String(error?.message || error)}`);
    }
    return marker;
  }

  async markSubmissionUncertain(fingerprint, reasonCode = "REMOTE_RESULT_UNKNOWN") {
    const marker = this.submissionMarker(fingerprint);
    if (marker) Object.assign(marker, { status: "uncertain", reasonCode, updatedAt: new Date().toISOString() });
    try { await this.saveSettings(); } catch (_) { /* the durable prepared marker still blocks a retry */ }
    throw this.uncertaintyError();
  }

  async releaseRejectedSubmission(fingerprint) {
    const previous = (this.settings.submissionMarkers || []).map((item) => ({ ...item }));
    this.settings.submissionMarkers = (this.settings.submissionMarkers || []).filter((item) => item.fingerprint !== fingerprint);
    try {
      await this.saveSettings();
    } catch (_) {
      this.settings.submissionMarkers = previous.map((item) => item.fingerprint === fingerprint
        ? { ...item, status: "uncertain", reasonCode: "LOCAL_RELEASE_SAVE_FAILED", updatedAt: new Date().toISOString() }
        : item);
      try { await this.saveSettings(); } catch (_) { /* prior durable marker remains conservative */ }
      throw this.uncertaintyError();
    }
  }

  async videoSubmissionDescriptor(options, payload) {
    const fileValue = async (file) => {
      if (!file) return "";
      if (Buffer.isBuffer(file.buffer)) return file.buffer;
      return Buffer.from(await file.arrayBuffer());
    };
    return {
      kind: "video",
      model: payload.model,
      prompt: payload.prompt,
      duration: payload.duration,
      ratio: Object.prototype.hasOwnProperty.call(payload, "ratio") ? payload.ratio : "omitted",
      resolution: payload.resolution,
      generateAudio: Boolean(payload.generate_audio),
      firstImage: options.firstImageFile ? await fileValue(options.firstImageFile) : String(options.firstImage || ""),
      lastImage: options.lastImageFile ? await fileValue(options.lastImageFile) : String(options.lastImage || ""),
      referenceImages: [
        ...(Array.isArray(options.referenceImages) ? options.referenceImages : []),
        ...await Promise.all(Array.from(options.referenceImageFiles || []).map(fileValue)),
      ],
      referenceVideos: Array.isArray(options.referenceVideos) ? options.referenceVideos : [],
      referenceAudios: Array.isArray(options.referenceAudios) ? options.referenceAudios : [],
    };
  }

  async sendPaidVideoPayload(payload, descriptor) {
    const fingerprint = this.api.createSubmissionFingerprint(descriptor);
    await this.prepareSubmissionMarker(fingerprint, this.api.createVideoRequestShape(payload));
    let response;
    try {
      response = await this.sendVideoPayload(payload);
    } catch (_) {
      return this.markSubmissionUncertain(fingerprint, "REMOTE_RESPONSE_LOST");
    }
    if (response.status === 408 || response.status >= 500) return this.markSubmissionUncertain(fingerprint, "REMOTE_ACCEPTANCE_AMBIGUOUS");
    if (response.status >= 400) await this.releaseRejectedSubmission(fingerprint);
    return { response, fingerprint };
  }

  request(options, timeoutMs = 45000) { return this.api?.withTimeout ? this.api.withTimeout(requestUrl(options), timeoutMs, "视频服务请求") : requestUrl(options); }

  async refreshAgentAccess() {
    const agent = this.app?.plugins?.getPlugin?.("mangosteen-agent");
    const accountBridge = agent?.getAccountBridge?.();
    const bridge = agent?.getAihubkitVideoBridge?.() || accountBridge;
    const revision = accountBridge?.getCatalogRevision?.();
    const previousAccess = this.videoAccess;
    const access = await bridge?.resolveVideoAccess?.();
    if (revision !== undefined && revision !== accountBridge.getCatalogRevision()) {
      if (this.videoAccess === previousAccess) this.videoAccess = null;
      throw new Error("视频模型目录正在更新，请稍后重试。");
    }
    if (!access?.balanceKey || !Object.keys(access.videoModelKeys || {}).length) {
      this.videoAccess = null;
      throw new Error(agent?.getAccountBridge?.()?.getAccountUserId?.()
        ? "视频模型暂未同步，请在山竹账号中心点击重新获取；若仍为空，请确认已开通视频分组。"
        : "请先打开“山竹账号中心”完成登录，并确认账号已开通视频分组。");
    }
    this.videoAccess = access;
    const models = Object.keys(access.videoModelKeys);
    if (!models.includes(this.settings.model)) this.settings.model = models[0];
    return access;
  }

  getVideoKeyCandidates(model = this.settings.model) {
    const listed = this.videoAccess?.videoModelKeyCandidates?.[model] || [];
    if (listed.length) return listed.filter((item) => item?.key);
    const key = this.videoAccess?.videoModelKeys?.[model];
    return key ? [{ group: "", key }] : [];
  }

  getResolutionOptions(model = this.settings.model) {
    return this.api.resolutionOptionsForModel(model, this.settings.resolutionsByModel?.[model]);
  }

  getVideoCapabilities(model = this.settings.model) {
    return this.api.videoCapabilitiesForModel(model, this.settings.resolutionsByModel?.[model]);
  }

  getVideoPrice(model, resolution, duration, hasReferenceVideo) {
    const accountUserId = String(this.videoAccess?.accountUserId || "");
    if (!accountUserId) return null;
    const task = (this.settings.videoTasks || []).find((item) => {
      const owner = String(item.accountUserId || item.usageAccountUserId || "");
      const payload = item.payload || {};
      const usedReferenceVideo = Number(item.requestShape?.referenceVideoCount || 0) > 0
        || (Array.isArray(payload.referenceVideos) && payload.referenceVideos.length > 0);
      return item.status === "completed" && item.usageLogMatched && item.cost != null && item.cost !== "" && Number.isFinite(Number(item.cost))
        && owner === accountUserId
        && item.model === model && String(payload.resolution || "") === String(resolution || "")
        && usedReferenceVideo === Boolean(hasReferenceVideo) && Number(payload.duration) > 0;
    });
    if (!task) return null;
    const billingUnit = this.api.videoPriceForSelection(model, resolution, 1, hasReferenceVideo)?.unit === "output" ? "output" : "second";
    if (billingUnit === "output") {
      const amount = Number(Number(task.cost).toFixed(4));
      return { amount, unit: "output", total: amount };
    }
    const rawAmount = Number(task.cost) / Number(task.payload.duration);
    const amount = Number(rawAmount.toFixed(4));
    return { amount, unit: "second", total: Number((rawAmount * (Number(duration) || 0)).toFixed(4)) };
  }

  extractApiError(json, status) {
    return String(json?.error?.message || json?.message || json?.error || `请求失败（${status}）`);
  }

  remoteVideoError(json, status, model = this.settings.model) {
    const error = new Error(this.extractApiError(json, status));
    error.code = Number(status) === 404 ? "MODEL_UNAVAILABLE" : "REMOTE_REJECTED";
    error.status = Number(status) || 0;
    error.model = String(model || "");
    error.changeModel = error.status === 404 || /model|channel|模型|线路/i.test(error.message);
    return error;
  }

  async requestWithVideoKeyFallback(request, model = this.settings.model, preferredGroup = "") {
    await this.refreshAgentAccess();
    const candidates = this.getVideoKeyCandidates(model);
    if (preferredGroup) candidates.sort((a, b) => Number(b.group === preferredGroup) - Number(a.group === preferredGroup));
    if (!candidates.length) throw new Error("当前模型没有可用的视频 API Key");
    let response;
    for (const candidate of candidates) {
      response = await request(candidate.key);
      response.__mangosteenGroup = candidate.group;
      if (response.status < 400 || !this.api.shouldTryNextVideoKey(response)) return response;
    }
    return response;
  }

  async sendVideoPayload(payload) {
    return this.requestWithVideoKeyFallback((key) => this.request({
      url: `${API_BASE}/v1/videos`,
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      throw: false,
    }), payload.model);
  }

  async getRawQuota() {
    await this.refreshAgentAccess();
    const request = this.api.createBalanceRequest(this.videoAccess.balanceKey);
    const response = await this.request({ url: `${API_BASE}${request.path}`, method: "GET", headers: request.headers, throw: false });
    if (response.status >= 400) throw new Error(this.extractApiError(response.json, response.status));
    return Number(response.json?.data?.quota);
  }

  async getQuota() { return this.api.readQuota({ data: { quota: await this.getRawQuota() } }); }

  async updateBalance() {
    this.lastBalance = await this.getQuota().catch(() => null);
    return this.lastBalance;
  }

  async rememberVideoTask(task) {
    const payload = Object.assign({}, task.payload);
    delete payload.first_image;
    delete payload.last_image;
    delete payload.referenceImages;
    delete payload.referenceVideos;
    delete payload.referenceAudios;
    const outputTarget = this.outputStorage.normalizeVideoOutputTarget(task.outputTarget);
    const saved = Object.assign({
      accountUserId: String(this.videoAccess?.accountUserId || ""),
      createdAt: new Date().toISOString(),
      status: "queued",
      progress: null,
      saved: false,
      lastError: "",
    }, task, { payload, outputTarget });
    const previousTasks = this.settings.videoTasks || [];
    const previousMarkers = (this.settings.submissionMarkers || []).map((item) => ({ ...item }));
    const marker = task.submissionFingerprint ? this.submissionMarker(task.submissionFingerprint) : null;
    if (marker) Object.assign(marker, { status: "accepted", taskId: saved.id, updatedAt: new Date().toISOString() });
    this.settings.videoTasks = [saved, ...previousTasks.filter((item) => item.id !== saved.id)].slice(0, 50);
    try {
      await this.saveSettings();
    } catch (_) {
      this.settings.videoTasks = previousTasks;
      this.settings.submissionMarkers = previousMarkers.map((item) => item.fingerprint === task.submissionFingerprint
        ? { ...item, status: "uncertain", reasonCode: "TASK_PERSISTENCE_FAILED", updatedAt: new Date().toISOString() }
        : item);
      try { await this.saveSettings(); } catch (_) { /* durable prepared marker remains */ }
      throw this.uncertaintyError();
    }
    return saved;
  }

  async refreshTaskUsageRecords() {
    const agent = this.app?.plugins?.getPlugin?.("mangosteen-agent") || this.app?.plugins?.plugins?.["mangosteen-agent"];
    const bridge = agent?.getAccountBridge?.();
    const accountUserId = String(bridge?.getAccountUserId?.() || "");
    const tasks = (this.settings.videoTasks || []).filter((task) => ["completed", "failed"].includes(task.status) && (!task.usageLogMatched || !task.accountUserId) && (!task.accountUserId || String(task.accountUserId) === accountUserId));
    if (!tasks.length) return;
    const result = await bridge?.matchMediaUsage?.(tasks.map((task) => ({
      kind: "video",
      id: task.id,
      model: task.model,
      group: task.group,
      accountUserId: task.accountUserId,
      createdAt: task.createdAt,
      status: task.status,
      usageRequestId: task.usageRequestId,
      usageGroup: task.usageGroup,
    })));
    if (!result?.ok) return;
    let changed = false;
    for (const task of tasks) {
      const match = result.matches?.[task.id];
      if (!match) continue;
      Object.assign(task, {
        accountUserId: match.accountUserId || task.accountUserId || accountUserId,
        cost: Number(match.costUsd),
        usageLogMatched: true,
        usageLogDetail: match.detail || "平台已记录本次任务",
        usageRequestId: match.requestId || "",
        usageTokenName: match.tokenName || "",
        usageGroup: match.group || task.group || "",
        usageAccountUserId: match.accountUserId || accountUserId,
      });
      changed = true;
    }
    if (!changed) return;
    await this.saveSettings();
    for (const view of this.videoTaskViews || []) { view.refreshTasks?.(); view.refreshPrice?.(); }
  }

  async #uploadTemporaryImage(file, label) {
    this.api.assertLocalImageUploadSize(file);
    const bridge = this.app?.plugins?.getPlugin?.("mangosteen-agent")?.getAccountBridge?.();
    if (!bridge?.uploadTemporaryImage) throw new Error("请先登录山竹账号中心，再上传" + label + "图片。");
    let bytes;
    try { bytes = await file.arrayBuffer(); } catch (_) { throw new Error(label + "图片读取失败，请重新选择文件。"); }
    const uploaded = await bridge.uploadTemporaryImage({ name: file.name, type: this.api.localImageMimeType(file), bytes });
    if (!uploaded?.ok || !/^https:\/\/[^\s]+$/i.test(String(uploaded.url || "").trim())) {
      const code = String(uploaded?.code || "").trim();
      throw new Error(label + "图片上传失败，请检查网络、文件格式或重新登录后重试。" + (code ? `（${code}）` : ""));
    }
    return String(uploaded.url).trim();
  }

  async submitVideo(options) {
    if (!Array.isArray(this.settings.submissionMarkers)) this.settings.submissionMarkers = [];
    const outputTarget = this.outputStorage.normalizeVideoOutputTarget(options.outputTarget);
    const payloadOptions = { ...options };
    delete payloadOptions.outputTarget;
    const originalOptions = { ...payloadOptions };
    payloadOptions.allowedResolutions = this.settings.resolutionsByModel?.[payloadOptions.model];
    const referenceImageFiles = Array.from(payloadOptions.referenceImageFiles || []);
    const referenceImages = Array.isArray(payloadOptions.referenceImages) ? [...payloadOptions.referenceImages] : [];
    for (const [label, urlField, fileField] of [["首帧", "firstImage", "firstImageFile"], ["尾帧", "lastImage", "lastImageFile"]]) {
      if (String(payloadOptions[urlField] || "").trim() && payloadOptions[fileField]) throw new Error(label + "请只选图片 URL 或本地图片，不要同时填写。");
    }
    this.api.createVideoPayload(Object.assign({}, payloadOptions, {
      firstImage: payloadOptions.firstImage || (payloadOptions.firstImageFile ? "https://local.invalid/first-image" : ""),
      lastImage: payloadOptions.lastImage || (payloadOptions.lastImageFile ? "https://local.invalid/last-image" : ""),
      referenceImages: referenceImages.concat(referenceImageFiles.map((_, index) => `https://local.invalid/reference-${index + 1}`)),
    }));
    for (const [label, urlField, fileField] of [["首帧", "firstImage", "firstImageFile"], ["尾帧", "lastImage", "lastImageFile"]]) {
      const file = payloadOptions[fileField];
      if (!file) continue;
      payloadOptions[urlField] = await this.#uploadTemporaryImage(file, label);
    }
    for (const file of referenceImageFiles) referenceImages.push(await this.#uploadTemporaryImage(file, "参考"));
    payloadOptions.referenceImages = referenceImages;
    delete payloadOptions.referenceImageFiles;
    let payload = this.api.createVideoPayload(payloadOptions);
    const beforeQuota = await this.getRawQuota().catch(() => null);
    let descriptor = await this.videoSubmissionDescriptor(originalOptions, payload);
    let submitted = await this.sendPaidVideoPayload(payload, descriptor);
    let { response, fingerprint } = submitted;
    const allowed = this.api.readAllowedResolutions(response.json);
    if (response.status >= 400 && allowed.length && !allowed.includes(payload.resolution)) {
      this.settings.resolutionsByModel[payload.model] = allowed;
      this.settings.resolution = allowed[0];
      await this.saveSettings();
      payload = this.api.createVideoPayload(Object.assign({}, payloadOptions, { resolution: allowed[0], allowedResolutions: allowed }));
      descriptor = await this.videoSubmissionDescriptor(Object.assign({}, originalOptions, { resolution: allowed[0] }), payload);
      submitted = await this.sendPaidVideoPayload(payload, descriptor);
      ({ response, fingerprint } = submitted);
    }
    if (response.status >= 400) throw this.remoteVideoError(response.json, response.status, payload.model);
    const id = this.api.extractVideoTaskId(response.json);
    if (!id) return this.markSubmissionUncertain(fingerprint, "TASK_ID_MISSING");
    return this.rememberVideoTask({
      id,
      model: payload.model,
      prompt: payload.prompt,
      payload,
      requestShape: this.api.createVideoRequestShape(payload),
      submissionFingerprint: fingerprint,
      group: response.__mangosteenGroup,
      beforeQuota,
      outputTarget,
    });
  }

  async fetchVideoTask(task) {
    const response = await this.requestWithVideoKeyFallback((key) => this.request({
      url: `${API_BASE}/v1/videos/${encodeURIComponent(task.id)}`,
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      throw: false,
    }), task.model, task.group);
    if (response.status >= 400) throw new Error(this.extractApiError(response.json, response.status));
    return response.json;
  }

  async ensureVaultFolder(folder) {
    let current = "";
    for (const segment of String(folder || "").split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app?.vault?.getAbstractFileByPath?.(current)) await this.app.vault.createFolder(current);
    }
  }

  async saveCompletedVideo(task, response) {
    const state = this.api.readVideoTask(response);
    const contentUrl = `${API_BASE}/v1/videos/${encodeURIComponent(task.id)}/content`;
    const key = this.getVideoKeyCandidates(task.model).find((item) => item.group === task.group)?.key || this.getVideoKeyCandidates(task.model)[0]?.key;
    let download;
    if (state.url) {
      download = await this.request({ url: state.url, method: "GET", throw: false }, 120000);
    }
    if (!download || download.status >= 400 || !download.arrayBuffer) {
      if (!key) throw new Error("无法找到该任务的视频 API Key");
      download = await this.request({ url: contentUrl, method: "GET", headers: { Authorization: `Bearer ${key}` }, throw: false }, 120000);
    }
    if (download.status >= 400 || !download.arrayBuffer) throw new Error("视频已经生成，但保存失败，请稍后重新保存。");
    this.api.assertVideoDownloadSize(download);
    const outputTarget = this.outputStorage.normalizeVideoOutputTarget(task.outputTarget);
    const persistedLocalTarget = !outputTarget && task.localPath
      ? this.outputStorage.normalizeVideoOutputTarget({ destinationPath: task.localPath })
      : null;
    const filePath = outputTarget?.destinationPath
      || persistedLocalTarget?.destinationPath
      || this.outputStorage.standaloneVideoPath({ now: task.createdAt || new Date(), taskId: task.id });
    task.localPath = filePath;
    const folder = filePath.split("/").slice(0, -1).join("/");
    await this.ensureVaultFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath?.(filePath);
    if (existing && typeof this.app.vault.modifyBinary === "function") await this.app.vault.modifyBinary(existing, Buffer.from(download.arrayBuffer));
    else await this.app.vault.createBinary(filePath, Buffer.from(download.arrayBuffer));
    return filePath;
  }

  async refreshVideoTasks(recheckFailed = false) {
    if (this.videoTasksRefreshPromise) return this.videoTasksRefreshPromise;
    this.videoTasksRefreshPromise = this.refreshVideoTasksNow(recheckFailed);
    try { return await this.videoTasksRefreshPromise; } finally { this.videoTasksRefreshPromise = null; }
  }

  async refreshVideoTasksNow(recheckFailed = false) {
    for (const task of this.settings.videoTasks || []) {
      if (task.saved || (task.status === "failed" && !recheckFailed)) continue;
      try {
        const response = await this.fetchVideoTask(task);
        const state = this.api.readVideoTask(response);
        task.lastCheckedAt = new Date().toISOString();
        task.lastError = "";
        task.progress = state.progress;
        if (state.status === "failed") {
          task.status = "failed";
          task.lastError = this.api.toChineseVideoError(state.error || "平台视频任务失败");
          this.settings.submissionMarkers = (this.settings.submissionMarkers || []).filter((item) => item.fingerprint !== task.submissionFingerprint);
          continue;
        }
        if (state.status === "completed") {
          if (task.status === "failed") {
            task.usageLogMatched = false;
            task.usageLogDetail = "";
          }
          task.status = "saving";
          task.localPath = await this.saveCompletedVideo(task, response);
          task.afterQuota = await this.getRawQuota().catch(() => null);
          task.cost = this.api.calculateCost(task.beforeQuota, task.afterQuota);
          task.saved = true;
          task.status = "completed";
          this.settings.submissionMarkers = (this.settings.submissionMarkers || []).filter((item) => item.fingerprint !== task.submissionFingerprint);
          continue;
        }
        if (state.status === "unknown") {
          task.status = "unknown";
          task.lastError = "暂未取得有效任务状态，稍后自动重试。";
          continue;
        }
        task.status = state.status === "queued" ? "queued" : "in_progress";
      } catch (error) {
        const saving = task.status === "saving";
        task.status = "retrying";
        task.lastCheckedAt = new Date().toISOString();
        task.lastError = this.api.toChineseVideoError(error).replace(/^视频生成失败：/, saving ? "视频已生成，但保存失败：" : "视频状态查询失败：");
      }
    }
    await this.saveSettings();
    for (const view of this.videoTaskViews || []) { view.refreshTasks?.(); view.refreshPrice?.(); }
    void this.refreshTaskUsageRecords();
  }

  writeOperation(step, detail) {
    try {
      const base = this.app?.vault?.adapter?.basePath;
      if (!base) return;
      const folder = path.join(base, ".mangosteen-video", "logs");
      fs.mkdirSync(folder, { recursive: true });
      const log = path.join(folder, "operations.log");
      if (fs.existsSync(log) && fs.statSync(log).size >= 2 * 1024 * 1024) fs.renameSync(log, path.join(folder, "operations.old.log"));
      fs.appendFileSync(log, `[${new Date().toISOString()}] ${this.api.redactLogText(step)} | ${this.api.redactLogText(detail)}\n`, "utf8");
    } catch (_) { /* logging cannot block generation */ }
  }
};
