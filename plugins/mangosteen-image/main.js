const { Plugin, Modal, Notice, requestUrl } = require("obsidian");
const path = require("path");

const API_BASE = "https://apimodel.aihubkit.com";
const HISTORY_ROOT = "生图记录";
const IMAGE_TASK_WAIT_ATTEMPTS = 450;
const DEFAULT_SETTINGS = { imageTasks: [], submissionMarkers: [], model: "gpt-image-2", size: "1024x1024", count: 1, editCount: 1 };
const preferredImageModel = (models, current) => models.includes(current)
  ? current
  : models.find((id) => id.toLowerCase() === "gpt-image-2")
    || models.find((id) => id.toLowerCase().startsWith("gpt-image-2"))
    || models[0]
    || "";

class ImageModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = "text";
    this.selectedImage = null;
    this.resultCandidates = [];
    this.lastCost = null;
    this.accessLoaded = false;
    this.catalogRevision = 0;
  }

  onOpen() {
    (this.plugin.imageTaskViews ||= new Set()).add(this);
    const bridge = this.plugin.app?.plugins?.getPlugin?.("mangosteen-agent")?.getAccountBridge?.();
    this.unsubscribeCatalog = bridge?.subscribeCatalog?.((ready) => {
      this.catalogRevision += 1;
      this.accessLoaded = false;
      this.render();
      if (ready) this.refreshAccess();
    });
    this.render();
    this.refreshAccess();
    void this.plugin.refreshImageTasks().then(() => this.plugin.refreshTaskUsageRecords());
  }
  onClose() {
    this.catalogRevision += 1;
    this.unsubscribeCatalog?.();
    this.plugin.imageTaskViews?.delete(this);
    this.stopProgress();
    this.contentEl.empty();
  }

  refreshAccess() {
    const revision = ++this.catalogRevision;
    void this.plugin.refreshAgentAccess().then(() => {
      if (revision !== this.catalogRevision) return;
      this.accessLoaded = true;
      this.render();
    }).catch(() => {
      if (revision !== this.catalogRevision) return;
      this.accessLoaded = false;
      this.render();
    });
  }

  render() {
    this.contentEl.empty();
    this.modalEl.addClass("mangosteen-image-modal");
    const hero = this.contentEl.createDiv({ cls: "mangosteen-image-hero" });
    const avatar = hero.createDiv({ cls: "mangosteen-image-brand-avatar", attr: { role: "img", "aria-label": "山竹智能体" } });
    this.plugin.applyAvatar(avatar);
    const intro = hero.createDiv({ cls: "mangosteen-image-hero-intro" });
    intro.createEl("span", { cls: "mangosteen-image-eyebrow", text: "MANGOSTEEN STUDIO" });
    intro.createEl("h2", { text: "山竹出图" });
    intro.createEl("p", { text: "可以直接描述想生成什么图片哟～" });
    const actions = hero.createDiv({ cls: "mangosteen-image-hero-actions" });
    const history = actions.createEl("button", { text: "生图记录" });
    history.type = "button";
    history.addEventListener("click", () => void this.plugin.openHistory());
    this.balanceEl = actions.createEl("p", { cls: "mangosteen-image-balance", text: "余额：正在读取…" });
    const workflow = this.contentEl.createDiv({ cls: "mangosteen-image-workflow" });
    this.renderForm(workflow);
    if (this.resultCandidates.length) this.renderResults(workflow);
    this.taskSection = workflow.createDiv({ cls: "mangosteen-image-section" });
    this.refreshTasks();
    void this.updateBalance();
  }

  renderTasks(root) {
    const list = root.createDiv({ cls: "mangosteen-image-task-list" });
    const tasks = this.plugin.settings.imageTasks || [];
    if (!tasks.length) {
      list.createEl("p", { cls: "mangosteen-image-help", text: "还没有生图任务，第一张作品就从这里开始吧～" });
      return;
    }
    for (const task of tasks) {
      const card = list.createDiv({ cls: `mangosteen-image-task-card is-${task.status || "processing"}` });
      card.createEl("strong", { text: task.prompt || task.id || "未记录提示词" });
      const terminal = task.status === "failed" || task.status === "completed";
      const progressValue = Number.isFinite(task.progress) ? task.progress : task.status === "completed" ? 100 : task.status === "failed" ? 0 : null;
      const progress = card.createDiv({ cls: `mangosteen-image-task-progress${progressValue === null && !terminal ? " is-indeterminate" : ""}` });
      const bar = progress.createEl("span");
      if (progressValue !== null) bar.setAttr?.("style", `--mangosteen-progress:${progressValue}%`);
      const status = task.lastError || { queued: "任务已排队，正在等画面开工～", processing: "画面正在生成中～", retrying: "查询中断，正在重新连接～", failed: "生成失败", completed: "图片已经做好啦～" }[task.status] || "正在读取任务状态～";
      const shownProgress = Number.isFinite(task.progress) || task.status === "completed" ? ` ${progressValue}%` : "";
      card.createEl("div", { text: `${status}${shownProgress}` });
      const cost = Number.isFinite(task.cost) ? `$${task.cost.toFixed(4)}` : terminal ? "正在同步任务详情" : "生成中";
      card.createEl("div", { cls: "mangosteen-image-task-meta", text: `${task.model || "图片模型"} · ${task.createdAt || ""} · ${cost}` });
      if (task.usageLogDetail) {
        card.createEl("div", { cls: "mangosteen-image-task-log-detail", text: task.usageLogDetail });
        card.createEl("div", { cls: "mangosteen-image-task-log-meta", text: `请求ID：${task.usageRequestId || "未知"} · 令牌：${task.usageTokenName || "未知"} · 分组：${task.usageGroup || task.group || "未知"}` });
      }
      if (task.imagePaths?.length) {
        const gallery = card.createDiv({ cls: "mangosteen-image-task-previews" });
        for (const imagePath of task.imagePaths) {
          const resource = this.plugin.app?.vault?.adapter?.getResourcePath?.(imagePath);
          if (!resource) continue;
          const item = gallery.createDiv({ cls: "mangosteen-image-task-preview" });
          const image = item.createEl("img", { attr: { alt: task.prompt || "生成图片" } });
          image.src = resource;
          const actions = item.createDiv({ cls: "mangosteen-image-actions" });
          const open = actions.createEl("button", { text: "打开原图" });
          open.addEventListener("click", () => void this.plugin.app?.workspace?.openLinkText?.(imagePath, "", true));
          const edit = actions.createEl("button", { text: "用于图生图" });
          edit.addEventListener("click", async () => {
            try { await this.plugin.openSavedImage(imagePath); }
            catch (error) { this.showError(error); }
          });
        }
      }
    }
  }

  refreshTasks() {
    if (!this.taskSection) return;
    this.taskSection.empty();
    this.taskSection.createEl("h3", { text: "最近任务" });
    this.renderTasks(this.taskSection);
  }

  renderForm(root) {
    const modeSection = root.createDiv({ cls: "mangosteen-image-section" });
    modeSection.createEl("p", { cls: "mangosteen-image-section-title", text: "01 · 选择创作方式" });
    const modeActions = modeSection.createDiv({ cls: "mangosteen-image-actions mangosteen-image-mode-actions" });
    for (const [mode, label] of [["text", "文生图"], ["edit", "图生图"]]) {
      const button = modeActions.createEl("button", { text: label, cls: this.mode === mode ? "mod-cta" : "" });
      button.type = "button";
      button.addEventListener("click", () => { this.mode = mode; this.render(); });
    }
    const models = this.accessLoaded ? Object.keys(this.plugin.agentImageAccess?.imageModelKeys || {}) : [];
    const modelField = modeSection.createDiv({ cls: "mangosteen-image-model-field" });
    modelField.createEl("label", { text: "图片模型" });
    const model = modelField.createEl("select");
    for (const id of models) {
      const option = model.createEl("option", { text: id });
      option.value = id;
      option.modelId = id;
    }
    model.value = preferredImageModel(models, this.plugin.settings.model);
    model.disabled = !models.length;
    model.addEventListener("change", async () => {
      this.plugin.settings.model = model.value;
      await this.plugin.saveSettings();
      this.refreshPrice?.();
    });
    const countField = modeSection.createDiv({ cls: "mangosteen-image-model-field" });
    countField.createEl("label", { text: "生成数量" });
    const count = countField.createEl("select");
    for (let value = 1; value <= 7; value += 1) {
      const option = count.createEl("option", { text: `${value}张` });
      option.value = String(value);
    }
    const countSetting = this.mode === "text" ? "count" : "editCount";
    count.value = String(Math.max(1, Math.min(7, Number(this.plugin.settings[countSetting]) || 1)));
    count.addEventListener("change", async () => {
      this.plugin.settings[countSetting] = Number(count.value);
      await this.plugin.saveSettings();
      this.refreshPrice?.();
    });
    if (this.mode === "edit") countField.createEl("p", { cls: "mangosteen-image-help", text: "图生图会拆成独立任务，最多同时处理 2 张；个别失败不会影响其他结果。" });
    const price = modeSection.createDiv({ cls: "mangosteen-image-price" });
    this.refreshPrice = () => {
      const selectedCount = Number(count.value) || 1;
      const quote = this.plugin.getImagePrice(model.value, this.mode === "text" ? "文生图" : "图生图", this.plugin.settings.size, selectedCount);
      for (const option of Array.from(model.children || [])) {
        const optionId = option.modelId || option.value;
        const optionQuote = this.plugin.getImagePrice(optionId, this.mode === "text" ? "文生图" : "图生图", this.plugin.settings.size, 1);
        option.setText?.(optionQuote ? `${optionId}（参考 $${optionQuote.amount.toFixed(4)}/张）` : `${optionId}（首次使用后显示费用）`);
      }
      if (!quote) return price.setText("预计费用：首次使用该模型配置，完成后自动生成价格参考。");
      price.setText(`预计费用：约 $${quote.total.toFixed(4)}（参考上次实际结算 $${quote.amount.toFixed(4)}/张 × ${selectedCount}张）`);
    };
    this.refreshPrice();
    const promptSection = root.createDiv({ cls: "mangosteen-image-section" });
    promptSection.createEl("p", { cls: "mangosteen-image-section-title", text: this.mode === "text" ? "02 · 描述画面" : "02 · 上传参考图并描述修改方向" });
    const editor = this.mode === "edit" ? promptSection.createDiv({ cls: "mangosteen-image-edit-grid" }) : promptSection;
    this.promptEl = editor.createEl("textarea", { cls: "mangosteen-image-prompt", attr: { placeholder: this.mode === "text" ? "描述你想生成的画面，例如：雨后山竹园的电影感航拍" : "描述你想如何修改这张图" } });
    this.promptEl.value = this.draftPrompt || "";
    this.promptEl.addEventListener("input", () => { this.draftPrompt = this.promptEl.value; });
    if (this.mode === "edit") {
      const imageLabel = editor.createEl("label", { cls: "mangosteen-image-upload", attr: { "aria-label": "导入参考图片" } });
      const imageInput = imageLabel.createEl("input", { attr: { type: "file", accept: "image/png,image/jpeg,image/webp" } });
      if (this.selectedImage?.previewUrl) {
        imageLabel.createEl("img", { cls: "mangosteen-image-upload-preview", attr: { src: this.selectedImage.previewUrl, alt: `参考图片：${this.selectedImage.name}` } });
        imageLabel.createEl("span", { cls: "mangosteen-image-upload-caption", text: "点击更换参考图片" });
      } else {
        const placeholder = imageLabel.createDiv({ cls: "mangosteen-image-upload-placeholder" });
        placeholder.createEl("strong", { text: "导入参考图片" });
        placeholder.createEl("span", { text: "支持 PNG、JPG、WebP" });
      }
      imageInput.addEventListener("change", async () => {
        const [file] = Array.from(imageInput.files || []);
        if (!file) return;
        try {
          this.plugin.api.assertLocalImageUploadSize(file);
          const type = this.plugin.api.localImageMimeType(file);
          const buffer = Buffer.from(await file.arrayBuffer());
          this.selectedImage = { name: file.name, type, buffer, previewUrl: this.plugin.api.createLocalImagePreview(type, buffer) };
          this.render();
        } catch (error) { this.showError(error); }
      });
    }
    const actionSection = root.createDiv({ cls: "mangosteen-image-section mangosteen-image-submit-section" });
    this.progressEl = actionSection.createEl("p", { cls: "mangosteen-image-progress", text: "准备好就可以开始创作啦～" });
    const actions = actionSection.createDiv({ cls: "mangosteen-image-actions" });
    const generate = actions.createEl("button", { cls: "mod-cta", text: "山竹出图" });
    generate.type = "button";
    generate.disabled = !models.length;
    generate.addEventListener("click", async () => {
      generate.disabled = true;
      generate.setText("正在生成…");
      this.startProgress();
      try { this.setProgress(await this.generate()); }
      catch (error) { this.showError(error); }
      finally { this.stopProgress(); generate.disabled = false; generate.setText("山竹出图"); }
    });
  }

  setProgress(message) { if (this.progressEl) this.progressEl.setText(message); }
  startProgress() {
    this.stopProgress();
    let message = this.plugin.api.generationProgressText();
    this.setProgress(message);
    this.progressTimer = window.setInterval(() => this.setProgress(message = this.plugin.api.generationProgressText(message)), this.plugin.api.IMAGE_PROGRESS_INTERVAL_MS);
  }
  stopProgress() {
    if (this.progressTimer) window.clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  async updateBalance() {
    try {
      const quota = await this.plugin.getQuota();
      if (!this.balanceEl) return;
      this.balanceEl.setText(quota === null ? "余额：请先在山竹账号中心登录。" : `余额：约 $${quota.toFixed(2)}${this.lastCost === null ? "" : ` ｜本次扣费：约 $${this.lastCost.toFixed(2)}`}`);
    } catch (_) {
      if (this.balanceEl) this.balanceEl.setText("余额：请检查山竹账号中心的登录状态。");
    }
  }

  async generate() {
    const before = await this.plugin.getRawQuota().catch(() => null);
    const prompt = this.promptEl.value.trim();
    let batch;
    if (this.mode === "text") {
      batch = await this.plugin.generateTextBatch(prompt, this.plugin.settings.count);
    } else {
      if (!this.selectedImage) throw new Error("请先选择一张参考图片");
      batch = await this.plugin.generateEditBatch(prompt, this.selectedImage, this.plugin.settings.editCount);
    }
    if (!batch.successes.length) throw new Error(`图片生成全部失败：${batch.failures[0]?.error?.message || "平台暂时无响应"}`);
    const successfulResponses = batch.successes.map((item) => item.response);
    this.resultCandidates = successfulResponses.flatMap((item) => this.plugin.extractResults(item));
    if (!this.resultCandidates.length) throw new Error("平台已返回成功，但没有可展示的图片。请把桌面上的安装故障日志发给售后老师。");
    const after = await this.plugin.getRawQuota().catch(() => null);
    this.lastCost = this.plugin.calculateCost(before, after);
    this.setProgress("图片做好啦，正在保存到生图记录～");
    const costPerRequest = this.lastCost === null ? null : this.lastCost / successfulResponses.length;
    await Promise.all(successfulResponses.map((item) => this.plugin.saveImageResult({
      taskId: item?.__mangosteenTaskId,
      submissionFingerprint: item?.__mangosteenSubmissionFingerprint,
      candidates: this.plugin.extractResults(item),
      prompt,
      mode: this.mode === "text" ? "文生图" : "图生图",
      cost: costPerRequest,
      requestedCount: Number(item?.__mangosteenRequestedCount || 1),
    }))).catch(() => new Notice("图片已生成，但部分本地记录保存失败。"));
    this.draftPrompt = "";
    this.render();
    return this.plugin.api.imageBatchResultText(this.resultCandidates.length, batch?.failures.length || 0);
  }

  renderResults(root) {
    const resultSection = root.createDiv({ cls: "mangosteen-image-section mangosteen-image-result-section" });
    resultSection.createEl("h3", { text: "生成结果" });
    const results = resultSection.createDiv({ cls: "mangosteen-image-results" });
    this.resultCandidates.forEach((candidate, index) => {
      const item = results.createDiv({ cls: "mangosteen-image-result" });
      const image = item.createEl("img", { attr: { alt: `生成图片 ${index + 1}` } });
      image.src = this.plugin.toPreviewUrl(candidate);
      const download = item.createEl("button", { text: "下载图片" });
      download.type = "button";
      download.addEventListener("click", () => this.plugin.download(candidate, index + 1));
      const edit = item.createEl("button", { text: "用此图继续修改" });
      edit.type = "button";
      edit.addEventListener("click", async () => {
        try {
          this.selectedImage = await this.plugin.toSelectedImage(candidate, index + 1);
          this.selectedImage.previewUrl = this.plugin.toPreviewUrl(candidate);
          this.mode = "edit";
          this.render();
        } catch (error) { this.showError(error); }
      });
    });
  }

  showError(error) {
    this.contentEl.querySelector(".mangosteen-image-error")?.remove();
    const message = this.plugin.toChineseError(error);
    this.contentEl.createEl("p", { cls: "mangosteen-image-error", text: message });
  }
}

class ImageHistoryModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.refreshing = false;
    this.closed = false;
    this.pollTimer = null;
  }
  onOpen() {
    this.closed = false;
    this.modalEl.addClass("mangosteen-image-history-modal");
    (this.plugin.imageTaskViews ||= new Set()).add(this);
    void this.refresh(true);
  }
  onClose() {
    this.plugin.imageTaskViews?.delete(this);
    this.closed = true;
    this.stopPolling();
    this.contentEl.empty();
  }
  startPolling() {
    if (!this.pollTimer) this.pollTimer = window.setInterval(() => void this.refresh(), 5000);
  }
  stopPolling() {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
  async refresh(recheckFailed = false) {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      await this.plugin.refreshImageTasks(recheckFailed);
      if (!this.closed) await this.render();
    } finally {
      this.refreshing = false;
    }
  }
  async render() {
    const scrollTop = this.contentEl.scrollTop;
    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "mangosteen-image-history-header" });
    header.createEl("h2", { text: "生图记录" });
    const refresh = header.createEl("button", { text: "立即刷新" });
    refresh.type = "button";
    refresh.addEventListener("click", () => void this.refresh(true));

    const tasks = this.plugin.settings.imageTasks || [];
    new ImageModal(this.plugin).renderTasks(this.contentEl);

    if (tasks.some((task) => !task.saved && task.status !== "failed")) this.startPolling();
    else this.stopPolling();
    this.contentEl.scrollTop = scrollTop;
  }
}

module.exports = class MangosteenImagePlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    const hadStandaloneAccess = ["apiKey", "imageKeys", "imageModelKeys", "imageKeyOwnerUserId", "account"].some((key) => Object.prototype.hasOwnProperty.call(saved || {}, key));
    this.settings = {
      model: String(saved?.model || DEFAULT_SETTINGS.model),
      size: String(saved?.size || DEFAULT_SETTINGS.size),
      count: Number(saved?.count || DEFAULT_SETTINGS.count),
      editCount: Number(saved?.editCount || DEFAULT_SETTINGS.editCount),
      imageTasks: Array.isArray(saved?.imageTasks) ? saved.imageTasks : [],
      submissionMarkers: Array.isArray(saved?.submissionMarkers) ? saved.submissionMarkers : [],
    };
    if (hadStandaloneAccess) await this.saveSettings();
    const adapter = this.app?.vault?.adapter;
    const vaultBasePath = adapter?.getBasePath?.() || adapter?.basePath;
    if (!vaultBasePath) throw new Error("无法定位山竹生图插件目录");
    const apiPath = path.join(vaultBasePath, ...String(this.manifest.dir || "").split(/[\\/]/), "image-api.cjs");
    this.api = require(apiPath);
    this.imageTaskViews = new Set();
    this.addRibbonIcon("image-plus", "山竹出图", () => void this.openModal());
    this.addCommand({ id: "open-image-generator", name: "山竹出图", callback: () => void this.openModal() });
    if (typeof this.registerInterval === "function" && typeof window !== "undefined") {
      this.registerInterval(window.setInterval(() => {
        if ((this.settings.imageTasks || []).some((task) => !task.saved && task.status !== "failed")) void this.refreshImageTasks();
        if ((this.settings.imageTasks || []).some((task) => ["completed", "failed"].includes(task.status) && !task.usageLogMatched)) void this.refreshTaskUsageRecords();
      }, 7000));
    }
  }

  async saveSettings() { await this.saveData(this.settings); }
  submissionMarker(fingerprint) {
    return (this.settings.submissionMarkers || []).find((item) => item.fingerprint === fingerprint);
  }
  blockedSubmissionError() {
    return new Error("检测到相同付费请求仍在处理中或待核对，已阻止重复提交。请先打开生图记录刷新状态；确认平台未接收后再手动清理该状态。");
  }
  uncertaintyError() {
    return new Error("付费请求的提交结果待核对，系统不会自动重复提交。请先打开生图记录核对平台状态。");
  }
  async prepareSubmissionMarker(fingerprint, requestShape) {
    if (this.submissionMarker(fingerprint)) throw this.blockedSubmissionError();
    const marker = {
      fingerprint,
      kind: "image",
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
      throw new Error(`无法保存付费提交安全标记，已取消生图提交：${String(error?.message || error)}`);
    }
    return marker;
  }
  async markSubmissionUncertain(fingerprint, reasonCode = "REMOTE_RESULT_UNKNOWN") {
    const marker = this.submissionMarker(fingerprint);
    if (marker) Object.assign(marker, { status: "uncertain", reasonCode, updatedAt: new Date().toISOString() });
    try { await this.saveSettings(); } catch (_) { /* durable prepared marker still blocks a retry */ }
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
  async reconcileImageSubmission(fingerprint) {
    if (!fingerprint) return;
    const previous = (this.settings.submissionMarkers || []).map((item) => ({ ...item }));
    this.settings.submissionMarkers = (this.settings.submissionMarkers || []).filter((item) => item.fingerprint !== fingerprint);
    try {
      await this.saveSettings();
    } catch (_) {
      this.settings.submissionMarkers = previous.map((item) => item.fingerprint === fingerprint
        ? { ...item, status: "uncertain", reasonCode: "RESULT_PERSISTENCE_FAILED", updatedAt: new Date().toISOString() }
        : item);
      try { await this.saveSettings(); } catch (_) { /* prior accepted marker remains */ }
      throw this.uncertaintyError();
    }
  }
  request(options, timeoutMs = 45000) { return this.api?.withTimeout ? this.api.withTimeout(requestUrl(options), timeoutMs, "图片服务请求") : requestUrl(options); }
  getAvatarUrl() {
    const file = `${String(this.manifest?.dir || ".obsidian/plugins/mangosteen-image").replace(/\\/g, "/")}/assets/mangosteen-avatar.png`;
    return this.app?.vault?.adapter?.getResourcePath?.(file) || "";
  }
  applyAvatar(element) {
    const url = this.getAvatarUrl();
    if (url && element?.style) element.style.backgroundImage = `url("${url}")`;
  }
  async refreshAgentAccess() {
    const revision = this.app?.plugins?.getPlugin?.("mangosteen-agent")?.getAccountBridge?.()?.getCatalogRevision?.();
    if (this.agentAccessRefreshPromise && this.agentAccessRefreshRevision === revision) return this.agentAccessRefreshPromise;
    const pending = this.refreshAgentAccessNow();
    this.agentAccessRefreshRevision = revision;
    this.agentAccessRefreshPromise = pending;
    try { return await pending; } finally { if (this.agentAccessRefreshPromise === pending) this.agentAccessRefreshPromise = null; }
  }
  async refreshAgentAccessNow() {
    const agent = this.app?.plugins?.getPlugin?.("mangosteen-agent") || this.app?.plugins?.plugins?.["mangosteen-agent"];
    const accountBridge = agent?.getAccountBridge?.();
    const bridge = agent?.getAihubkitImageBridge?.() || accountBridge;
    const revision = accountBridge?.getCatalogRevision?.();
    const previousAccess = this.agentImageAccess;
    const access = await bridge?.resolveImageAccess?.();
    if (revision !== undefined && revision !== accountBridge.getCatalogRevision()) {
      if (this.agentImageAccess === previousAccess) this.agentImageAccess = null;
      return null;
    }
    this.agentImageAccess = access && typeof access === "object" ? access : null;
    const models = Object.keys(this.agentImageAccess?.imageModelKeys || {});
    const selectedModel = preferredImageModel(models, this.settings.model);
    if (models.length && selectedModel !== this.settings.model) {
      this.settings.model = selectedModel;
      await this.saveSettings();
    }
    if (revision !== undefined && revision !== accountBridge.getCatalogRevision()) {
      if (this.agentImageAccess === access) this.agentImageAccess = null;
      return null;
    }
    return this.agentImageAccess;
  }
  openModal() {
    const modal = new ImageModal(this);
    modal.open();
  }
  async openSavedImage(imagePath) {
    const file = this.app?.vault?.getAbstractFileByPath?.(imagePath);
    if (!file) throw new Error("找不到这张历史图片，请检查生图记录目录。");
    const buffer = await this.app.vault.readBinary(file);
    const type = /\.jpe?g$/i.test(imagePath) ? "image/jpeg" : /\.webp$/i.test(imagePath) ? "image/webp" : "image/png";
    const modal = new ImageModal(this);
    modal.mode = "edit";
    modal.selectedImage = { name: imagePath.split("/").pop(), type, buffer: Buffer.from(buffer), previewUrl: this.app.vault.adapter.getResourcePath(imagePath) };
    modal.open();
    return modal;
  }

  async ensureHistoryFolder() {
    if (!await this.app.vault.adapter.exists(HISTORY_ROOT)) await this.app.vault.createFolder(HISTORY_ROOT);
    return HISTORY_ROOT;
  }
  async historyRecordFile() {
    const root = await this.ensureHistoryFolder();
    const path = `${root}/任务记录.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) file = await this.app.vault.create(path, "# 山竹生图任务记录\n");
    return file;
  }
  async persistGeneration({ candidates, prompt, mode, cost, model = this.settings.model }) {
    const now = new Date();
    const taskName = now.toISOString().replace(/[T:.Z]/g, "-");
    const root = await this.ensureHistoryFolder();
    const taskFolder = `${root}/${taskName}`;
    await this.app.vault.createFolder(taskFolder);
    const imagePaths = [];
    for (const [index, candidate] of candidates.entries()) {
      const image = await this.toSelectedImage(candidate, index + 1);
      const extension = /jpe?g/i.test(image.type) ? "jpg" : /webp/i.test(image.type) ? "webp" : "png";
      const imagePath = `${taskFolder}/图片-${index + 1}.${extension}`;
      await this.app.vault.createBinary(imagePath, image.buffer);
      imagePaths.push(imagePath);
    }
    const record = await this.historyRecordFile();
    const createdAt = now.toLocaleString("zh-CN", { hour12: false }).replaceAll("/", "-");
    const entry = this.api.createHistoryEntry({ createdAt, mode, model, prompt, cost, imagePaths });
    await this.app.vault.modify(record, `${await this.app.vault.read(record)}${entry}`);
    return { recordPath: record.path, imagePaths, createdAt, taskName };
  }
  async saveImageResult({ taskId, submissionFingerprint, candidates, prompt, mode, cost, requestedCount, model = this.settings.model }) {
    const saved = await this.persistGeneration({ candidates, prompt, mode, cost, model });
    let task = (this.settings.imageTasks || []).find((item) => item.id === taskId);
    if (!task) {
      task = { id: taskId || saved.taskName, accountUserId: String(this.agentImageAccess?.accountUserId || ""), createdAt: new Date().toISOString() };
      this.settings.imageTasks = [task, ...(this.settings.imageTasks || [])].slice(0, 50);
    }
    Object.assign(task, {
      prompt, mode, model, cost,
      size: task.size || this.settings.size,
      requestedCount: Number(task.requestedCount || requestedCount || (mode === "文生图" ? this.settings.count : 1)),
      outputCount: candidates.length,
      imagePaths: saved.imagePaths, recordPath: saved.recordPath, status: "completed", progress: 100, saved: true,
    });
    const fingerprint = submissionFingerprint || task.submissionFingerprint;
    const previousMarkers = (this.settings.submissionMarkers || []).map((item) => ({ ...item }));
    this.settings.submissionMarkers = (this.settings.submissionMarkers || []).filter((item) => item.fingerprint !== fingerprint);
    try {
      await this.saveSettings();
    } catch (_) {
      this.settings.submissionMarkers = previousMarkers.map((item) => item.fingerprint === fingerprint
        ? { ...item, status: "uncertain", reasonCode: "RESULT_PERSISTENCE_FAILED", updatedAt: new Date().toISOString() }
        : item);
      try { await this.saveSettings(); } catch (_) { /* prior accepted marker remains */ }
      throw this.uncertaintyError();
    }
    this.refreshImageTaskViews();
    void this.refreshTaskUsageRecords();
    return task;
  }
  async openHistory() {
    new ImageHistoryModal(this).open();
  }
  async rememberImageTask({ id, taskPath, mode, prompt, model, group, size, requestedCount, submissionFingerprint }) {
    const task = { id, taskPath, mode, prompt, model, group, size, requestedCount, submissionFingerprint, accountUserId: String(this.agentImageAccess?.accountUserId || ""), createdAt: new Date().toISOString(), status: "processing", progress: null, saved: false };
    const previousTasks = this.settings.imageTasks || [];
    const previousMarkers = (this.settings.submissionMarkers || []).map((item) => ({ ...item }));
    const marker = submissionFingerprint ? this.submissionMarker(submissionFingerprint) : null;
    if (marker) Object.assign(marker, { status: "accepted", taskId: id, updatedAt: new Date().toISOString() });
    this.settings.imageTasks = [task, ...previousTasks.filter((item) => item.id !== id)].slice(0, 50);
    try {
      await this.saveSettings();
    } catch (_) {
      this.settings.imageTasks = previousTasks;
      this.settings.submissionMarkers = previousMarkers.map((item) => item.fingerprint === submissionFingerprint
        ? { ...item, status: "uncertain", reasonCode: "TASK_PERSISTENCE_FAILED", updatedAt: new Date().toISOString() }
        : item);
      try { await this.saveSettings(); } catch (_) { /* durable prepared marker remains */ }
      throw this.uncertaintyError();
    }
    return task;
  }
  refreshImageTaskViews() { for (const view of this.imageTaskViews || []) { view.refreshTasks?.(); view.refreshPrice?.(); } }
  async refreshTaskUsageRecords() {
    const agent = this.app?.plugins?.getPlugin?.("mangosteen-agent") || this.app?.plugins?.plugins?.["mangosteen-agent"];
    const bridge = agent?.getAccountBridge?.();
    const accountUserId = String(bridge?.getAccountUserId?.() || "");
    const tasks = (this.settings.imageTasks || []).filter((task) => ["completed", "failed"].includes(task.status) && (!task.usageLogMatched || !task.accountUserId) && (!task.accountUserId || String(task.accountUserId) === accountUserId));
    if (!tasks.length) return;
    const result = await bridge?.matchMediaUsage?.(tasks.map((task) => Object.assign({ kind: "image" }, task)));
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
    this.refreshImageTaskViews();
  }
  async fetchImageTask(task) {
    await this.refreshAgentAccess();
    const apiKey = this.getImageKey(task.model, task.group);
    const response = await this.request({ url: `${API_BASE}/v1/images/generations/tasks/${encodeURIComponent(task.id)}`, method: "GET", headers: this.headers(false, apiKey), throw: false });
    if (response.status >= 400) throw new Error(this.extractApiError(response.json, response.status));
    return response.json;
  }
  async waitForImageTask(task) {
    for (let attempt = 0; attempt < IMAGE_TASK_WAIT_ATTEMPTS; attempt += 1) {
      const response = await this.fetchImageTask(task);
      const results = this.extractResults(response);
      task.progress = this.api.readImageTaskProgress(response);
      if (results.length) {
        task.status = "completed";
        await this.saveSettings();
        this.refreshImageTaskViews();
        response.__mangosteenTaskId = task.id;
        response.__mangosteenSubmissionFingerprint = task.submissionFingerprint;
        return response;
      }
      const state = this.api.readImageTaskState(response);
      if (/failed|error|cancel|rejected/.test(state)) {
        task.status = "failed";
        this.settings.submissionMarkers = (this.settings.submissionMarkers || []).filter((item) => item.fingerprint !== task.submissionFingerprint);
        await this.saveSettings();
        this.refreshImageTaskViews();
        throw new Error("平台图片任务执行失败，请打开生图记录查看后重试。");
      }
      task.status = /queued|pending|waiting/.test(state) ? "queued" : "processing";
      await this.saveSettings();
      this.refreshImageTaskViews();
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
    }
    throw new Error("图片任务仍在平台处理中。请点击“生图记录”稍后重新查询。");
  }
  async refreshImageTasks(recheckFailed = false) {
    if (this.imageTasksRefreshPromise) return this.imageTasksRefreshPromise;
    this.imageTasksRefreshPromise = this.refreshImageTasksNow(recheckFailed);
    try { return await this.imageTasksRefreshPromise; } finally { this.imageTasksRefreshPromise = null; }
  }
  async refreshImageTasksNow(recheckFailed = false) {
    for (const task of this.settings.imageTasks || []) {
      if (task.saved || (task.status === "failed" && !recheckFailed)) continue;
      try {
        const response = await this.fetchImageTask(task);
        const results = this.extractResults(response);
        task.lastCheckedAt = new Date().toISOString();
        task.lastError = "";
        task.progress = this.api.readImageTaskProgress(response);
        if (!results.length) {
          const state = this.api.readImageTaskState(response);
          if (/failed|error|cancel|rejected/.test(state)) {
            task.status = "failed";
            task.lastError = this.toChineseError(response?.data?.message || response?.message || response?.error?.message || "平台图片任务执行失败");
            this.settings.submissionMarkers = (this.settings.submissionMarkers || []).filter((item) => item.fingerprint !== task.submissionFingerprint);
            continue;
          }
          task.status = /queued|pending|waiting/.test(state) ? "queued" : "processing";
          continue;
        }
        if (task.status === "failed") {
          task.usageLogMatched = false;
          task.usageLogDetail = "";
        }
        task.status = "saving";
        await this.saveImageResult({ taskId: task.id, submissionFingerprint: task.submissionFingerprint, candidates: results, prompt: task.prompt, mode: task.mode, cost: task.cost ?? null, model: task.model });
      } catch (error) {
        const saving = task.status === "saving";
        task.status = "retrying";
        task.lastCheckedAt = new Date().toISOString();
        task.lastError = this.toChineseError(error).replace(/^生成失败：/, saving ? "图片已生成，但保存失败：" : "查询失败：");
      }
    }
    await this.saveSettings();
    this.refreshImageTaskViews();
    void this.refreshTaskUsageRecords();
  }

  getImageKeyCandidates(model = this.settings.model) {
    const listed = this.agentImageAccess?.imageModelKeyCandidates?.[model] || [];
    if (listed.length) return listed.filter((item) => item?.key);
    const key = this.agentImageAccess?.imageModelKeys?.[model];
    return key ? [{ group: "", key }] : [];
  }
  getImageKey(model = this.settings.model, group = "") { const candidates = this.getImageKeyCandidates(model); return (group ? candidates.find((item) => item.group === group) : candidates[0])?.key || ""; }
  getBalanceKey() { return this.agentImageAccess?.balanceKey || this.getImageKey(); }
  requireKey(apiKey = this.getImageKey()) { if (!apiKey) throw new Error("请先在“设置 → 山竹账号中心”中登录绑定账号"); }
  headers(json = true, apiKey = this.getImageKey()) { this.requireKey(apiKey); const headers = { Authorization: `Bearer ${apiKey}` }; if (json) headers["Content-Type"] = "application/json"; return headers; }
  async postJsonResponse(pathname, payload, model = payload?.model || this.settings.model) {
    return this.requestWithImageKeyFallback((apiKey) => this.request({ url: `${API_BASE}${pathname}`, method: "POST", headers: this.headers(true, apiKey), body: JSON.stringify(payload), throw: false }), model);
  }
  async requestWithImageKeyFallback(request, model = this.settings.model) {
    await this.refreshAgentAccess();
    const candidates = this.getImageKeyCandidates(model);
    this.requireKey(candidates[0]?.key);
    let response;
    for (const candidate of candidates) {
      response = await request(candidate.key);
      response.__mangosteenGroup = candidate.group;
      if (response.status < 400 || !/no available channel/i.test(this.extractApiError(response.json, response.status))) return response;
    }
    return response;
  }
  async requestJson(pathname, payload, model = payload?.model || this.settings.model) {
    const response = await this.postJsonResponse(pathname, payload, model);
    if (response.status >= 400) throw this.remoteImageError(response.json, response.status, model);
    return response.json;
  }
  async submitImageTask({ taskPath, fallbackPath, mode, prompt, model = this.settings.model, requestedCount = 1, submissionFingerprint, requestShape, submit, fallbackSubmit }) {
    if (!Array.isArray(this.settings.submissionMarkers)) this.settings.submissionMarkers = [];
    await this.prepareSubmissionMarker(submissionFingerprint, requestShape);
    let response;
    try {
      response = await submit(taskPath);
      if (response.status === 404 || response.status === 405) response = await fallbackSubmit(fallbackPath);
    } catch (_) {
      return this.markSubmissionUncertain(submissionFingerprint, "REMOTE_RESPONSE_LOST");
    }
    if (response.status === 408 || response.status >= 500) return this.markSubmissionUncertain(submissionFingerprint, "REMOTE_ACCEPTANCE_AMBIGUOUS");
    if (response.status >= 400) {
      await this.releaseRejectedSubmission(submissionFingerprint);
      throw this.remoteImageError(response.json, response.status, model);
    }
    if (this.extractResults(response.json).length) {
      const id = `sync-${submissionFingerprint.slice(-16)}-${Date.now()}`;
      const task = await this.rememberImageTask({ id, taskPath, mode, prompt, model, group: response.__mangosteenGroup, size: this.settings.size, requestedCount, submissionFingerprint });
      response.json.__mangosteenTaskId = task.id;
      response.json.__mangosteenSubmissionFingerprint = submissionFingerprint;
      return response.json;
    }
    const id = this.api.extractImageTaskId(response.json);
    if (!id) return this.markSubmissionUncertain(submissionFingerprint, "TASK_ID_MISSING");
    const task = await this.rememberImageTask({ id, taskPath, mode, prompt, model, group: response.__mangosteenGroup, size: this.settings.size, requestedCount, submissionFingerprint });
    return this.waitForImageTask(task);
  }
  async generateText(prompt, count = this.settings.count, submissionSlot = "single", options = {}) {
    const model = String(options?.model || this.settings.model || "").trim();
    const requestedCount = Math.max(1, Math.min(7, Number.parseInt(count, 10) || 1));
    const payload = this.api.createTextToImagePayload({ model, prompt, size: this.settings.size, count: requestedCount });
    const submissionFingerprint = this.api.createSubmissionFingerprint({ kind: "text-to-image", submissionSlot, payload });
    const response = await this.submitImageTask({ taskPath: "/v1/images/generations/tasks", fallbackPath: "/v1/images/generations", mode: "文生图", prompt, model, requestedCount, submissionFingerprint, requestShape: { version: 1, mode: "text-to-image", model: payload.model, size: payload.size, count: requestedCount }, submit: (path) => this.postJsonResponse(path, payload, model), fallbackSubmit: (path) => this.postJsonResponse(path, payload, model) });
    response.__mangosteenRequestedCount = requestedCount;
    return response;
  }
  async generateEdit(prompt, image, submissionSlot = "single", options = {}) {
    return this.generateEditMulti(prompt, [image], submissionSlot, options);
  }
  async generateEditMulti(prompt, images, submissionSlot = "single", options = {}) {
    const model = String(options?.model || this.settings.model || "").trim();
    await this.refreshAgentAccess();
    this.requireKey(this.getImageKey(model));
    if (!String(prompt || "").trim()) throw new Error("请先输入如何修改图片");
    if (!Array.isArray(images) || images.length < 1 || images.length > 4) throw new Error("请选择 1–4 张参考图片");
    for (const image of images) this.api.assertLocalImageUploadSize(image);
    const fields = { model, prompt: String(prompt).trim(), images, size: this.settings.size, quality: "high", output_format: "png" };
    const fingerprintImages = images.map((image) => ({ name: image.name, type: image.type, buffer: image.buffer }));
    const submissionFingerprint = this.api.createSubmissionFingerprint({ kind: "image-edit", submissionSlot, fields: { ...fields, images: fingerprintImages } });
    return this.submitImageTask({ taskPath: "/v1/images/edits/tasks", fallbackPath: "/v1/images/edits", mode: "图生图", prompt: fields.prompt, model, submissionFingerprint, requestShape: { version: 1, mode: "image-edit", model: fields.model, size: fields.size, referenceImageCount: images.length }, submit: (path) => this.postMultipart(path, fields, model), fallbackSubmit: (path) => this.postMultipart(path, fields, model) });
  }
  async runGenerationBatch(count, generate) {
    const total = Math.max(1, Math.min(7, Number.parseInt(count, 10) || 1));
    const successes = new Array(total);
    const failures = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < total) {
        const index = cursor++;
        try { successes[index] = { index, response: await generate(index) }; }
        catch (error) { failures.push({ index, error }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, total) }, () => worker()));
    return { successes: successes.filter(Boolean), failures: failures.sort((a, b) => a.index - b.index) };
  }
  async generateTextBatch(prompt, count) { return this.runGenerationBatch(count, (index) => this.generateText(prompt, 1, `batch-${index + 1}`)); }
  async generateEditBatch(prompt, image, count) { return this.runGenerationBatch(count, (index) => this.generateEdit(prompt, image, `batch-${index + 1}`)); }
  async postMultipart(pathname, fields, model = fields?.model || this.settings.model) {
    const https = require("https");
    const boundary = `----Mangosteen${Date.now().toString(16)}`;
    const body = this.api.buildImageEditMultipart(fields, boundary);
    return this.requestWithImageKeyFallback((apiKey) => new Promise((resolve, reject) => {
      const request = https.request(`${API_BASE}${pathname}`, { method: "POST", headers: Object.assign({}, this.headers(false, apiKey), { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length }) }, (response) => {
        const output = [];
        response.on("data", (chunk) => output.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(output).toString("utf8");
          let json = {}; try { json = JSON.parse(text); } catch (_) { json = { message: text }; }
          resolve({ status: response.statusCode || 0, json });
        });
      });
      request.setTimeout(45000, () => request.destroy(new Error("图片上传超时，请检查网络后重试。")));
      request.on("error", reject); request.write(body); request.end();
    }), model);
  }
  async getRawQuota() {
    await this.refreshAgentAccess();
    const apiKey = this.getBalanceKey();
    this.requireKey(apiKey);
    const request = this.api.createBalanceRequest(apiKey);
    const response = await this.request({ url: `${API_BASE}${request.path}`, method: "GET", headers: request.headers, throw: false });
    if (response.status >= 400) throw new Error(this.extractApiError(response.json, response.status));
    return Number(response.json?.data?.quota);
  }
  async getQuota() { const quota = await this.getRawQuota(); return this.api.readQuota({ data: { quota } }); }
  getImagePrice(model, mode, size, count) {
    const accountUserId = String(this.agentImageAccess?.accountUserId || "");
    if (!accountUserId) return null;
    const task = (this.settings.imageTasks || []).find((item) => {
      const owner = String(item.accountUserId || item.usageAccountUserId || "");
      const outputCount = Number(item.outputCount || item.imagePaths?.length || item.requestedCount || 0);
      return item.status === "completed" && item.usageLogMatched && item.cost != null && item.cost !== "" && Number.isFinite(Number(item.cost)) && outputCount > 0
        && owner === accountUserId
        && item.model === model && item.mode === mode && String(item.size || DEFAULT_SETTINGS.size) === String(size || DEFAULT_SETTINGS.size);
    });
    if (!task) return null;
    const outputCount = Number(task.outputCount || task.imagePaths?.length || task.requestedCount);
    const rawAmount = Number(task.cost) / outputCount;
    const amount = Number(rawAmount.toFixed(4));
    const selectedCount = Math.max(1, Math.min(7, Number.parseInt(count, 10) || 1));
    return { amount, unit: "image", total: Number((rawAmount * selectedCount).toFixed(4)) };
  }
  calculateCost(before, after) { return this.api.calculateCost(before, after); }
  extractResults(response) { return this.api.extractImageResults(response); }
  toPreviewUrl(candidate) { return candidate.kind === "base64" ? `data:image/png;base64,${candidate.value}` : candidate.value; }
  async toSelectedImage(candidate, index) {
    if (candidate.kind === "base64") return { name: `山竹生图-${index}.png`, type: "image/png", buffer: Buffer.from(candidate.value, "base64") };
    const response = await this.request({ url: candidate.value, method: "GET", throw: false }, 60000);
    if (response.status >= 400) throw new Error("无法读取生成图片，请先下载后再上传修改");
    this.api?.assertImageDownloadSize?.(response);
    return { name: `山竹生图-${index}.png`, type: response.headers?.["content-type"] || response.headers?.["Content-Type"] || "image/png", buffer: Buffer.from(response.arrayBuffer) };
  }
  download(candidate, index) {
    const anchor = document.createElement("a");
    anchor.href = this.toPreviewUrl(candidate); anchor.download = `山竹生图-${index}.png`; anchor.click();
  }
  extractApiError(json, status) { return String(json?.error?.message || json?.message || json?.error || `请求失败（${status}）`); }
  remoteImageError(json, status, model = this.settings.model) {
    const error = new Error(this.extractApiError(json, status));
    error.code = Number(status) === 404 ? "MODEL_UNAVAILABLE" : "REMOTE_REJECTED";
    error.status = Number(status) || 0;
    error.model = String(model || "");
    error.changeModel = error.status === 404 || /model|channel|模型|线路/i.test(error.message);
    return error;
  }
  toChineseError(error) {
    const message = String(error?.message || error || "未知错误").replace(/sk-[A-Za-z0-9_-]+/g, "[已隐藏]");
    if (/当前账号实际分组|图片分组/.test(message)) return message;
    if (/no available channel/i.test(message)) return "当前模型暂时没有可用图片线路。插件已尝试所有兼容分组，请稍后重试或在“山竹账号中心”中检查模型权限。";
    if (/username or password is incorrect|user has been banned|用户名或密码错误/i.test(message)) return "登录绑定失败：请检查邮箱和密码。若网页端可以登录但此处仍失败，请联系平台确认该账号未被禁用。";
    if (/登录会话|session|cookie/i.test(message)) return "登录会话已过期。请打开“设置 → 山竹账号中心”重新登录绑定。";
    if (/401|unauthori|api.?key|token/i.test(message)) return "AIHubKit 登录或模型授权已失效。请打开“设置 → 山竹账号中心”重新登录绑定。";
    if (/quota|balance|insufficient|credit/i.test(message)) return "账户余额不足。请点击“注册 / 充值”前往平台充值后重试。";
    if (/timeout|network|ENOTFOUND|ECONN/i.test(message)) return "网络连接失败或平台暂时无响应。请检查网络后重试。";
    return `生成失败：${message}`;
  }
};
