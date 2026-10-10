const { Plugin, Modal, Notice, requestUrl } = require("obsidian");
const path = require("path");
const fs = require("fs");

const API_BASE = "https://apimodel.aihubkit.com";
const DEFAULT_SETTINGS = {
  model: "",
  duration: 5,
  ratio: "16:9",
  resolution: "720p",
  resolutionsByModel: {},
  videoTasks: [],
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
    let generateAudio;
    if (supportsImageToVideo(model.value)) {
      const audioRow = advanced.createDiv({ cls: "mangosteen-video-audio-row" });
      const audioCopy = audioRow.createDiv({ cls: "mangosteen-video-audio-copy" });
      audioCopy.createEl("strong", { text: "同步生成音频" });
      audioCopy.createEl("span", { text: "让模型同时生成视频配音" });
      const audioToggle = audioRow.createEl("label", { cls: "mangosteen-video-audio-toggle" });
      generateAudio = audioToggle.createEl("input", { attr: { type: "checkbox", "aria-label": "同步生成音频" } });
      audioToggle.createEl("span", { cls: "mangosteen-video-audio-track" });
      generateAudio.checked = Boolean(this.draftGenerateAudio);
      generateAudio.addEventListener("change", () => { this.draftGenerateAudio = generateAudio.checked; });
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
          generateAudio: Boolean(generateAudio?.checked),
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
    if (!this.api) {
      const adapter = this.app?.vault?.adapter;
      const vaultBasePath = adapter?.getBasePath?.() || adapter?.basePath;
      if (!vaultBasePath) throw new Error("无法定位山竹视频插件目录");
      const apiPath = path.join(vaultBasePath, ...String(this.manifest.dir || "").split(/[\\/]/), "video-api.cjs");
      this.api = require(apiPath);
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData?.());
    this.videoTaskViews = new Set();
    if (!this.settings.resolutionsByModel || typeof this.settings.resolutionsByModel !== "object") this.settings.resolutionsByModel = {};
    this.addRibbonIcon?.("video", "打开山竹视频", () => this.openStudio());
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
      const usedReferenceVideo = Array.isArray(payload.referenceVideos) && payload.referenceVideos.length > 0;
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
    const saved = Object.assign({
      accountUserId: String(this.videoAccess?.accountUserId || ""),
      createdAt: new Date().toISOString(),
      status: "queued",
      progress: null,
      saved: false,
      lastError: "",
    }, task, { payload });
    this.settings.videoTasks = [saved, ...(this.settings.videoTasks || []).filter((item) => item.id !== saved.id)].slice(0, 50);
    await this.saveSettings();
    return saved;
  }

  async refreshTaskUsageRecords() {
    const agent = this.app?.plugins?.getPlugin?.("mangosteen-agent") || this.app?.plugins?.plugins?.["mangosteen-agent"];
    const bridge = agent?.getAccountBridge?.();
    const accountUserId = String(bridge?.getAccountUserId?.() || "");
    const tasks = (this.settings.videoTasks || []).filter((task) => ["completed", "failed"].includes(task.status) && (!task.usageLogMatched || !task.accountUserId) && (!task.accountUserId || String(task.accountUserId) === accountUserId));
    if (!tasks.length) return;
    const result = await bridge?.matchMediaUsage?.(tasks.map((task) => Object.assign({ kind: "video" }, task)));
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
    if (!uploaded?.ok || !/^https?:\/\/[^\s]+$/i.test(String(uploaded.url || "").trim())) {
      throw new Error(label + "图片上传失败，请检查网络、文件格式或重新登录后重试。");
    }
    return String(uploaded.url).trim();
  }

  async submitVideo(options) {
    const payloadOptions = Object.assign({}, options, { allowedResolutions: this.settings.resolutionsByModel?.[options.model] });
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
    let response = await this.sendVideoPayload(payload);
    const allowed = this.api.readAllowedResolutions(response.json);
    if (response.status >= 400 && allowed.length && !allowed.includes(payload.resolution)) {
      this.settings.resolutionsByModel[payload.model] = allowed;
      this.settings.resolution = allowed[0];
      await this.saveSettings();
      payload = this.api.createVideoPayload(Object.assign({}, payloadOptions, { resolution: allowed[0], allowedResolutions: allowed }));
      response = await this.sendVideoPayload(payload);
    }
    if (response.status >= 400) throw new Error(this.extractApiError(response.json, response.status));
    const id = this.api.extractVideoTaskId(response.json);
    if (!id) throw new Error("平台已接收请求，但没有返回视频任务编号。");
    return this.rememberVideoTask({
      id,
      model: payload.model,
      prompt: payload.prompt,
      payload,
      group: response.__mangosteenGroup,
      beforeQuota,
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
    if (!this.app?.vault?.getAbstractFileByPath?.(folder)) await this.app.vault.createFolder(folder);
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
    const root = "山竹视频";
    const folder = `${root}/${this.api.safeVideoTaskSegment(task.id)}`;
    await this.ensureVaultFolder(root);
    await this.ensureVaultFolder(folder);
    const filePath = `${folder}/${this.api.safeVideoFilename(`${task.prompt || task.id}.mp4`)}`;
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
