const { ItemView, Modal, Notice, Plugin, requestUrl } = require("obsidian");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let core;
let generationPolicy;
let projectStorage;
let referenceAssets;
let replicaEditor;
let replicaLogicApi;
let runState;
let shotTimeline;
let visualStyle;
let workflow;

const ROOT = "山竹视频复刻";
const REQUEST_FILE = "generation-request.json";
const STATE_FILE = ".work/generation-state.json";
const QUEUE_FILE = ".work/generation-queue.json";
const QUEUE_LOCK_FILE = ".work/generation-queue.lock";
const STOP_FILE = ".work/stop-request.json";
const GENERATION_STOPPED_CODE = "GENERATION_STOPPED";
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const SUBMISSION_GATE_TIMEOUT_MS = 2 * 60 * 1000;
const SUBMISSION_GATE_STALE_MS = 5 * 60 * 1000;
const SUBMISSION_GATE_RETRY_MS = 25;
const DEFAULT_SETTINGS = { analysisGroup: "", analysisModel: "", imageModel: "", videoModel: "" };
const WORKBENCH_SHOT_FIELDS = [
  "id",
  "title",
  "duration",
  "sceneId",
  "productIds",
  "timeline",
  "dialogue",
  "voiceDirection",
  "plot",
  "environment",
  "camera",
  "imagePrompt",
  "lastImagePrompt",
  "videoPrompt",
  "videoPromptOverride",
  "legacyFrameMode",
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeJson(filePath, value) { atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`); }

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
  return target;
}

function isInsidePath(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function withWorkbenchShotIds(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || !Array.isArray(request.shots)) return request;
  const used = new Set();
  const shots = request.shots.map((shot, index) => {
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) return shot;
    const fallback = `shot-${String(index + 1).padStart(3, "0")}`;
    const base = String(shot.workbenchId || shot.id || fallback).trim() || fallback;
    let workbenchId = base;
    let suffix = 2;
    while (used.has(workbenchId)) {
      workbenchId = `${base}~${suffix}`;
      suffix += 1;
    }
    used.add(workbenchId);
    return { ...shot, workbenchId };
  });
  return { ...request, shots };
}

class PrepareModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.sourcePath = ""; }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mangosteen-replica-modal");
    contentEl.createEl("h2", { text: "新建视频复刻项目" });
    contentEl.createEl("p", { text: "选择 3 分钟以内的 MP4、MOV 或 M4V。处理在本机完成，不上传整条源视频。" });
    const modelRow = contentEl.createDiv({ cls: "mangosteen-replica-model-row" });
    const modelLabel = modelRow.createEl("span", { text: `分析模型：${this.plugin.analysisSelectionLabel()}` });
    const modelButton = modelRow.createEl("button", { text: "选择模型" });
    modelButton.addEventListener("click", () => new AnalysisModelModal(this.plugin, () => {
      modelLabel.setText(`分析模型：${this.plugin.analysisSelectionLabel()}`);
    }).open());
    const generationRow = contentEl.createDiv({ cls: "mangosteen-replica-model-row" });
    const generationLabel = generationRow.createEl("span", { text: `生成模型：${this.plugin.generationSelectionLabel()}` });
    const generationButton = generationRow.createEl("button", { text: "选择生成模型" });
    generationButton.addEventListener("click", () => new GenerationModelModal(this.plugin, () => {
      generationLabel.setText(`生成模型：${this.plugin.generationSelectionLabel()}`);
    }).open());
    const picker = contentEl.createEl("input", { attr: { type: "file", accept: ".mp4,.mov,.m4v,video/mp4,video/quicktime" } });
    const status = contentEl.createDiv({ cls: "mangosteen-replica-status", text: "等待选择视频" });
    const button = contentEl.createEl("button", { cls: "mod-cta", text: "开始本地拆解" });

    picker.addEventListener("change", () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        this.sourcePath = require("electron")?.webUtils?.getPathForFile?.(file) || file.path || "";
      } catch (_) { this.sourcePath = file.path || ""; }
      status.setText(this.sourcePath ? `已选择：${file.name}` : "无法读取本地路径，请重新选择。" );
    });

    button.addEventListener("click", async () => {
      if (!this.sourcePath) { new Notice("请先选择本地视频。", 4000); return; }
      button.disabled = true;
      status.setText("正在抽取画面并识别台词，请不要关闭 Obsidian…");
      try {
        const project = await this.plugin.prepareVideo(this.sourcePath);
        status.setText("本地拆解完成，AI 正在分析人物、场景和分镜…");
        try {
          await this.plugin.analyzeProject(project.folder);
          status.setText("AI 分析完成，正在打开项目总览。");
          new Notice("分镜草案已生成。检查后运行“确认并开始付费生成最近项目”。", 9000);
        } catch (error) {
          status.setText("本地拆解已完成，但 AI 分析失败。");
          new Notice(`AI 分析失败：${String(error?.message || error)}。可运行“分析最近的视频复刻项目”重试。`, 12000);
        }
        await this.plugin.openVaultPath(`${project.folder}/00-项目总览.md`);
        this.close();
      } catch (error) {
        status.setText(`失败：${String(error?.message || error)}`);
        new Notice(String(error?.message || error), 9000);
      } finally { button.disabled = false; }
    });
  }
}

class AnalysisModelModal extends Modal {
  constructor(plugin, onSaved = null) { super(plugin.app); this.plugin = plugin; this.onSaved = onSaved; }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mangosteen-replica-modal");
    contentEl.createEl("h2", { text: "选择视频分析模型" });
    contentEl.createEl("p", { text: "这里只影响人物、场景和分镜分析，不会修改聊天框当前模型。" });
    const catalog = this.plugin.analysisModelCatalog();
    if (!catalog.groups.length) {
      contentEl.createEl("p", { text: "暂未读取到可用模型。请先登录山竹账号，或打开山竹账号中心刷新模型。" });
      return;
    }
    const selection = this.plugin.resolveAnalysisSelection(catalog);
    const groupLabel = contentEl.createEl("label", { text: "模型分组" });
    const groupSelect = groupLabel.createEl("select");
    for (const group of catalog.groups) groupSelect.createEl("option", {
      text: `${group.label} · ×${group.ratio}`,
      attr: { value: group.id },
    });
    groupSelect.value = selection.group;
    const modelLabel = contentEl.createEl("label", { text: "语言模型" });
    const modelSelect = modelLabel.createEl("select");
    const renderModels = (groupId, preferred = "") => {
      modelSelect.empty();
      const group = catalog.groups.find((item) => item.id === groupId) || catalog.groups[0];
      for (const model of group.models) modelSelect.createEl("option", { text: model, attr: { value: model } });
      modelSelect.value = group.models.includes(preferred) ? preferred : String(group.models[0] || "");
    };
    renderModels(selection.group, selection.model);
    groupSelect.addEventListener("change", () => renderModels(groupSelect.value));
    const saveButton = contentEl.createEl("button", { cls: "mod-cta", text: "保存分析模型" });
    saveButton.addEventListener("click", async () => {
      const saved = await this.plugin.setAnalysisSelection(groupSelect.value, modelSelect.value, catalog);
      if (!saved) { new Notice("所选模型已不可用，请刷新后重新选择。", 6000); return; }
      this.onSaved?.();
      new Notice(`视频分析模型已切换为 ${modelSelect.value}。`, 5000);
      this.close();
    });
  }
}

class GenerationModelModal extends Modal {
  constructor(plugin, onSaved = null) { super(plugin.app); this.plugin = plugin; this.onSaved = onSaved; }

  onOpen() {
    this.contentEl.addClass("mangosteen-replica-modal");
    this.contentEl.createEl("h2", { text: "选择图片与视频生成模型" });
    this.status = this.contentEl.createEl("p", { text: "正在读取当前账号可用模型…" });
    void this.loadCatalog();
  }

  async loadCatalog() {
    try {
      const catalog = await this.plugin.refreshGenerationModelCatalog();
      const selection = this.plugin.resolveGenerationSelection(catalog);
      this.status.remove();
      const imageLabel = this.contentEl.createEl("label", { text: "图片模型" });
      const imageSelect = imageLabel.createEl("select");
      for (const model of catalog.imageModels) imageSelect.createEl("option", { text: model, attr: { value: model } });
      imageSelect.value = selection.imageModel;
      const videoLabel = this.contentEl.createEl("label", { text: "视频模型" });
      const videoSelect = videoLabel.createEl("select");
      for (const model of catalog.videoModels) videoSelect.createEl("option", { text: model, attr: { value: model } });
      videoSelect.value = selection.videoModel;
      const saveButton = this.contentEl.createEl("button", { cls: "mod-cta", text: "保存生成模型" });
      saveButton.addEventListener("click", async () => {
        const saved = await this.plugin.setGenerationSelection(imageSelect.value, videoSelect.value, catalog);
        if (!saved) { new Notice("所选生成模型已不可用，请刷新后重新选择。", 6000); return; }
        this.onSaved?.();
        new Notice(`已选择：${imageSelect.value} + ${videoSelect.value}`, 5000);
        this.close();
      });
    } catch (error) {
      this.status.setText(`模型读取失败：${String(error?.message || error)}`);
    }
  }
}

module.exports = class MangosteenVideoReplicaPlugin extends Plugin {
  async onload() {
    const pluginRoot = path.join(this.vaultPath(), ...String(this.manifest.dir || "").split(/[\\/]/).filter(Boolean));
    core = require(path.join(pluginRoot, "replica-core.cjs"));
    generationPolicy = require(path.join(pluginRoot, "generation-policy.cjs"));
    projectStorage = require(path.join(pluginRoot, "project-storage.cjs"));
    shotTimeline = require(path.join(pluginRoot, "shot-timeline.cjs"));
    visualStyle = require(path.join(pluginRoot, "visual-style.cjs"));
    referenceAssets = require(path.join(pluginRoot, "reference-assets.cjs"));
    replicaEditor = require(path.join(pluginRoot, "replica-editor.cjs"));
    replicaLogicApi = require(path.join(pluginRoot, "replica-logic-api.cjs"));
    runState = require(path.join(pluginRoot, "run-state.cjs"));
    workflow = require(path.join(pluginRoot, "replica-cli.cjs"));
    const workbench = require(path.join(pluginRoot, "replica-workbench.cjs"));
    const VideoReplicaWorkbenchView = workbench.createVideoReplicaWorkbenchView(ItemView);
    this.pluginRoot = pluginRoot;
    this.workbenchViewType = workbench.VIEW_TYPE;
    this.instanceId = crypto.randomUUID();
    this.processing = new Set();
    this.confirmingProjects = new Set();
    this.referenceAssetPromises = new Map();
    this.queueApis = new Map();
    this.queueRuns = new Map();
    this.activeQueueObjects = new Map();
    this.queueRunnerLocks = new Map();
    this.queueRunnerLockRequired = new Set();
    const savedSettings = typeof this.loadData === "function" ? await this.loadData() : null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings && typeof savedSettings === "object" ? savedSettings : {});
    this.registerView(this.workbenchViewType, (leaf) => new VideoReplicaWorkbenchView(leaf, this));
    this.addRibbonIcon("clapperboard", "山竹视频复刻", () => void this.activateWorkbench());
    this.addCommand({ id: "open-video-replica-workbench", name: "打开视频复刻制作驾驶舱", callback: () => void this.activateWorkbench() });
    this.addCommand({ id: "prepare-local-video", name: "从本地视频新建复刻项目", callback: () => this.openPrepareModal() });
    this.addCommand({ id: "select-analysis-model", name: "选择视频分析语言模型", callback: () => this.openAnalysisModelModal() });
    this.addCommand({ id: "select-generation-models", name: "选择视频复刻的图片与视频模型", callback: () => this.openGenerationModelModal() });
    this.addCommand({ id: "analyze-latest-project", name: "分析最近的视频复刻项目", callback: () => void this.analyzeLatestProject() });
    this.addCommand({ id: "confirm-latest-generation", name: "选择分镜并开始生成", callback: () => void this.confirmLatestGeneration() });
    this.addCommand({ id: "concat-latest-project", name: "拼接最近已完成项目", callback: () => void this.concatLatestProject() });
    this.addCommand({ id: "stop-latest-generation", name: "停止最近的视频复刻任务", callback: () => void this.stopLatestGeneration() });
    this.addCommand({ id: "scan-generation-requests", name: "检查已确认的视频复刻任务", callback: () => void this.scanRequests(true) });
    this.registerInterval(window.setInterval(() => void this.scanRequests(false), 5000));
    const handleProjectFileChange = (file) => {
      if (this.isWorkbenchDataFile(file)) this.requestWorkbenchRefresh();
      if (file?.name === REQUEST_FILE) void this.processRequestByVaultPath(file.path, true);
    };
    this.registerEvent(this.app.vault.on("create", handleProjectFileChange));
    this.registerEvent(this.app.vault.on("modify", handleProjectFileChange));
    const startupTimeout = window.setTimeout(() => {
      void this.recoverWorkbenchQueues().finally(() => this.scanRequests(false));
    }, 1500);
    this.register(() => window.clearTimeout(startupTimeout));
  }

  vaultPath() {
    const adapter = this.app.vault.adapter;
    const base = adapter?.getBasePath?.() || adapter?.basePath;
    if (!base) throw new Error("无法定位当前 Obsidian 知识库。");
    return base;
  }

  absolute(vaultPath, options = {}) {
    const raw = String(vaultPath).trim().replace(/\\/g, "/");
    if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) throw new Error("知识库文件不能使用绝对路径，已拒绝访问。");
    const normalized = core.normalizeVaultPath(raw);
    if (normalized.startsWith("山竹视频资产库/")) return referenceAssets.checkedAssetPath(this.vaultPath(), normalized);
    if (normalized === ROOT) return this.checkedWorkbenchProjectFolder(ROOT).realFolder;
    if (normalized.startsWith(`${ROOT}/`)) {
      const projectName = normalized.slice(ROOT.length + 1).split("/")[0];
      return this.checkedProjectPath(`${ROOT}/${projectName}`, normalized, options);
    }
    return path.join(this.vaultPath(), ...normalized.split("/"));
  }

  ensureReplicaRoot() {
    const vaultRoot = path.resolve(this.vaultPath());
    if (!fs.statSync(vaultRoot, { throwIfNoEntry: false })?.isDirectory()) throw new Error("无法定位当前 Obsidian 知识库。");
    const rootPath = path.join(vaultRoot, ROOT);
    let rootStat = fs.lstatSync(rootPath, { throwIfNoEntry: false });
    if (!rootStat) {
      fs.mkdirSync(rootPath);
      rootStat = fs.lstatSync(rootPath, { throwIfNoEntry: false });
    }
    if (rootStat?.isSymbolicLink() || !rootStat?.isDirectory()) throw new Error(`项目根目录 ${ROOT} 不能是符号链接，已拒绝访问。`);
    const realVault = fs.realpathSync(vaultRoot);
    const realRoot = fs.realpathSync(rootPath);
    if (!isInsidePath(realVault, realRoot)) throw new Error(`项目根目录 ${ROOT} 超出知识库范围，已拒绝访问。`);
    return realRoot;
  }

  async prepareVideo(sourcePath) {
    this.ensureReplicaRoot();
    const project = await workflow.prepareProject({ sourcePath, vaultPath: this.vaultPath(), pluginRoot: this.pluginRoot });
    this.checkedWorkbenchProjectFolder(project.folder);
    return project;
  }

  openPrepareModal() { return new PrepareModal(this).open(); }

  openAnalysisModelModal() { return new AnalysisModelModal(this).open(); }

  openGenerationModelModal() { return new GenerationModelModal(this).open(); }

  async activateWorkbench() {
    const existing = this.app.workspace.getLeavesOfType(this.workbenchViewType)[0];
    const leaf = existing || this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type: this.workbenchViewType, active: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  isWorkbenchDataFile(file) {
    const vaultPath = String(file?.path || "").replace(/\\/g, "/");
    return vaultPath.startsWith(`${ROOT}/`)
      && ["project.json", REQUEST_FILE, path.basename(STATE_FILE), path.basename(QUEUE_FILE)].includes(String(file?.name || path.basename(vaultPath)));
  }

  requestWorkbenchRefresh() {
    if (!this.workbenchViewType || typeof this.app.workspace?.getLeavesOfType !== "function") return;
    for (const leaf of this.app.workspace.getLeavesOfType(this.workbenchViewType)) {
      if (typeof leaf?.view?.requestRefresh === "function") void leaf.view.requestRefresh();
      else if (typeof leaf?.view?.refresh === "function") void leaf.view.refresh();
    }
  }

  checkedWorkbenchProjectFolder(folder) {
    const rawFolder = String(folder ?? "").trim().replace(/\\/g, "/");
    if (path.posix.isAbsolute(rawFolder) || /^[A-Za-z]:\//.test(rawFolder)) {
      throw new Error("项目路径不能使用绝对路径。");
    }
    const normalized = core.normalizeVaultPath(rawFolder);
    if (normalized !== ROOT && !normalized.startsWith(`${ROOT}/`)) throw new Error(`项目必须位于 ${ROOT}/ 下。`);

    const vaultRoot = path.resolve(this.vaultPath());
    const absoluteRoot = path.resolve(vaultRoot, ROOT);
    const absoluteFolder = path.resolve(vaultRoot, ...normalized.split("/"));
    if (!isInsidePath(absoluteRoot, absoluteFolder)) throw new Error("项目路径不安全，已拒绝访问山竹视频复刻范围外的文件。");

    const vaultStat = fs.statSync(vaultRoot, { throwIfNoEntry: false });
    const rootStat = fs.lstatSync(absoluteRoot, { throwIfNoEntry: false });
    if (rootStat?.isSymbolicLink()) throw new Error(`项目根目录 ${ROOT} 不能是符号链接，已拒绝访问。`);
    let walked = absoluteRoot;
    for (const segment of normalized.split("/").slice(1)) {
      walked = path.join(walked, segment);
      const walkedStat = fs.lstatSync(walked, { throwIfNoEntry: false });
      if (walkedStat?.isSymbolicLink()) throw new Error("项目路径包含符号链接，已拒绝访问。");
      if (walkedStat && !walkedStat.isDirectory()) throw new Error("项目路径不是有效目录，已拒绝访问。");
    }
    const folderStat = fs.lstatSync(absoluteFolder, { throwIfNoEntry: false });
    if (!vaultStat?.isDirectory() || !rootStat?.isDirectory() || !folderStat?.isDirectory()) {
      throw new Error("项目路径无法定位真实的山竹视频复刻目录。");
    }

    let realVault;
    let realRoot;
    let realFolder;
    try {
      realVault = fs.realpathSync(vaultRoot);
      realRoot = fs.realpathSync(absoluteRoot);
      realFolder = fs.realpathSync(absoluteFolder);
    } catch (_) {
      throw new Error("项目路径包含无法解析的符号链接，已拒绝访问。");
    }
    if (!isInsidePath(realVault, realRoot) || !isInsidePath(realRoot, realFolder)) {
      throw new Error("项目路径通过符号链接超出山竹视频复刻范围，已拒绝访问。");
    }
    return { folder: normalized, absoluteFolder, realFolder };
  }

  checkedProjectPath(folder, childPath = "", { createParents = false, directory = false } = {}) {
    const checked = this.checkedWorkbenchProjectFolder(folder);
    if (checked.folder === ROOT && childPath) throw new Error(`请选择 ${ROOT}/ 下的具体项目。`);
    const raw = String(childPath ?? "").trim().replace(/\\/g, "/");
    if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
      throw new Error("项目文件不能使用绝对路径，已拒绝访问。");
    }
    let relative = raw;
    if (raw === checked.folder) relative = "";
    else if (raw.startsWith(`${checked.folder}/`)) relative = raw.slice(checked.folder.length + 1);
    else if (raw === ROOT || raw.startsWith(`${ROOT}/`)) throw new Error("项目文件超出当前项目范围，已拒绝访问。");
    const segments = relative ? relative.split("/") : [];
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("项目文件路径不安全，已拒绝访问。");
    }

    let current = checked.realFolder;
    for (let index = 0; index < segments.length; index += 1) {
      const isLast = index === segments.length - 1;
      const candidate = path.join(current, segments[index]);
      let stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat && createParents && (!isLast || directory)) {
        try { fs.mkdirSync(candidate); } catch (error) { if (error?.code !== "EEXIST") throw error; }
        stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      }
      if (!stat) {
        const target = path.join(current, ...segments.slice(index));
        if (!isInsidePath(checked.realFolder, target)) throw new Error("项目文件超出当前项目范围，已拒绝访问。");
        return target;
      }
      if (stat.isSymbolicLink()) throw new Error("项目文件路径包含符号链接，已拒绝访问。");
      if ((!isLast || directory) && !stat.isDirectory()) throw new Error("项目文件的父路径不是目录，已拒绝访问。");
      let realCandidate;
      try { realCandidate = fs.realpathSync(candidate); } catch (_) { throw new Error("项目文件路径无法解析，已拒绝访问。"); }
      if (!isInsidePath(checked.realFolder, realCandidate)) throw new Error("项目文件超出当前项目范围，已拒绝访问。");
      current = realCandidate;
    }
    return current;
  }

  checkedWorkbenchWorkDirectory(folder, { create = false } = {}) {
    const checked = this.checkedWorkbenchProjectFolder(folder);
    const workDirectory = this.checkedProjectPath(checked.folder, ".work", { createParents: create, directory: true });
    return { ...checked, workDirectory };
  }

  workbenchProjectPaths(folder, { createWorkDirectory = false } = {}) {
    const checked = this.checkedWorkbenchProjectFolder(folder);
    if (checked.folder === ROOT) throw new Error(`请选择 ${ROOT}/ 下的具体项目。`);
    const versionSix = projectStorage.projectRelativePaths(checked.folder);
    const versionSixProjectPath = this.checkedProjectPath(checked.folder, versionSix.project);
    const isV6 = fs.existsSync(versionSixProjectPath);
    const queueLockRelativePath = isV6 ? `${versionSix.metadataRoot}/active-run.lock` : QUEUE_LOCK_FILE;
    const submissionGateRelativePath = `${versionSix.metadataRoot}/paid-submission.lock`;
    const pendingStopRelativePath = `${versionSix.metadataRoot}/pending-stop.json`;
    return {
      folder: checked.folder,
      isV6,
      projectPath: isV6 ? versionSixProjectPath : this.checkedProjectPath(checked.folder, "project.json"),
      requestPath: isV6
        ? this.checkedProjectPath(checked.folder, versionSix.draft)
        : this.checkedProjectPath(checked.folder, REQUEST_FILE),
      statePath: this.checkedProjectPath(checked.folder, STATE_FILE),
      stopPath: this.checkedProjectPath(checked.folder, STOP_FILE, { createParents: createWorkDirectory && !isV6 }),
      queuePath: this.checkedProjectPath(checked.folder, QUEUE_FILE),
      activeRunPath: this.checkedProjectPath(checked.folder, versionSix.activeRun, { createParents: createWorkDirectory && isV6 }),
      activeRunRelativePath: versionSix.activeRun,
      runsRelativePath: versionSix.runs,
      queueLockPath: this.checkedProjectPath(checked.folder, queueLockRelativePath, { createParents: createWorkDirectory }),
      submissionGatePath: isV6
        ? this.checkedProjectPath(checked.folder, submissionGateRelativePath, { createParents: createWorkDirectory })
        : null,
      pendingStopPath: isV6
        ? this.checkedProjectPath(checked.folder, pendingStopRelativePath, { createParents: createWorkDirectory })
        : null,
      pendingStopRelativePath,
    };
  }

  projectStorageResolver(folder) {
    return (relativePath, options = {}) => this.checkedProjectPath(folder, relativePath, options);
  }

  replicaOutputTarget(projectFolder, shotId, assetType, destinationPath) {
    const artifacts = projectStorage.shotArtifactPaths(projectFolder, shotId);
    return {
      owner: "video-replica",
      projectId: path.posix.basename(projectFolder),
      shotId: path.posix.basename(artifacts.folder),
      assetType,
      destinationPath,
      overwrite: "replace-current",
    };
  }

  assertDurableProjectArtifact(projectFolder, vaultPath) {
    const absolutePath = this.checkedProjectPath(projectFolder, vaultPath);
    const stat = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`目标文件尚未安全保存：${vaultPath}`);
    }
    return vaultPath;
  }

  projectShotArtifactState(shot = {}) {
    return {
      generationFingerprint: String(shot.generationFingerprint || ""),
      firstImagePath: String(shot.firstImagePath || ""),
      imagePath: String(shot.imagePath || shot.firstImagePath || ""),
      lastImagePath: String(shot.lastImagePath || ""),
      videoPath: String(shot.videoPath || ""),
    };
  }

  currentProjectShotArtifactState(projectFolder, shotId) {
    const paths = this.workbenchProjectPaths(projectFolder);
    const project = this.readJson(paths.projectPath);
    const shot = (project.shots || []).find((item) => String(item.id) === String(shotId));
    return this.projectShotArtifactState(shot);
  }

  shotArtifactProjectFolder(vaultPath) {
    const marker = "/03-分镜/";
    const markerIndex = String(vaultPath || "").indexOf(marker);
    const projectFolder = markerIndex > 0 ? String(vaultPath).slice(0, markerIndex) : "";
    if (!projectFolder.startsWith(`${ROOT}/`)) throw new Error("镜头目标路径不属于视频复刻项目。");
    return projectFolder;
  }

  async withArchivedProjectArtifact({ projectFolder, shotId, kind, enabled, restoreState = null }, operation) {
    if (typeof operation !== "function") throw new Error("缺少镜头文件替换操作。");
    if (!enabled) return operation();
    const archivedPath = projectStorage.archiveCurrentArtifact({
      resolveSafe: this.projectStorageResolver(projectFolder),
      projectFolder,
      shotId,
      kind,
    });
    try {
      return await operation();
    } catch (error) {
      const currentPath = projectStorage.shotArtifactPaths(projectFolder, shotId)[kind === "first-frame" ? "firstFrame" : kind === "last-frame" ? "lastFrame" : "video"];
      if (archivedPath) {
        let failedArtifactPath = null;
        let oldArtifactRestored = false;
        try {
          if (fs.lstatSync(this.checkedProjectPath(projectFolder, currentPath), { throwIfNoEntry: false })) {
            failedArtifactPath = projectStorage.archiveFailedArtifact({
              resolveSafe: this.projectStorageResolver(projectFolder),
              projectFolder,
              shotId,
              kind,
            });
          }
          projectStorage.restoreArchivedArtifact({
            resolveSafe: this.projectStorageResolver(projectFolder),
            projectFolder,
            shotId,
            kind,
            archivedPath,
          });
          oldArtifactRestored = true;
          if (typeof restoreState === "function") await restoreState();
          if (failedArtifactPath) error.failedArtifactPath = failedArtifactPath;
          error.restoredArtifactPath = currentPath;
        } catch (rollbackError) {
          const retainedFailedPath = failedArtifactPath || rollbackError?.failedArtifactPath || currentPath;
          const retainedOldPath = oldArtifactRestored ? currentPath : archivedPath;
          const compound = new Error(
            `原操作失败：${String(error?.message || error)}；产物回滚失败：${String(rollbackError?.message || rollbackError)}。`
            + `旧产物保留于 ${retainedOldPath}；失败的新产物保留于 ${retainedFailedPath}。`,
          );
          compound.cause = error;
          compound.originalError = error;
          compound.rollbackError = rollbackError;
          compound.archivedArtifactPath = oldArtifactRestored ? null : archivedPath;
          compound.restoredArtifactPath = oldArtifactRestored ? currentPath : null;
          compound.failedArtifactPath = retainedFailedPath;
          throw compound;
        }
      }
      throw error;
    }
  }

  readOptionalJson(filePath, readErrors = null, key = "") {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try { return this.readJson(filePath); }
    catch (error) {
      if (readErrors && key) readErrors[key] = String(error?.message || error);
      return null;
    }
  }

  currentRunInputs(paths, requestMtimeMs = null, readErrors = null) {
    return {
      activeRun: this.readOptionalJson(paths.activeRunPath, readErrors, "activeRun"),
      legacyQueue: paths.isV6 ? null : this.readOptionalJson(paths.queuePath, readErrors, "generationQueue"),
      legacyState: paths.isV6 ? null : this.readOptionalJson(paths.statePath, readErrors, "generationState"),
      requestMtimeMs,
    };
  }

  currentRunQueueView(currentRun) {
    if (!currentRun || !Array.isArray(currentRun.queue) || !currentRun.shots || Array.isArray(currentRun.shots)) return {};
    const status = currentRun.status === "queued" ? "idle"
      : currentRun.status === "stopping" ? "processing"
      : currentRun.status === "partial-failure" ? "completed_with_errors"
        : currentRun.status;
    return {
      ...JSON.parse(JSON.stringify(currentRun)),
      status,
      shots: currentRun.queue.map((id) => {
        const shot = currentRun.shots[id] || {};
        const shotStatus = ["queued", "completed", "failed", "stopped"].includes(String(shot.status))
          ? shot.status
          : "processing";
        return {
          ...(shot.confirmedPayload || {}),
          ...shot,
          status: shotStatus,
          error: typeof shot.error === "object" && shot.error ? shot.error.message : shot.error || "",
        };
      }),
    };
  }

  currentRunStateView(currentRun) {
    return currentRun?.compatibilitySource === "legacy-state" && currentRun.legacyState
      ? JSON.parse(JSON.stringify(currentRun.legacyState))
      : {};
  }

  listWorkbenchProjects() {
    return this.projectRecords().map(({ project, mtimeMs }) => ({
      folder: project.folder,
      title: project.title || path.basename(project.folder || ""),
      status: project.status || "unknown",
      mtimeMs,
    }));
  }

  loadWorkbenchProject(folder) {
    const paths = this.workbenchProjectPaths(folder);
    const output = {
      project: {}, request: {}, requestMtimeMs: null, currentRun: null,
      generationState: {}, generationQueue: {}, readErrors: {},
    };
    for (const [key, filePath] of [
      ["project", paths.projectPath],
      ["request", paths.requestPath],
    ]) {
      try {
        output[key] = this.readJson(filePath);
        if (key === "request") {
          output[key] = withWorkbenchShotIds(output[key]);
          output.requestMtimeMs = fs.statSync(filePath).mtimeMs;
        }
      } catch (error) {
        output.readErrors[key] = String(error?.message || error);
      }
    }
    output.currentRun = runState.selectCurrentRun(this.currentRunInputs(paths, output.requestMtimeMs, output.readErrors));
    output.generationQueue = this.currentRunQueueView(output.currentRun);
    output.generationState = this.currentRunStateView(output.currentRun);
    return output;
  }

  currentWorkbenchQueue(folder) {
    const paths = this.workbenchProjectPaths(folder);
    try {
      const requestMtimeMs = fs.statSync(paths.requestPath, { throwIfNoEntry: false })?.mtimeMs ?? null;
      return runState.selectCurrentRun(this.currentRunInputs(paths, requestMtimeMs));
    } catch (_) {
      return null;
    }
  }

  persistWorkbenchRun(paths, queue) {
    if (!paths.isV6) {
      writeJson(paths.queuePath, queue);
      return paths.queuePath;
    }
    const existing = this.readOptionalJson(paths.activeRunPath);
    if (existing?.runId && existing.runId !== queue.runId) {
      throw new Error("上一次活动运行尚未归档，已拒绝覆盖恢复信息。");
    }
    const persisted = existing?.runId
      ? runState.mergeRunState(existing, queue)
      : { ...JSON.parse(JSON.stringify(queue)), revision: Math.max(0, Number(queue.revision) || 0) + 1 };
    projectStorage.atomicWriteJson({
      resolveSafe: this.projectStorageResolver(paths.folder),
      relativePath: paths.activeRunRelativePath,
      value: persisted,
    });
    replaceObject(queue, persisted);
    return paths.activeRunPath;
  }

  archiveWorkbenchRun(paths, queue, now = new Date().toISOString()) {
    if (!paths.isV6) return null;
    const archived = runState.archiveRun(queue, queue.archivedAt || queue.completedAt || now);
    const runId = String(archived.runId || "");
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("运行 ID 不安全，无法归档。");
    const relativePath = `${paths.runsRelativePath}/${runId}.json`;
    const absolutePath = this.checkedProjectPath(paths.folder, relativePath, { createParents: true });
    if (fs.existsSync(absolutePath)) {
      const existing = this.readJson(absolutePath);
      if (JSON.stringify(existing) !== JSON.stringify(archived)) {
        throw new Error("运行归档已存在且内容不同，已保留 active-run.json。");
      }
    } else {
      projectStorage.atomicWriteJson({
        resolveSafe: this.projectStorageResolver(paths.folder),
        relativePath,
        value: archived,
      });
    }
    fs.rmSync(paths.activeRunPath);
    return relativePath;
  }

  workbenchQueueApi(folder, activeQueueOverride = null) {
    const paths = this.workbenchProjectPaths(folder, { createWorkDirectory: true });
    const existing = this.queueApis.get(paths.folder);
    if (existing) return existing;
    const activeQueue = activeQueueOverride || this.currentWorkbenchQueue(paths.folder);
    const activeQueues = runState.isRunActive(activeQueue)
      ? [activeQueue]
      : [];
    if (activeQueues.length) this.activeQueueObjects.set(paths.folder, activeQueue);
    const api = replicaLogicApi.createReplicaLogicApi({
      activeQueues,
      saveQueue: async (queue, saveOptions = {}) => {
        const persistQueue = async () => {
          const queueId = String(queue?.queueId || "");
          if (this.queueRunnerLockRequired.has(queueId)) {
            const runnerLock = this.queueRunnerLocks.get(queueId);
            if (!runnerLock) throw new Error("生成队列运行锁已丢失，已停止后续付费任务。");
            this.assertWorkbenchQueueLockOwned(runnerLock);
          }
          const persisted = this.currentWorkbenchQueue(paths.folder);
          if (persisted?.queueId === queue.queueId && persisted.stopRequested === true) {
            replaceObject(queue, runState.requestRunStop(queue));
          }
          const liveQueue = this.activeQueueObjects.get(paths.folder);
          if (liveQueue?.queueId === queue.queueId) {
            if (liveQueue.stopRequested === true && queue.stopRequested !== true) replaceObject(queue, runState.requestRunStop(queue));
            if (queue.stopRequested === true && liveQueue.stopRequested !== true) replaceObject(liveQueue, runState.requestRunStop(liveQueue));
          }
          this.persistWorkbenchRun(paths, queue);
          if (api.lockedShotIds(queue).length && liveQueue?.queueId !== queue.queueId) this.activeQueueObjects.set(paths.folder, queue);
          else if (!api.lockedShotIds(queue).length && liveQueue?.queueId === queue.queueId) this.activeQueueObjects.delete(paths.folder);
          this.requestWorkbenchRefresh();
          return JSON.parse(JSON.stringify(queue));
        };
        return paths.isV6 && saveOptions.submissionGateHeld !== true
          ? this.withWorkbenchSubmissionGate(paths.folder, persistQueue)
          : persistQueue();
      },
      saveStop: async (queue) => {
        const persistStop = async () => {
          const persisted = this.currentWorkbenchQueue(paths.folder);
          if (!persisted && paths.isV6) {
            const runId = String(queue.runId || queue.queueId || "");
            const archivedPath = /^[A-Za-z0-9_-]+$/.test(runId)
              ? this.checkedProjectPath(paths.folder, `${paths.runsRelativePath}/${runId}.json`)
              : "";
            const archived = archivedPath ? this.readOptionalJson(archivedPath) : null;
            if (archived && String(archived.runId || archived.queueId || "") === runId && archived.stopRequested === true) {
              replaceObject(queue, archived);
              return queue;
            }
          }
          if (!persisted || persisted.queueId !== queue.queueId) {
            throw new Error("活动运行已变化，已拒绝用旧窗口状态覆盖当前任务。");
          }
          const stopped = runState.requestRunStop(persisted);
          this.persistWorkbenchRun(paths, stopped);
          replaceObject(queue, stopped);
          this.activeQueueObjects.set(paths.folder, queue);
          this.requestWorkbenchRefresh();
          return queue;
        };
        if (!paths.isV6) return persistStop();
        this.recordPendingWorkbenchStop(paths, queue);
        return this.withWorkbenchSubmissionGate(paths.folder, persistStop);
      },
      isStopRequested: async ({ queueId, runId }) => {
        const expectedId = String(runId || queueId || "");
        const pending = paths.isV6 ? this.readOptionalJson(paths.pendingStopPath) : null;
        if (pending && String(pending.runId || pending.queueId || "") === expectedId) return true;
        const persisted = this.currentWorkbenchQueue(paths.folder);
        if (!persisted) throw new Error("活动运行状态缺失，已停止后续付费任务。");
        if (String(persisted.queueId || persisted.runId || "") !== expectedId) {
          throw new Error("活动运行已变化，已停止后续付费任务。");
        }
        return persisted.stopRequested === true;
      },
      withPaidSubmissionGate: async (identity, operation) => this.withWorkbenchPaidSubmissionGate(paths.folder, identity, operation),
      runShot: async (shot, context) => this.runWorkbenchQueueShot(paths.folder, shot, context),
    });
    this.queueApis.set(paths.folder, api);
    return api;
  }

  async acquireWorkbenchSubmissionGate(folder, {
    timeoutMs,
    staleMs,
    retryMs,
  } = {}) {
    const paths = this.workbenchProjectPaths(folder, { createWorkDirectory: true });
    if (!paths.isV6 || !paths.submissionGatePath) return null;
    const token = `${this.instanceId || "instance"}:${crypto.randomUUID()}`;
    const payload = {
      token,
      pid: process.pid,
      instanceId: this.instanceId || "instance",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    const create = () => {
      const descriptor = fs.openSync(paths.submissionGatePath, "wx");
      try { fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`); }
      finally { fs.closeSync(descriptor); }
    };
    const effectiveTimeoutMs = timeoutMs ?? this.submissionGateTimeoutMs ?? SUBMISSION_GATE_TIMEOUT_MS;
    const effectiveStaleMs = staleMs ?? this.submissionGateStaleMs ?? SUBMISSION_GATE_STALE_MS;
    const effectiveRetryMs = retryMs ?? this.submissionGateRetryMs ?? SUBMISSION_GATE_RETRY_MS;
    const deadline = Date.now() + Math.max(0, Number(effectiveTimeoutMs) || 0);
    while (true) {
      try {
        create();
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stat = fs.statSync(paths.submissionGatePath, { throwIfNoEntry: false });
        if (!stat) continue;
        if (Date.now() - stat.mtimeMs > Math.max(1, Number(effectiveStaleMs) || SUBMISSION_GATE_STALE_MS)) {
          fs.rmSync(paths.submissionGatePath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          const timeout = new Error("付费提交闸门等待超时，已停止本次操作以避免重复付费。");
          timeout.code = "SUBMISSION_GATE_TIMEOUT";
          throw timeout;
        }
        await sleep(Math.max(1, Math.min(Number(effectiveRetryMs) || SUBMISSION_GATE_RETRY_MS, deadline - Date.now())));
      }
    }
    const lock = { folder: paths.folder, lockPath: paths.submissionGatePath, token, payload, heartbeat: null, lostError: null };
    lock.heartbeat = setInterval(() => {
      try { this.assertWorkbenchSubmissionGateOwned(lock); }
      catch (error) { lock.lostError = error instanceof Error ? error : new Error(String(error)); }
    }, 15000);
    lock.heartbeat.unref?.();
    return lock;
  }

  assertWorkbenchSubmissionGateOwned(lock) {
    if (!lock?.lockPath || !lock?.token) throw new Error("付费提交闸门无效，已停止后续付费任务。");
    if (lock.lostError) throw lock.lostError;
    let current;
    try { current = this.readJson(lock.lockPath); }
    catch (_) { throw new Error("付费提交闸门已丢失，已停止后续付费任务。"); }
    if (current?.token !== lock.token) throw new Error("付费提交闸门已被其他窗口接管，已停止后续付费任务。");
    const refreshed = { ...current, token: lock.token, heartbeatAt: new Date().toISOString() };
    fs.writeFileSync(lock.lockPath, `${JSON.stringify(refreshed)}\n`);
    lock.payload = refreshed;
    return true;
  }

  releaseWorkbenchSubmissionGate(lock) {
    if (!lock) return;
    if (lock.heartbeat) clearInterval(lock.heartbeat);
    try {
      const current = this.readJson(lock.lockPath);
      if (current?.token === lock.token) fs.rmSync(lock.lockPath, { force: true });
    } catch (_) { /* another process owns or already released this gate */ }
  }

  recordPendingWorkbenchStop(pathsOrFolder, identity = {}) {
    const paths = typeof pathsOrFolder === "string"
      ? this.workbenchProjectPaths(pathsOrFolder, { createWorkDirectory: true })
      : pathsOrFolder;
    if (!paths?.isV6 || !paths.pendingStopPath) return null;
    const runId = String(identity?.runId || identity?.queueId || "").trim();
    if (!runId) throw new Error("停止请求缺少活动运行 ID。");
    const pending = {
      version: 1,
      runId,
      queueId: runId,
      requestId: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      status: "pending",
    };
    projectStorage.atomicWriteJson({
      resolveSafe: this.projectStorageResolver(paths.folder),
      relativePath: paths.pendingStopRelativePath,
      value: pending,
    });
    return pending;
  }

  mergePendingWorkbenchStop(pathsOrFolder) {
    const paths = typeof pathsOrFolder === "string"
      ? this.workbenchProjectPaths(pathsOrFolder, { createWorkDirectory: true })
      : pathsOrFolder;
    if (!paths?.isV6 || !paths.pendingStopPath) return null;
    const pending = this.readOptionalJson(paths.pendingStopPath);
    if (!pending) return null;
    const active = this.readOptionalJson(paths.activeRunPath);
    const pendingId = String(pending.runId || pending.queueId || "");
    const activeId = String(active?.runId || active?.queueId || "");
    if (!active || !pendingId || activeId !== pendingId) return active;
    const stopped = runState.requestRunStop(active, pending.requestedAt);
    this.persistWorkbenchRun(paths, stopped);
    const currentPending = this.readOptionalJson(paths.pendingStopPath);
    if (currentPending && String(currentPending.runId || currentPending.queueId || "") === activeId) {
      fs.rmSync(paths.pendingStopPath, { force: true });
    }
    return stopped;
  }

  async withWorkbenchSubmissionGate(folder, operation) {
    if (typeof operation !== "function") throw new Error("付费提交闸门缺少操作函数。");
    const lock = await this.acquireWorkbenchSubmissionGate(folder);
    if (!lock) return operation();
    try {
      this.assertWorkbenchSubmissionGateOwned(lock);
      this.mergePendingWorkbenchStop(folder);
      const result = await operation();
      this.assertWorkbenchSubmissionGateOwned(lock);
      return result;
    } finally {
      try {
        this.assertWorkbenchSubmissionGateOwned(lock);
        this.mergePendingWorkbenchStop(folder);
      } finally {
        this.releaseWorkbenchSubmissionGate(lock);
      }
    }
  }

  async withWorkbenchPaidSubmissionGate(folder, identity, operation) {
    if (typeof operation !== "function") throw new Error("缺少付费提交操作。");
    const paths = this.workbenchProjectPaths(folder, { createWorkDirectory: true });
    const submit = async () => {
      const persisted = this.currentWorkbenchQueue(paths.folder);
      if (!persisted) throw new Error("活动运行状态缺失，已停止后续付费任务。");
      const persistedId = String(persisted.runId || persisted.queueId || "");
      const expectedId = String(identity?.runId || identity?.queueId || "");
      if (!expectedId || persistedId !== expectedId) throw new Error("活动运行已变化，已停止后续付费任务。");
      if (persisted.stopRequested === true) {
        const stopped = new Error("用户已停止生成；不会再提交新的付费任务。");
        stopped.code = GENERATION_STOPPED_CODE;
        throw stopped;
      }
      if (paths.isV6 && Number(persisted.revision) !== Number(identity?.revision)) {
        throw new Error("活动运行版本已变化，已停止本次付费提交。");
      }
      if (!paths.isV6) return operation(persisted, null);
      const shotId = String(identity?.shotId || "").trim();
      const boundary = String(identity?.boundary || "paid-submission").trim() || "paid-submission";
      const shot = persisted.shots?.[shotId];
      if (!shot) throw new Error("活动运行找不到待提交镜头，已停止本次付费提交。");
      if (shot.submissionReservation?.status === "submission-reserved") {
        const unsafe = new Error("UNSAFE_PAID_SUBMISSION_RECOVERY：检测到未决付费提交，请人工检查供应商记录；不再自动重提。");
        unsafe.code = "UNSAFE_PAID_SUBMISSION_RECOVERY";
        const recovery = runState.updateShotState(persisted, shotId, {
          status: "recovery-pending",
          stage: shot.submissionReservation.boundary || boundary,
          submissionUncertain: true,
          error: unsafe,
        });
        this.persistWorkbenchRun(paths, recovery);
        throw unsafe;
      }
      const reservation = {
        runId: persistedId,
        shotId,
        boundary,
        reservationId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        status: "submission-reserved",
        previousStatus: String(shot.status || "processing"),
        previousStage: String(shot.stage || "preflight"),
      };
      const reserved = runState.updateShotState(persisted, shotId, {
        status: "submission-reserved",
        stage: boundary,
        submissionReservation: reservation,
        submissionUncertain: true,
      });
      this.persistWorkbenchRun(paths, reserved);
      const result = await operation(reserved, reservation);
      const resolved = this.currentWorkbenchQueue(paths.folder);
      const resolvedShot = resolved?.shots?.[shotId];
      if (resolvedShot?.submissionReservation?.reservationId === reservation.reservationId
        || resolvedShot?.lastSubmissionResult?.reservationId !== reservation.reservationId
        || resolvedShot?.lastSubmissionResult?.status !== "resolved") {
        const unsafe = new Error("UNSAFE_PAID_SUBMISSION_RECOVERY：付费提交结果未安全落盘，请人工检查供应商记录；不再自动重提。");
        unsafe.code = "UNSAFE_PAID_SUBMISSION_RECOVERY";
        throw unsafe;
      }
      return result;
    };
    return paths.isV6 ? this.withWorkbenchSubmissionGate(paths.folder, submit) : submit();
  }

  acquireWorkbenchQueueLock(folder) {
    const { queueLockPath } = this.workbenchProjectPaths(folder, { createWorkDirectory: true });
    const token = `${this.instanceId || "instance"}:${crypto.randomUUID()}`;
    const payload = {
      token,
      pid: process.pid,
      instanceId: this.instanceId || "instance",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    const create = () => {
      const descriptor = fs.openSync(queueLockPath, "wx");
      try { fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`); }
      finally { fs.closeSync(descriptor); }
    };
    try {
      create();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ageMs = Date.now() - Number(fs.statSync(queueLockPath, { throwIfNoEntry: false })?.mtimeMs || Date.now());
      if (ageMs > 5 * 60 * 1000) {
        fs.rmSync(queueLockPath, { force: true });
        create();
      } else {
        throw new Error("当前项目正在创建生成队列，请勿重复操作。");
      }
    }
    const lock = { folder: this.workbenchProjectPaths(folder).folder, queueLockPath, token, payload, heartbeat: null, lostError: null };
    lock.heartbeat = setInterval(() => {
      try { this.assertWorkbenchQueueLockOwned(lock); }
      catch (error) { lock.lostError = error instanceof Error ? error : new Error(String(error)); }
    }, 15000);
    lock.heartbeat.unref?.();
    return lock;
  }

  assertWorkbenchQueueLockOwned(lock) {
    if (!lock?.queueLockPath || !lock?.token) throw new Error("生成队列锁无效，请重新操作。");
    if (lock.lostError) throw lock.lostError;
    let current;
    try { current = this.readJson(lock.queueLockPath); }
    catch (_) { throw new Error("生成队列锁已丢失，请重新选择镜头生成。"); }
    if (current?.token !== lock.token) throw new Error("生成队列锁已被其他实例接管，本次操作已取消以避免重复付费。");
    const refreshed = {
      ...current,
      token: lock.token,
      pid: Number(current.pid || lock.payload?.pid || process.pid),
      instanceId: String(current.instanceId || lock.payload?.instanceId || this.instanceId || "instance"),
      heartbeatAt: new Date().toISOString(),
    };
    fs.writeFileSync(lock.queueLockPath, `${JSON.stringify(refreshed)}\n`);
    lock.payload = refreshed;
    return true;
  }

  assertWorkbenchQueueRunnerLock(folder, queueId) {
    const normalized = this.workbenchProjectPaths(folder).folder;
    const normalizedQueueId = String(queueId || "");
    if (!this.queueRunnerLockRequired.has(normalizedQueueId)) return true;
    const lock = this.queueRunnerLocks.get(normalizedQueueId);
    if (!lock || lock.folder !== normalized) throw new Error("生成队列运行锁已丢失，已停止后续付费任务。");
    return this.assertWorkbenchQueueLockOwned(lock);
  }

  releaseWorkbenchQueueLock(lock) {
    if (lock?.heartbeat) clearInterval(lock.heartbeat);
    if (lock?.queueId && this.queueRunnerLocks.get(lock.queueId) === lock) {
      this.queueRunnerLocks.delete(lock.queueId);
      this.queueRunnerLockRequired.delete(lock.queueId);
    }
    if (!lock?.queueLockPath || !lock?.token) return;
    try {
      const payload = this.readJson(lock.queueLockPath);
      if (payload.token === lock.token) fs.rmSync(lock.queueLockPath, { force: true });
    } catch (_) { /* another process owns or already released this lock */ }
  }

  async validatedProjectGenerationModels(request) {
    const catalog = await this.refreshGenerationModelCatalog();
    const exact = (models, requested) => models.find((model) => model === requested)
      || models.find((model) => model.toLowerCase() === requested.toLowerCase());
    const requestedImageModel = String(request?.settings?.imageModel || "").trim();
    const requestedVideoModel = String(request?.settings?.videoModel || "").trim();
    const imageModel = exact(Array.isArray(catalog?.imageModels) ? catalog.imageModels : [], requestedImageModel);
    const videoModel = exact(Array.isArray(catalog?.videoModels) ? catalog.videoModels : [], requestedVideoModel);
    if (!imageModel) throw this.unavailableGenerationModel("image", requestedImageModel, catalog?.imageModels || []);
    if (!videoModel) throw this.unavailableGenerationModel("video", requestedVideoModel, catalog?.videoModels || []);
    return { imageModel, videoModel };
  }

  async previewWorkbenchGeneration(folder, selectedShotIds) {
    const paths = this.workbenchProjectPaths(folder);
    const request = this.readJson(paths.requestPath);
    if (request.confirmed === true) throw new Error("这是旧版整项目任务，不能加入分镜队列。请重新分析或复制为新草案。");
    await this.validatedProjectGenerationModels(request);
    return this.workbenchQueueApi(paths.folder).preview(request, selectedShotIds);
  }

  async appendWorkbenchGeneration(paths, plan, persistedQueue) {
    const queueId = String(persistedQueue?.queueId || "");
    const queue = this.activeQueueObjects.get(paths.folder);
    const lock = this.queueRunnerLocks.get(queueId);
    if (!queue || queue.queueId !== queueId || !lock || !this.queueRunnerLockRequired.has(queueId)) {
      throw new Error("当前生成队列由另一个 Obsidian 窗口运行，请在原窗口追加镜头。");
    }
    this.assertWorkbenchQueueLockOwned(lock);
    const request = this.readJson(paths.requestPath);
    if (request.confirmed === true) throw new Error("不能使用旧版 confirmed=true 整项目任务追加分镜。");
    await this.validatedProjectGenerationModels(request);
    this.assertWorkbenchQueueLockOwned(lock);
    const latestQueue = this.currentWorkbenchQueue(paths.folder);
    if (latestQueue?.queueId !== queueId || !["queued", "processing"].includes(String(latestQueue.status))) {
      throw new Error("当前生成队列状态已变化，请刷新后重新选择镜头。");
    }
    const api = this.workbenchQueueApi(paths.folder);
    const confirmedPlan = api.confirm(plan, this.readJson(paths.requestPath));
    const appended = await api.append(queue, confirmedPlan);
    this.requestWorkbenchRefresh();
    return JSON.parse(JSON.stringify(appended));
  }

  async startWorkbenchGeneration(folder, plan) {
    const paths = this.workbenchProjectPaths(folder, { createWorkDirectory: true });
    const activeQueue = this.currentWorkbenchQueue(paths.folder);
    const api = this.workbenchQueueApi(paths.folder);
    if (activeQueue && api.lockedShotIds(activeQueue).length
      && ["queued", "processing"].includes(String(activeQueue.status))) {
      return this.appendWorkbenchGeneration(paths, plan, activeQueue);
    }
    const lock = this.acquireWorkbenchQueueLock(paths.folder);
    let lockTransferredToRun = false;
    try {
      const assertNoActiveQueue = () => {
        const activeQueue = this.currentWorkbenchQueue(paths.folder);
        if (activeQueue && api.lockedShotIds(activeQueue).length) {
          throw new Error("当前项目已有生成队列，请先停止或等待完成后再生成其他镜头。");
        }
      };
      assertNoActiveQueue();
      const request = this.readJson(paths.requestPath);
      if (request.confirmed === true) throw new Error("不能使用旧版 confirmed=true 整项目任务启动分镜队列。");
      await this.validatedProjectGenerationModels(request);
      assertNoActiveQueue();
      this.assertWorkbenchQueueLockOwned(lock);
      const confirmedPlan = api.confirm(plan, this.readJson(paths.requestPath));
      this.assertWorkbenchQueueLockOwned(lock);
      const queue = await api.enqueue(confirmedPlan);
      lock.queueId = String(queue.queueId);
      this.queueRunnerLockRequired.add(lock.queueId);
      this.queueRunnerLocks.set(lock.queueId, lock);
      this.activeQueueObjects.set(paths.folder, queue);
      const queuedSnapshot = JSON.parse(JSON.stringify(queue));
      const run = Promise.resolve()
        .then(() => queue.status === "stopped" ? queue : api.run(queue))
        .then(() => this.finishWorkbenchQueue(paths.folder, queue))
        .catch((error) => {
          new Notice(`分镜队列运行失败：${String(error?.message || error)}`, 10000);
          throw error;
        })
        .finally(() => this.releaseWorkbenchQueueLock(lock));
      lockTransferredToRun = true;
      this.queueRuns.set(paths.folder, run);
      run.catch(() => {});
      this.requestWorkbenchRefresh();
      return queuedSnapshot;
    } finally {
      if (!lockTransferredToRun) this.releaseWorkbenchQueueLock(lock);
    }
  }

  async finishWorkbenchQueue(folder, queue) {
    const paths = this.workbenchProjectPaths(folder);
    const { projectPath } = paths;
    const project = this.readJson(projectPath);
    const queueShots = (queue.queue || []).map((id) => queue.shots?.[id]).filter(Boolean);
    const failures = queueShots.filter((shot) => shot.status === "failed").length;
    const allVideosReady = Array.isArray(project.shots)
      && project.shots.length > 0
      && project.shots.every((shot) => String(shot.videoPath || "").trim());
    if (allVideosReady && queue.status === "completed") {
      await this.finalizeProject(folder, project, 0);
      this.archiveWorkbenchRun(paths, queue);
      if (this.activeQueueObjects.get(folder)?.queueId === queue.queueId) this.activeQueueObjects.delete(folder);
      return queue;
    }
    project.status = failures ? "completed_with_errors" : "analysis_ready";
    project.statusText = queue.status === "stopped"
      ? "生成队列已停止；已完成内容保留，可重新选择镜头。"
      : failures
        ? `本次队列完成，${failures} 个镜头失败，可修改后重试。`
        : "本次镜头已生成，可继续选择其他镜头。";
    this.saveProject(folder, project);
    this.archiveWorkbenchRun(paths, queue);
    if (this.activeQueueObjects.get(folder)?.queueId === queue.queueId) this.activeQueueObjects.delete(folder);
    return queue;
  }

  async recoverWorkbenchQueue(folder) {
    const paths = this.workbenchProjectPaths(folder, { createWorkDirectory: true });
    const candidate = this.currentWorkbenchQueue(paths.folder);
    if (candidate && paths.isV6 && !runState.isRunActive(candidate) && fs.existsSync(paths.activeRunPath)) {
      this.archiveWorkbenchRun(paths, candidate);
      if (this.activeQueueObjects.get(paths.folder)?.queueId === candidate.queueId) this.activeQueueObjects.delete(paths.folder);
      return false;
    }
    const candidateLocked = (candidate?.queue || []).some((id) => {
      const status = String(candidate?.shots?.[id]?.status || "");
      return !["completed", "failed", "stopped"].includes(status);
    });
    if (!candidateLocked || !["queued", "processing", "stopping"].includes(String(candidate?.status))) return false;

    let lock;
    try { lock = this.acquireWorkbenchQueueLock(paths.folder); }
    catch (error) {
      if (/正在创建生成队列|请勿重复操作/.test(String(error?.message || error))) return false;
      throw error;
    }
    let lockTransferredToRun = false;
    try {
      const queue = this.currentWorkbenchQueue(paths.folder);
      const locked = (queue?.queue || []).map((id) => queue?.shots?.[id]).filter((shot) => {
        const status = String(shot?.status || "");
        return shot && !["completed", "failed", "stopped"].includes(status);
      });
      if (!queue || !locked.length || !["queued", "processing", "stopping"].includes(String(queue.status))) return false;
      lock.queueId = String(queue.queueId);
      this.queueRunnerLockRequired.add(lock.queueId);
      this.queueRunnerLocks.set(lock.queueId, lock);

      if (["processing", "stopping"].includes(queue.status)) {
        const project = this.readJson(paths.projectPath);
        let unsafeRecovery = false;
        let unsafeSubmissionRecovery = false;
        for (const id of queue.queue) {
          const shot = queue.shots[id];
          if (!shot || ["queued", "completed", "failed", "stopped"].includes(String(shot.status))) continue;
          if (shot.submissionReservation?.status === "submission-reserved") {
            const unsafe = new Error("检测到未决付费提交。为避免重复付费，已停止自动恢复，请人工检查供应商记录。");
            unsafe.code = "UNSAFE_PAID_SUBMISSION_RECOVERY";
            shot.status = "recovery-pending";
            shot.stage = shot.submissionReservation.boundary || shot.stage || "provider-submission";
            shot.submissionUncertain = true;
            shot.error = runState.normalizeGenerationError(unsafe, {
              code: "UNSAFE_PAID_SUBMISSION_RECOVERY",
              stage: shot.stage,
              action: "人工检查供应商记录；确认未受理前不要重新提交",
              retryable: false,
              paidTaskSubmitted: shot.paidTaskSubmitted === true,
              now: new Date().toISOString(),
            });
            unsafeSubmissionRecovery = true;
            continue;
          }
          const projectShot = (project.shots || []).find((item) => String(item.id) === String(shot.id));
          const shotPlanId = String(shot.generationContext?.planId || queue.planId || "");
          const activeRunTaskId = shotPlanId && shot.confirmedPayloadSignature
            ? String(shot.taskId || "").trim()
            : "";
          const legacyTaskId = projectShot?.videoTaskId && projectShot.videoTaskPlanId === shotPlanId
            ? String(projectShot.videoTaskId)
            : "";
          const recoveryTaskId = activeRunTaskId || legacyTaskId;
          if (recoveryTaskId) {
            shot.status = "queued";
            shot.stage = "provider-generation";
            shot.taskId = recoveryTaskId;
            shot.paidTaskSubmitted = true;
          } else {
            shot.status = "failed";
            shot.error = runState.normalizeGenerationError(
              new Error("上次运行在平台任务编号写入前中断。为避免重复付费，已停止自动恢复，请人工确认后重试。"),
              { code: "UNSAFE_PAID_TASK_RECOVERY", stage: shot.stage || "provider-submission", retryable: false, now: new Date().toISOString() },
            );
            unsafeRecovery = true;
          }
        }
        if (unsafeSubmissionRecovery) {
          queue.status = queue.stopRequested === true ? "stopping" : "processing";
          queue.activeShotId = queue.queue.find((id) => queue.shots[id]?.submissionReservation?.status === "submission-reserved") || null;
          queue.completedAt = null;
          queue.updatedAt = new Date().toISOString();
          if (paths.isV6) await this.withWorkbenchSubmissionGate(paths.folder, async () => this.persistWorkbenchRun(paths, queue));
          else this.persistWorkbenchRun(paths, queue);
          this.mutateProject(paths.folder, (currentProject) => {
            currentProject.status = "completed_with_errors";
            currentProject.statusText = "检测到未决付费提交。为避免重复付费，未自动重提，请人工检查供应商记录。";
          });
          return false;
        }
        if (unsafeRecovery) {
          for (const id of queue.queue) if (queue.shots[id]?.status === "queued") queue.shots[id].status = "stopped";
          queue.status = queue.queue.some((id) => queue.shots[id]?.status === "failed") ? "partial-failure" : "stopped";
          queue.activeShotId = null;
          queue.completedAt = new Date().toISOString();
          queue.updatedAt = new Date().toISOString();
          if (paths.isV6) await this.withWorkbenchSubmissionGate(paths.folder, async () => this.persistWorkbenchRun(paths, queue));
          else this.persistWorkbenchRun(paths, queue);
          this.mutateProject(paths.folder, (project) => {
            project.status = "completed_with_errors";
            project.statusText = "检测到上次异常中断。为避免重复付费，未自动重提任务，请检查失败镜头后手动重试。";
          });
          this.archiveWorkbenchRun(paths, queue);
          return false;
        }
        queue.status = "queued";
        queue.activeShotId = null;
        queue.updatedAt = new Date().toISOString();
        if (paths.isV6) await this.withWorkbenchSubmissionGate(paths.folder, async () => this.persistWorkbenchRun(paths, queue));
        else this.persistWorkbenchRun(paths, queue);
      }

      this.assertWorkbenchQueueLockOwned(lock);
      this.queueApis.delete(paths.folder);
      const api = this.workbenchQueueApi(paths.folder, queue);
      this.activeQueueObjects.set(paths.folder, queue);
      const run = Promise.resolve()
        .then(() => api.run(queue))
        .then(() => this.finishWorkbenchQueue(paths.folder, queue))
        .catch((error) => {
          new Notice(`分镜队列恢复失败：${String(error?.message || error)}`, 10000);
          throw error;
        })
        .finally(() => this.releaseWorkbenchQueueLock(lock));
      lockTransferredToRun = true;
      this.queueRuns.set(paths.folder, run);
      run.catch(() => {});
      return true;
    } finally {
      if (!lockTransferredToRun) this.releaseWorkbenchQueueLock(lock);
    }
  }

  async recoverWorkbenchQueues() {
    for (const { project } of this.projectRecords()) {
      try { await this.recoverWorkbenchQueue(project.folder); }
      catch (_) { /* one damaged project must not block recovery of the others */ }
    }
  }

  currentWorkbenchLock(paths) {
    const request = this.readJson(paths.requestPath);
    const requestMtimeMs = fs.statSync(paths.requestPath).mtimeMs;
    const currentRun = runState.selectCurrentRun(this.currentRunInputs(paths, requestMtimeMs));
    const generationState = this.currentRunStateView(currentRun);
    if (request.confirmed === true) throw new Error("草案已确认，不能再编辑或重复确认。");
    if (runState.isRunActive(currentRun) && currentRun?.compatibilitySource === "legacy-state") {
      throw new Error("项目正在生成中，不能编辑或重复确认。");
    }
    return { request, requestMtimeMs, generationState, currentRun };
  }

  async saveWorkbenchDraft(folder, draft) {
    const paths = this.workbenchProjectPaths(folder);
    if (this.confirmingProjects?.has(paths.folder)) throw new Error("项目正在确认，不能编辑草案。");
    const { request: currentRequest } = this.currentWorkbenchLock(paths);
    const identifiedDraft = withWorkbenchShotIds(draft);
    const validation = replicaEditor.validateDraft(identifiedDraft, core.normalizeGenerationRequest);
    if (!validation.ok) {
      const details = validation.errors.map((error) => `${error.path}：${error.message}`).join("；");
      throw new Error(`草案校验失败：${details}`);
    }
    const savedRequest = {
      ...validation.value,
      shots: validation.value.shots.map((shot, index) => ({
        ...shot,
        workbenchId: identifiedDraft.shots[index].workbenchId,
      })),
    };
    const queue = this.currentWorkbenchQueue(paths.folder);
    const api = this.workbenchQueueApi(paths.folder);
    const lockedIds = new Set(api.lockedShotIds(queue));
    if (lockedIds.size) {
      const normalizedCurrent = core.normalizeGenerationRequest({ ...currentRequest, confirmed: true });
      if (JSON.stringify(normalizedCurrent.visualStyle) !== JSON.stringify(savedRequest.visualStyle)) {
        throw new Error("项目统一视觉风格正在被生成队列使用，完成或停止后才能修改。");
      }
      const currentById = new Map(normalizedCurrent.shots.map((shot) => [String(shot.id), shot]));
      const nextById = new Map(savedRequest.shots.map((shot) => [String(shot.id), shot]));
      for (const id of lockedIds) {
        const currentShot = currentById.get(id);
        const nextShot = nextById.get(id);
        const snapshot = (shot, legacyDefault) => ({
          ...Object.fromEntries(WORKBENCH_SHOT_FIELDS.map((field) => [field, shot?.[field]])),
          productIds: Array.isArray(shot?.productIds) ? shot.productIds : [],
          legacyFrameMode: shot?.legacyFrameMode === true || legacyDefault,
        });
        if (!currentShot || !nextShot
          || JSON.stringify(snapshot(currentShot, Number(normalizedCurrent.version) < 4))
            !== JSON.stringify(snapshot(nextShot, Number(savedRequest.version) < 4))) {
          throw new Error(`镜头 ${id} 正在队列中，完成或停止前不能修改。`);
        }
      }
    }
    const project = this.readJson(paths.projectPath);
    const currentShots = Array.isArray(project.shots)
      ? withWorkbenchShotIds({ shots: project.shots }).shots
      : [];
    const currentShotsByWorkbenchId = new Map();
    for (const shot of currentShots) {
      if (!shot || typeof shot !== "object" || Array.isArray(shot)) continue;
      const workbenchId = String(shot.workbenchId || "").trim();
      if (workbenchId) currentShotsByWorkbenchId.set(workbenchId, shot);
    }
    project.shots = savedRequest.shots.map((shot) => {
      const previous = currentShotsByWorkbenchId.get(shot.workbenchId);
      const next = { ...(previous || {}), workbenchId: shot.workbenchId };
      for (const field of WORKBENCH_SHOT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(shot, field)) next[field] = shot[field];
      }
      return next;
    });
    if (paths.isV6) {
      projectStorage.atomicWriteJson({
        resolveSafe: this.projectStorageResolver(paths.folder),
        relativePath: projectStorage.projectRelativePaths(paths.folder).draft,
        value: savedRequest,
      });
    } else writeJson(paths.requestPath, savedRequest);
    this.saveProject(paths.folder, project);
    this.requestWorkbenchRefresh();
    return savedRequest;
  }

  async confirmWorkbenchDraft(folder) {
    const paths = this.workbenchProjectPaths(folder);
    this.confirmingProjects ||= new Set();
    if (this.confirmingProjects.has(paths.folder)) throw new Error("项目正在确认，请勿重复操作。");
    this.confirmingProjects.add(paths.folder);
    try {
      this.currentWorkbenchLock(paths);
      const catalog = await this.refreshGenerationModelCatalog();
      const { request } = this.currentWorkbenchLock(paths);
      const requestedImageModel = String(request.settings?.imageModel || "").trim();
      const requestedVideoModel = String(request.settings?.videoModel || "").trim();
      const exact = (models, requested) => models.find((model) => model === requested)
        || models.find((model) => model.toLowerCase() === requested.toLowerCase());
      const imageModel = exact(Array.isArray(catalog?.imageModels) ? catalog.imageModels : [], requestedImageModel);
      const videoModel = exact(Array.isArray(catalog?.videoModels) ? catalog.videoModels : [], requestedVideoModel);
      if (!imageModel) throw this.unavailableGenerationModel("image", requestedImageModel, catalog?.imageModels || []);
      if (!videoModel) throw this.unavailableGenerationModel("video", requestedVideoModel, catalog?.videoModels || []);
      const selection = { imageModel, videoModel };
      request.settings = Object.assign({}, request.settings, selection);
      request.confirmed = true;
      writeJson(paths.requestPath, request);
      this.requestWorkbenchRefresh();
      new Notice(`已确认：${selection.imageModel} + ${selection.videoModel}，开始调用生成算力。`, 7000);
      await this.processRequest(paths.requestPath, true);
      return request;
    } finally {
      this.confirmingProjects.delete(paths.folder);
    }
  }

  projectRecords() {
    const rootCandidate = path.resolve(this.vaultPath(), ROOT);
    if (!fs.lstatSync(rootCandidate, { throwIfNoEntry: false })) return [];
    const root = this.checkedWorkbenchProjectFolder(ROOT).absoluteFolder;
    const records = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const folder = `${ROOT}/${entry.name}`;
        const { projectPath } = this.workbenchProjectPaths(folder);
        if (!fs.existsSync(projectPath)) continue;
        const project = this.readJson(projectPath);
        if (String(project?.folder || "").replace(/\\/g, "/") !== folder) continue;
        records.push({ project, projectPath, mtimeMs: fs.statSync(projectPath).mtimeMs });
      } catch (_) { /* skip incomplete folders */ }
    }
    return records.sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  latestProject(predicate = () => true) {
    return this.projectRecords().find((record) => predicate(record.project));
  }

  analysisSettings() {
    const image = this.app.plugins?.getPlugin?.("mangosteen-image");
    const video = this.app.plugins?.getPlugin?.("mangosteen-video");
    const imageModel = String(this.settings?.imageModel || image?.settings?.model || "gpt-image-2").trim();
    const currentModel = String(this.settings?.videoModel || video?.settings?.model || "").trim();
    const videoModel = generationPolicy.classifyModel(currentModel) ? currentModel : "MiniMax-H3";
    const family = generationPolicy.classifyModel(videoModel);
    let resolution = String(video?.settings?.resolution || "720p").trim() || "720p";
    if (family === "minimax-h3" && !["768p", "2k"].includes(resolution.toLowerCase())) resolution = "768p";
    if (family === "seedance" && !["480p", "720p", "1080p"].includes(resolution.toLowerCase())) resolution = "720p";
    return {
      imageModel,
      videoModel,
      resolution,
    };
  }

  async refreshGenerationModelCatalog() {
    const image = this.app.plugins?.getPlugin?.("mangosteen-image");
    const video = this.app.plugins?.getPlugin?.("mangosteen-video");
    if (typeof image?.refreshAgentAccess !== "function" || typeof video?.refreshAgentAccess !== "function") {
      throw new Error("山竹生图或视频插件未启用，无法读取生成模型。");
    }
    const [imageAccess, videoAccess] = await Promise.all([image.refreshAgentAccess(), video.refreshAgentAccess()]);
    return {
      imageModels: Object.keys(imageAccess?.imageModelKeys || {}),
      videoModels: generationPolicy.eligibleModels(Object.keys(videoAccess?.videoModelKeys || {})),
      currentImageModel: String(image.settings?.model || ""),
      currentVideoModel: String(video.settings?.model || ""),
    };
  }

  resolveGenerationSelection(catalog) {
    const imageModels = Array.isArray(catalog?.imageModels) ? catalog.imageModels : [];
    const videoModels = Array.isArray(catalog?.videoModels) ? catalog.videoModels : [];
    const requestedImage = String(this.settings?.imageModel || catalog?.currentImageModel || "");
    const requestedVideo = String(this.settings?.videoModel || catalog?.currentVideoModel || "");
    const exact = (models, requested) => models.find((model) => model === requested)
      || models.find((model) => model.toLowerCase() === requested.toLowerCase());
    const imageModel = exact(imageModels, requestedImage)
      || imageModels.find((model) => model.toLowerCase() === "gpt-image-2")
      || imageModels.find((model) => model.toLowerCase().startsWith("gpt-image-2"))
      || String(imageModels[0] || "");
    const videoModel = exact(videoModels, requestedVideo)
      || videoModels.find((model) => model.toLowerCase() === "minimax-h3")
      || String(videoModels[0] || "");
    return { imageModel, videoModel };
  }

  generationSelectionLabel() {
    const settings = this.analysisSettings();
    return `${settings.imageModel || "未选择图片模型"} + ${settings.videoModel || "未选择视频模型"}`;
  }

  async setGenerationSelection(imageModel, videoModel, catalog) {
    if (!catalog?.imageModels?.includes(imageModel) || !catalog?.videoModels?.includes(videoModel)) return false;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this.settings, { imageModel, videoModel });
    if (typeof this.saveData === "function") await this.saveData(this.settings);
    return true;
  }

  generationModelError(kind, model, error) {
    const message = String(error?.message || error || "模型不可用");
    const status = Number(error?.status || 0);
    const unavailable = error?.changeModel === true || status === 404
      || /model.*(not found|unavailable)|no available channel|模型.*(不存在|不可用|下架)|没有可用.*线路/i.test(message);
    if (!unavailable) return error;
    const typed = error instanceof Error ? error : new Error(message);
    typed.code = String(error?.code || "MODEL_UNAVAILABLE");
    if (status) typed.status = status;
    typed.changeModel = true;
    typed.generationKind = kind;
    typed.model = String(model || error?.model || "");
    return typed;
  }

  unavailableGenerationModel(kind, model, available) {
    const label = kind === "image" ? "图片" : "视频";
    const detail = available.length ? `当前可用：${available.join("、")}` : `当前账号没有可用的${label}模型`;
    return this.generationModelError(kind, model, Object.assign(new Error(`${label}模型“${model || "未选择"}”不可用。${detail}`), {
      code: "MODELS_UNAVAILABLE", status: 404, changeModel: true,
    }));
  }

  analysisModelCatalog() {
    const agent = this.app.plugins?.getPlugin?.("mangosteen-agent");
    if (typeof agent?.getLanguageModelCatalog !== "function") return { ready: false, activeGroup: "", activeModel: "", groups: [] };
    try {
      const catalog = agent.getLanguageModelCatalog() || {};
      const groups = (Array.isArray(catalog.groups) ? catalog.groups : []).map((group) => ({
        id: String(group?.id || ""),
        label: String(group?.label || group?.id || ""),
        ratio: Number(group?.ratio) || 1,
        models: (Array.isArray(group?.models) ? group.models : []).map(String).filter(Boolean),
      })).filter((group) => group.id && group.models.length);
      return {
        ready: catalog.ready === true,
        activeGroup: String(catalog.activeGroup || ""),
        activeModel: String(catalog.activeModel || ""),
        groups,
      };
    } catch (_) {
      return { ready: false, activeGroup: "", activeModel: "", groups: [] };
    }
  }

  resolveAnalysisSelection(catalog = this.analysisModelCatalog()) {
    const groups = catalog.groups || [];
    const preferredGroup = String(this.settings?.analysisGroup || "");
    const group = groups.find((item) => item.id === preferredGroup)
      || groups.find((item) => item.id === catalog.activeGroup)
      || groups[0];
    if (!group) return { catalog, group: "", model: "" };
    const preferredModel = String(this.settings?.analysisModel || "");
    const activeModel = group.id === catalog.activeGroup ? String(catalog.activeModel || "") : "";
    const model = group.models.includes(preferredModel) ? preferredModel
      : group.models.includes(activeModel) ? activeModel
        : String(group.models[0] || "");
    return { catalog, group: group.id, model };
  }

  analysisSelectionLabel() {
    const selection = this.resolveAnalysisSelection();
    return selection.model ? `${selection.group} / ${selection.model}` : "尚未读取到可用模型";
  }

  async setAnalysisSelection(group, model, catalog = this.analysisModelCatalog()) {
    const selectedGroup = catalog.groups.find((item) => item.id === String(group || ""));
    if (!selectedGroup || !selectedGroup.models.includes(String(model || ""))) return false;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this.settings, {
      analysisGroup: selectedGroup.id,
      analysisModel: String(model),
    });
    if (typeof this.saveData === "function") await this.saveData(this.settings);
    return true;
  }

  isAnalysisModelError(error) {
    const code = String(error?.code || "");
    const status = Number(error?.status || 0);
    return error?.changeModel === true || status === 404
      || ["MODELS_UNAVAILABLE", "REMOTE_REJECTED", "INVALID_RESPONSE"].includes(code);
  }

  async analyzeProject(projectFolder) {
    const checkedFolder = this.checkedWorkbenchProjectFolder(projectFolder).folder;
    const projectPath = this.checkedProjectPath(checkedFolder, "project.json");
    if (!fs.existsSync(projectPath)) throw new Error("找不到视频复刻项目的 project.json。");
    const project = this.readJson(projectPath);
    if (String(project.folder || "").replace(/\\/g, "/") !== checkedFolder) throw new Error("project.json 的项目目录与当前项目范围不一致，已拒绝访问。");
    const frames = workflow.sampleFrames(project.frames, 8);
    if (!frames.length) throw new Error("项目还没有提取画面，请先完成本地拆解。");
    const agent = this.app.plugins?.getPlugin?.("mangosteen-agent");
    if (typeof agent?.analyzeStructured !== "function") throw new Error("山竹智能体版本过低或未启用，请先更新并启用山竹智能体。");
    if (typeof agent?.getLanguageModelCatalog !== "function") throw new Error("山竹智能体版本过低，暂不支持选择视频分析模型，请先更新插件。");
    const selection = this.resolveAnalysisSelection();
    if (!selection.group || !selection.model) throw new Error("没有读取到可用的语言分析模型，请先登录山竹账号并选择模型。");
    const schemaPath = path.join(this.pluginRoot, "video-analysis-schema.json");
    if (!fs.existsSync(schemaPath)) throw new Error("缺少视频分析规则文件，请重新安装山竹视频复刻插件。");
    const analysisOutputPaths = [
      "project.json",
      REQUEST_FILE,
      ".work/ai-analysis.json",
      ".work/last-agent-response.json",
      "02-分镜脚本/分镜脚本.md",
      "00-项目总览.md",
    ];
    for (const outputPath of analysisOutputPaths) this.checkedProjectPath(checkedFolder, outputPath, { createParents: true });
    const transcriptPath = project.transcriptPath ? this.checkedProjectPath(checkedFolder, project.transcriptPath) : "";
    const transcriptText = transcriptPath && fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, "utf8") : "";
    const images = frames.map((frame) => {
      const framePath = this.checkedProjectPath(checkedFolder, frame.path);
      if (!fs.statSync(framePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`原片画面丢失：${path.basename(framePath)}`);
      return { name: path.basename(framePath), type: "image/jpeg", bytes: fs.readFileSync(framePath) };
    });
    project.status = "analyzing";
    project.statusText = "山竹智能体正在分析人物、场景和分镜";
    project.analysisProvider = "mangosteen-agent";
    project.analysisGroup = selection.group;
    project.analysisModel = selection.model;
    delete project.analysisErrorCode;
    delete project.analysisErrorStatus;
    delete project.analysisErrorAt;
    this.saveProject(projectFolder, project);
    try {
      const response = await agent.analyzeStructured({
        group: selection.group,
        model: selection.model,
        prompt: workflow.analysisPrompt(project, transcriptText),
        images,
        schema: this.readJson(schemaPath),
        schemaName: "video_replica_analysis",
      });
      const analysis = response?.data ?? response;
      const diagnosticPath = this.checkedProjectPath(checkedFolder, ".work/last-agent-response.json", { createParents: true });
      writeJson(diagnosticPath, analysis);
      const result = workflow.applyAnalysis({
        projectFolder: checkedFolder,
        vaultPath: this.vaultPath(),
        analysis,
        settings: this.analysisSettings(),
        analysisProvider: "mangosteen-agent",
        analysisGroup: response?.group || selection.group,
        analysisModel: response?.model || selection.model,
      });
      this.requestWorkbenchRefresh();
      await this.openVaultPath(`${checkedFolder}/00-项目总览.md`);
      return result;
    } catch (error) {
      const message = String(error?.message || error);
      if (this.isAnalysisModelError(error)) {
        project.status = "analysis_model_error";
        project.analysisErrorCode = String(error?.code || "MODEL_UNAVAILABLE");
        project.analysisErrorStatus = Number(error?.status || 0) || undefined;
        project.analysisErrorAt = new Date().toISOString();
        project.statusText = `分析模型 ${selection.model} 返回错误：${message}。请更换分析模型后重试。`;
      } else {
        project.status = "analysis_failed";
        project.statusText = `山竹智能体分析失败：${message}`;
      }
      this.saveProject(checkedFolder, project);
      if (project.status !== "analysis_model_error") throw error;
      const surfaced = new Error(project.statusText);
      surfaced.code = project.analysisErrorCode;
      surfaced.status = project.analysisErrorStatus;
      surfaced.changeModel = true;
      throw surfaced;
    }
  }

  async analyzeLatestProject() {
    const record = this.latestProject((project) => ["prepared", "analysis_failed", "analysis_model_error", "analysis_ready"].includes(project.status));
    if (!record) { new Notice("没有找到可分析的视频复刻项目。", 6000); return; }
    try {
      new Notice("AI 正在分析最近项目，通常需要 2–8 分钟。", 6000);
      await this.analyzeProject(record.project.folder);
      new Notice("分镜草案已生成，等待确认付费生成。", 8000);
    } catch (error) {
      new Notice(`AI 分析失败：${String(error?.message || error)}`, 10000);
    }
  }

  async confirmLatestGeneration() {
    const leaf = await this.activateWorkbench();
    if (leaf?.view) {
      leaf.view.activeTab = "shots";
      if (typeof leaf.view.refresh === "function") await leaf.view.refresh({ force: true });
      else if (typeof leaf.view.render === "function") leaf.view.render();
    }
    new Notice("请勾选要生成的分镜，并确认每个镜头的最终提示词。", 7000);
    return leaf;
  }

  async concatProject(project) {
    const projectFolder = this.checkedWorkbenchProjectFolder(project?.folder).folder;
    for (const shot of Array.isArray(project?.shots) ? project.shots : []) {
      if (shot?.videoPath) this.checkedProjectPath(projectFolder, shot.videoPath);
    }
    this.checkedProjectPath(projectFolder, ".work/concat.txt", { createParents: true });
    this.checkedProjectPath(projectFolder, "04-最终成片/最终成片.mp4", { createParents: true });
    return workflow.concatProjectVideos({ project, vaultPath: this.vaultPath(), pluginRoot: this.pluginRoot });
  }

  async concatLatestProject() {
    const record = this.latestProject((project) => Array.isArray(project.shots) && project.shots.length > 0 && project.shots.every((shot) => shot.videoPath));
    if (!record) { new Notice("没有找到已完成全部分镜的项目。", 6000); return; }
    try {
      record.project.finalVideoPath = await this.concatProject(record.project);
      delete record.project.concatError;
      record.project.status = "completed";
      record.project.statusText = "视频片段已拼接为最终成片";
      this.saveProject(record.project.folder, record.project);
      await this.openVaultPath(`${record.project.folder}/00-项目总览.md`);
      new Notice("最终成片已生成。", 7000);
    } catch (error) {
      record.project.concatError = String(error?.message || error);
      record.project.status = "completed_with_errors";
      record.project.statusText = `视频片段已完成，但拼接失败：${record.project.concatError}`;
      this.saveProject(record.project.folder, record.project);
      new Notice(record.project.statusText, 10000);
    }
  }

  async openVaultPath(vaultPath) {
    const rawPath = String(vaultPath).trim().replace(/\\/g, "/");
    if (path.posix.isAbsolute(rawPath) || /^[A-Za-z]:\//.test(rawPath)) throw new Error("知识库文件不能使用绝对路径，已拒绝打开。");
    vaultPath = core.normalizeVaultPath(rawPath);
    if (vaultPath.startsWith(`${ROOT}/`)) this.absolute(vaultPath);
    for (let index = 0; index < 25; index += 1) {
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (file) { await this.app.workspace.getLeaf(true).openFile(file); return true; }
      await sleep(200);
    }
    new Notice(`文件已生成：${vaultPath}`, 6000);
    return false;
  }

  findRequestFiles() {
    const rootCandidate = path.resolve(this.vaultPath(), ROOT);
    if (!fs.lstatSync(rootCandidate, { throwIfNoEntry: false })) return [];
    const root = this.checkedWorkbenchProjectFolder(ROOT).realFolder;
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try { return this.checkedProjectPath(`${ROOT}/${entry.name}`, REQUEST_FILE); } catch (_) { return ""; }
      })
      .filter((filePath) => fs.existsSync(filePath));
  }

  async scanRequests(notify) {
    for (const filePath of this.findRequestFiles()) await this.processRequest(filePath, notify);
  }

  async processRequestByVaultPath(vaultPath, notify) {
    if (!String(vaultPath).startsWith(`${ROOT}/`) || path.basename(vaultPath) !== REQUEST_FILE) return;
    await this.processRequest(this.absolute(vaultPath), notify);
  }

  readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }

  saveProject(projectFolder, project) {
    const checkedFolder = this.checkedWorkbenchProjectFolder(projectFolder).folder;
    if (String(project?.folder || "").replace(/\\/g, "/") !== checkedFolder) throw new Error("project.json 的项目目录与当前项目范围不一致，已拒绝写入。");
    const paths = this.workbenchProjectPaths(checkedFolder);
    if (paths.isV6) {
      projectStorage.atomicWriteJson({
        resolveSafe: this.projectStorageResolver(checkedFolder),
        relativePath: projectStorage.projectRelativePaths(checkedFolder).project,
        value: project,
      });
    } else writeJson(paths.projectPath, project);
    atomicWrite(this.checkedProjectPath(checkedFolder, "00-项目总览.md", { createParents: true }), core.dashboardMarkdown(project));
    this.requestWorkbenchRefresh();
  }

  mutateProject(projectFolder, mutator) {
    const { projectPath } = this.workbenchProjectPaths(projectFolder);
    const project = this.readJson(projectPath);
    mutator(project);
    this.saveProject(projectFolder, project);
    return project;
  }

  updateProjectShot(projectFolder, shotId, updates = {}, projectUpdates = {}) {
    return this.mutateProject(projectFolder, (project) => {
      project.shots = Array.isArray(project.shots) ? project.shots : [];
      let shot = project.shots.find((item) => String(item.id) === String(shotId));
      if (!shot) {
        shot = { id: String(shotId) };
        project.shots.push(shot);
      }
      Object.assign(shot, updates);
      Object.assign(project, projectUpdates);
    });
  }

  writeState(projectFolder, state) {
    if (state?.status === "processing") {
      const now = new Date();
      state.instanceId = this.instanceId || (this.instanceId = crypto.randomUUID());
      state.leaseStartedAt ||= now.toISOString();
      state.leaseUpdatedAt = now.toISOString();
      state.leaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS).toISOString();
    }
    const paths = this.workbenchProjectPaths(projectFolder, { createWorkDirectory: true });
    writeJson(paths.statePath, state);
    this.requestWorkbenchRefresh();
  }

  stopRequestPath(projectFolder) {
    return this.workbenchProjectPaths(projectFolder).stopPath;
  }

  isGenerationStopRequested(projectFolder, requestMtimeMs) {
    const stopPath = this.stopRequestPath(projectFolder);
    if (!fs.existsSync(stopPath)) return false;
    try {
      const stopRequest = this.readJson(stopPath);
      return Number(stopRequest.requestMtimeMs) === Number(requestMtimeMs);
    } catch (_) { return false; }
  }

  assertGenerationActive(projectFolder, requestMtimeMs) {
    if (!this.isGenerationStopRequested(projectFolder, requestMtimeMs)) return;
    const error = new Error("用户已停止视频复刻任务；已完成内容会保留，当前已提交的平台任务无法保证撤销。");
    error.code = GENERATION_STOPPED_CODE;
    throw error;
  }

  requestGenerationStop(projectFolder) {
    const paths = this.workbenchProjectPaths(projectFolder);
    if (!fs.existsSync(paths.statePath)) return false;
    const state = this.readJson(paths.statePath);
    if (state.status !== "processing" || !Number.isFinite(Number(state.requestMtimeMs))) return false;
    let markerMatches = false;
    let requestedAt = "";
    if (fs.existsSync(paths.stopPath)) {
      try {
        const existing = this.readJson(paths.stopPath);
        if (Number(existing.requestMtimeMs) === Number(state.requestMtimeMs)) {
          markerMatches = true;
          requestedAt = String(existing.requestedAt || "").trim();
        }
      } catch (_) { /* replace an unreadable marker atomically */ }
    }
    requestedAt ||= new Date().toISOString();
    if (!markerMatches) {
      writeJson(paths.stopPath, {
        requestMtimeMs: Number(state.requestMtimeMs),
        requestedAt,
      });
    }
    let repaired = !markerMatches;
    const stateUpdatedAtMs = Date.parse(String(state.updatedAt || ""));
    const requestedAtMs = Date.parse(requestedAt);
    const stateNeedsRepair = state.stopRequestedAt !== requestedAt
      || !Number.isFinite(stateUpdatedAtMs)
      || (Number.isFinite(requestedAtMs) && stateUpdatedAtMs < requestedAtMs);
    if (stateNeedsRepair) {
      state.stopRequestedAt = requestedAt;
      state.updatedAt = new Date().toISOString();
      writeJson(paths.statePath, state);
      repaired = true;
    }
    const stoppedStatusText = "已请求停止：当前已提交的平台任务完成后停止，不再提交新的付费任务。";
    try {
      const project = this.readJson(paths.projectPath);
      if (project.statusText !== stoppedStatusText) {
        project.statusText = stoppedStatusText;
        writeJson(paths.projectPath, project);
        atomicWrite(this.checkedProjectPath(paths.folder, "00-项目总览.md", { createParents: true }), core.dashboardMarkdown(project));
        repaired = true;
      }
    } catch (_) { /* stop marker remains authoritative */ }
    if (repaired) this.requestWorkbenchRefresh();
    return true;
  }

  async stopWorkbenchGeneration(projectFolder) {
    const queue = this.currentWorkbenchQueue(projectFolder) || this.activeQueueObjects.get(projectFolder);
    if (queue) {
      const api = this.workbenchQueueApi(projectFolder);
      if (api.lockedShotIds(queue).length) {
        await api.stop(queue);
        new Notice("已请求停止；当前已提交的镜头结束后，不再提交后续镜头。", 8000);
        return true;
      }
    }
    if (!this.requestGenerationStop(projectFolder)) throw new Error("当前项目没有正在运行的生成任务。");
    new Notice("已请求停止；当前已提交的任务结束后，不再生成后续内容。", 8000);
    return true;
  }

  async stopLatestGeneration() {
    const record = this.projectRecords().find((item) => {
      try {
        const currentRun = this.currentWorkbenchQueue(item.project.folder);
        return runState.isRunActive(currentRun);
      } catch (_) { return false; }
    });
    if (!record) { new Notice("当前没有正在运行的视频复刻任务。", 6000); return false; }
    return this.stopWorkbenchGeneration(record.project.folder);
  }

  requestAlreadyHandled(projectFolder, requestMtimeMs, nowMs = Date.now()) {
    try {
      const { statePath } = this.workbenchProjectPaths(projectFolder);
      if (!fs.existsSync(statePath)) return false;
      const state = this.readJson(statePath);
      if (Number(state.requestMtimeMs) !== Number(requestMtimeMs)) return false;
      if (["completed", "completed_with_errors", "failed", "stopped"].includes(state.status)) return true;
      if (state.status !== "processing") return false;
      const expiresAt = Date.parse(state.leaseExpiresAt || "");
      return Number.isFinite(expiresAt) && expiresAt > Number(nowMs);
    } catch (_) { return false; }
  }

  async processRequest(requestPath, notify = false) {
    if (this.processing.has(requestPath)) return;
    let projectFolder;
    let requestMtimeMs = null;
    let leaseTimer = null;
    try {
      const root = this.checkedWorkbenchProjectFolder(ROOT).realFolder;
      const canonicalRequestPath = fs.realpathSync(path.resolve(requestPath));
      const relative = path.relative(root, path.dirname(canonicalRequestPath));
      projectFolder = core.normalizeVaultPath(`${ROOT}/${relative.replace(/\\/g, "/")}`);
      const checkedRequestPath = this.checkedProjectPath(projectFolder, REQUEST_FILE);
      if (canonicalRequestPath !== fs.realpathSync(checkedRequestPath)) throw new Error("生成请求路径不安全，已拒绝处理。");
      requestPath = checkedRequestPath;
      const stat = fs.statSync(requestPath);
      requestMtimeMs = stat.mtimeMs;
      if (this.requestAlreadyHandled(projectFolder, requestMtimeMs)) return;
      const rawRequest = this.readJson(requestPath);
      if (rawRequest.confirmed !== true) return;
      const request = core.normalizeGenerationRequest(rawRequest);
      this.processing.add(requestPath);
      leaseTimer = setInterval(() => {
        try {
          const { statePath } = this.workbenchProjectPaths(projectFolder);
          if (!fs.existsSync(statePath)) return;
          const state = this.readJson(statePath);
          if (state.status === "processing" && Number(state.requestMtimeMs) === Number(requestMtimeMs) && state.instanceId === this.instanceId) {
            this.writeState(projectFolder, state);
          }
        } catch (_) { /* the next workflow state write retries lease persistence */ }
      }, Math.floor(PROCESSING_LEASE_MS / 3));
      leaseTimer.unref?.();
      await this.runGeneration(projectFolder, request, requestMtimeMs);
      if (notify) new Notice("视频复刻任务已经全部处理完成。", 7000);
    } catch (error) {
      if (projectFolder) {
        const stopped = error?.code === GENERATION_STOPPED_CODE;
        const modelError = !stopped && error?.changeModel === true && ["image", "video"].includes(error?.generationKind);
        const status = stopped ? "stopped" : modelError ? `generation_${error.generationKind}_model_error` : "failed";
        const state = {
          status,
          requestMtimeMs,
          updatedAt: new Date().toISOString(),
          error: String(error?.message || error),
          ...(modelError ? {
            errorCode: String(error?.code || "MODEL_UNAVAILABLE"),
            errorStatus: Number(error?.status || 0) || undefined,
            modelKind: error.generationKind,
            model: String(error?.model || ""),
          } : {}),
        };
        this.writeState(projectFolder, state);
        try {
          const project = this.readJson(this.checkedProjectPath(projectFolder, "project.json"));
          project.status = status;
          if (stopped) {
            project.statusText = "生成已停止；已完成的参考图和视频片段均已保留。";
          } else if (modelError) {
            const label = error.generationKind === "image" ? "图片" : "视频";
            project.generationErrorCode = state.errorCode;
            project.generationErrorStatus = state.errorStatus;
            project.generationErrorAt = state.updatedAt;
            project.statusText = `${label}模型 ${state.model || "当前选择"} 返回错误：${state.error}。请更换${label}模型后重试。`;
          } else project.statusText = `生成失败：${state.error}`;
          this.saveProject(projectFolder, project);
        } catch (_) {}
      }
      if (notify) new Notice(
        error?.code === GENERATION_STOPPED_CODE ? "视频复刻已停止，已完成内容均已保留。" : `视频复刻失败：${String(error?.message || error)}`,
        10000,
      );
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      this.processing.delete(requestPath);
    }
  }

  getGenerationPlugins() {
    const image = this.app.plugins.getPlugin("mangosteen-image");
    const video = this.app.plugins.getPlugin("mangosteen-video");
    if (!image?.generateText || !image?.generateEdit) throw new Error("山竹生图插件未启用或版本不兼容。");
    if (!video?.submitVideo || !video?.refreshVideoTasks || !video?.refreshAgentAccess) throw new Error("山竹视频插件未启用或版本不兼容。");
    return { image, video };
  }

  async saveImageCandidate(imagePlugin, candidate, vaultPath, outputTarget = null) {
    const target = outputTarget || candidate?.__mangosteenOutputTarget || null;
    if (target && target.destinationPath !== vaultPath) throw new Error("生图目标路径与镜头文件路径不一致。");
    let supportsTargetSave = false;
    if (target && typeof imagePlugin?.supportsOutputTargetSave === "function") {
      try { supportsTargetSave = imagePlugin.supportsOutputTargetSave() === true; }
      catch (_) { supportsTargetSave = false; }
    }
    if (target && supportsTargetSave && typeof imagePlugin?.saveImageResult === "function") {
      const task = await imagePlugin.saveImageResult({
        taskId: candidate?.__mangosteenTaskId,
        submissionFingerprint: candidate?.__mangosteenSubmissionFingerprint,
        candidates: [candidate],
        prompt: candidate?.__mangosteenPrompt,
        mode: candidate?.__mangosteenMode,
        model: candidate?.__mangosteenModel,
        requestedCount: 1,
        outputTarget: target,
      });
      if (task?.saved !== true || !Array.isArray(task.imagePaths) || task.imagePaths[0] !== vaultPath) {
        throw new Error("山竹生图未确认目标文件已保存，请升级插件后重试。");
      }
      this.assertDurableProjectArtifact(this.shotArtifactProjectFolder(vaultPath), vaultPath);
      return vaultPath;
    }
    if (target && !this.imageTargetUpgradeNoticeShown) {
      this.imageTargetUpgradeNoticeShown = true;
      new Notice("山竹生图版本较旧，已使用安全兼容保存。请升级山竹生图以启用项目目标直存。", 10000);
    }
    const terminalizeLegacyTask = target
      ? this.prepareLegacyImageTaskTerminalization(imagePlugin, candidate, vaultPath)
      : null;
    const absolutePath = this.absolute(vaultPath, { createParents: true });
    let bytes;
    if (candidate?.kind === "base64") bytes = Buffer.from(candidate.value, "base64");
    else if (candidate?.kind === "url") {
      const response = await requestUrl({ url: candidate.value, method: "GET", throw: false });
      if (response.status >= 400 || !response.arrayBuffer) throw new Error("图片已生成，但下载失败。");
      imagePlugin.api?.assertImageDownloadSize?.(response);
      bytes = Buffer.from(response.arrayBuffer);
    } else throw new Error("生图接口没有返回可保存的图片。");
    atomicWrite(absolutePath, bytes);
    if (terminalizeLegacyTask) await terminalizeLegacyTask();
    else await imagePlugin.reconcileImageSubmission?.(candidate?.__mangosteenSubmissionFingerprint);
    return vaultPath;
  }

  prepareLegacyImageTaskTerminalization(imagePlugin, candidate, vaultPath) {
    const taskId = String(candidate?.__mangosteenTaskId || "").trim();
    const fingerprint = String(candidate?.__mangosteenSubmissionFingerprint || "").trim();
    const settings = imagePlugin?.settings;
    const taskCollections = [
      Array.isArray(settings?.imageTasks) ? settings.imageTasks : null,
      Array.isArray(imagePlugin?.imageTasks) ? imagePlugin.imageTasks : null,
    ].filter(Boolean);
    const task = taskCollections.flat().find((item) => String(item?.id || "") === taskId);
    const persist = typeof imagePlugin?.saveSettings === "function"
      ? () => imagePlugin.saveSettings()
      : null;
    const upgradeError = (detail, cause = null) => {
      const error = new Error(`山竹生图版本过旧，兼容保存无法可靠终结原任务（${detail}）。请升级山竹生图后重试。`);
      error.code = "IMAGE_PLUGIN_UPGRADE_REQUIRED";
      if (cause) error.cause = cause;
      return error;
    };
    if (!taskId || !task || !persist) {
      throw upgradeError(!taskId ? "缺少任务编号" : !task ? "找不到对应任务记录" : "缺少持久化接口");
    }
    return async () => {
      Object.assign(task, {
        status: "completed",
        progress: 100,
        saved: true,
        imagePaths: [vaultPath],
        localPath: vaultPath,
        destinationPath: vaultPath,
      });
      try {
        await persist();
      } catch (error) {
        throw upgradeError("任务完成状态无法持久化", error);
      }

      if (!fingerprint) return task;
      try {
        if (typeof imagePlugin.reconcileImageSubmission === "function") {
          await imagePlugin.reconcileImageSubmission(fingerprint);
        } else if (Array.isArray(settings?.submissionMarkers)) {
          settings.submissionMarkers = settings.submissionMarkers.filter((item) => item?.fingerprint !== fingerprint);
          await persist();
        }
      } catch (error) {
        throw upgradeError("提交标记无法核销", error);
      }
      return task;
    };
  }

  localImage(vaultPath) {
    const absolutePath = this.absolute(vaultPath);
    const buffer = fs.readFileSync(absolutePath);
    return {
      name: path.basename(vaultPath),
      type: /\.jpe?g$/i.test(vaultPath) ? "image/jpeg" : /\.webp$/i.test(vaultPath) ? "image/webp" : "image/png",
      buffer,
      arrayBuffer: async () => buffer,
    };
  }

  async generateImage(imagePlugin, prompt, referencePath = "", imageModel = "", outputTarget = null) {
    try {
      const response = referencePath
        ? await imagePlugin.generateEdit(prompt, this.localImage(referencePath), "video-replica", { model: imageModel, ...(outputTarget ? { outputTarget } : {}) })
        : await imagePlugin.generateText(prompt, 1, "video-replica", { model: imageModel, ...(outputTarget ? { outputTarget } : {}) });
      const candidate = imagePlugin.extractResults(response)?.[0];
      if (!candidate) throw new Error("生图任务完成，但没有返回图片。");
      candidate.__mangosteenSubmissionFingerprint = response?.__mangosteenSubmissionFingerprint;
      candidate.__mangosteenTaskId = response?.__mangosteenTaskId;
      candidate.__mangosteenOutputTarget = response?.__mangosteenOutputTarget || outputTarget || null;
      candidate.__mangosteenPrompt = prompt;
      candidate.__mangosteenMode = referencePath ? "图生图" : "文生图";
      candidate.__mangosteenModel = imageModel;
      return candidate;
    } catch (error) {
      throw this.generationModelError("image", imageModel, error);
    }
  }

  async generateImageMulti(imagePlugin, prompt, referencePaths, imageModel = "", outputTarget = null) {
    if (typeof imagePlugin.generateEditMulti !== "function") throw new Error("山竹生图插件版本过低，缺少多图参考能力。请先更新插件。");
    try {
      const response = await imagePlugin.generateEditMulti(
        prompt,
        referencePaths.map((vaultPath) => this.localImage(vaultPath)),
        "video-replica",
        { model: imageModel, ...(outputTarget ? { outputTarget } : {}) },
      );
      const candidate = imagePlugin.extractResults(response)?.[0];
      if (!candidate) throw new Error("多图参考生图完成，但没有返回图片。");
      candidate.__mangosteenSubmissionFingerprint = response?.__mangosteenSubmissionFingerprint;
      candidate.__mangosteenTaskId = response?.__mangosteenTaskId;
      candidate.__mangosteenOutputTarget = response?.__mangosteenOutputTarget || outputTarget || null;
      candidate.__mangosteenPrompt = prompt;
      candidate.__mangosteenMode = "图生图";
      candidate.__mangosteenModel = imageModel;
      return candidate;
    } catch (error) {
      throw this.generationModelError("image", imageModel, error);
    }
  }

  async ensureReferenceAsset(imagePlugin, asset, prompt, imageModel = "", projectVisualStyle = null) {
    this.referenceAssetPromises ||= new Map();
    const generationSpec = referenceAssets.createGenerationSpec(asset, prompt, projectVisualStyle);
    const promptFingerprint = crypto.createHash("sha256").update(JSON.stringify(generationSpec)).digest("hex");
    const key = `${asset.kind}:${asset.id}:${promptFingerprint}`;
    const pending = this.referenceAssetPromises.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const current = referenceAssets.resolveReferenceAsset(this.vaultPath(), asset.kind, asset.id);
      if (referenceAssets.assetMatchesGenerationSpec(current, generationSpec)) return { ...current, reused: true };
      const candidate = await this.generateImage(imagePlugin, generationSpec.generationPrompt, "", imageModel);
      await this.saveImageCandidate(imagePlugin, candidate, current.imagePath);
      referenceAssets.writeAssetMetadata(this.vaultPath(), current, {
        prompt: generationSpec.sourcePrompt,
        sourcePrompt: generationSpec.sourcePrompt,
        generationPrompt: generationSpec.generationPrompt,
        generationPolicyVersion: generationSpec.policyVersion,
        createdAt: new Date().toISOString(),
      });
      const refreshed = referenceAssets.resolveReferenceAsset(this.vaultPath(), current.kind, current.id);
      return { ...refreshed, reused: false };
    })();
    this.referenceAssetPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.referenceAssetPromises.get(key) === promise) this.referenceAssetPromises.delete(key);
    }
  }

  async waitForVideo(videoPlugin, taskId, timeoutMs = 45 * 60 * 1000, onProgress = null, expectedLocalPath = "") {
    const startedAtMs = Date.now();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await videoPlugin.refreshVideoTasks();
      const task = (videoPlugin.settings.videoTasks || []).find((item) => item.id === taskId);
      if (typeof onProgress === "function" && task) {
        const suppliedProgress = typeof task.progress === "number" && Number.isFinite(task.progress)
          ? task.progress
          : typeof task.progressPercent === "number" && Number.isFinite(task.progressPercent)
            ? task.progressPercent
            : null;
        await onProgress({
          progress: suppliedProgress !== null && suppliedProgress >= 0 && suppliedProgress <= 100 ? suppliedProgress : null,
          elapsedMs: Math.max(0, Date.now() - startedAtMs),
        });
      }
      if (task?.status === "completed" && task.localPath) {
        if (expectedLocalPath && task.localPath !== expectedLocalPath) {
          throw new Error(`视频保存路径与项目目标不一致：${task.localPath}`);
        }
        return task;
      }
      if (task?.status === "failed") {
        const failure = new Error(task.lastError || "视频生成失败。");
        failure.code = "VIDEO_TASK_FAILED";
        failure.terminalTaskFailure = true;
        failure.videoTaskId = String(taskId);
        throw failure;
      }
      await sleep(7000);
    }
    throw new Error("视频任务等待超过 45 分钟。任务仍保留在山竹视频中，可稍后继续查看。");
  }

  copyVaultFile(sourceVaultPath, targetVaultPath) {
    const source = this.absolute(sourceVaultPath);
    const target = this.absolute(targetVaultPath, { createParents: true });
    fs.copyFileSync(source, target);
    return targetVaultPath;
  }

  async finalizeProject(projectFolder, project, failed) {
    if (failed) {
      delete project.concatError;
      Object.assign(project, { finalVideoPath: "", status: "completed_with_errors", statusText: `已完成，${failed} 个镜头需要重试` });
      this.mutateProject(projectFolder, (latest) => {
        delete latest.concatError;
        latest.finalVideoPath = "";
        latest.status = "completed_with_errors";
        latest.statusText = `已完成，${failed} 个镜头需要重试`;
      });
    } else {
      try {
        const finalVideoPath = await this.concatProject(project);
        delete project.concatError;
        Object.assign(project, { finalVideoPath, status: "completed", statusText: "全部镜头已生成并拼接为最终成片" });
        this.mutateProject(projectFolder, (latest) => {
          delete latest.concatError;
          latest.finalVideoPath = finalVideoPath;
          latest.status = "completed";
          latest.statusText = "全部镜头已生成并拼接为最终成片";
        });
      } catch (error) {
        const concatError = String(error?.message || error);
        Object.assign(project, {
          finalVideoPath: "",
          concatError,
          status: "completed_with_errors",
          statusText: `视频片段已完成，但拼接失败：${concatError}`,
        });
        this.mutateProject(projectFolder, (latest) => {
          latest.finalVideoPath = "";
          latest.concatError = concatError;
          latest.status = "completed_with_errors";
          latest.statusText = `视频片段已完成，但拼接失败：${concatError}`;
        });
      }
    }
  }

  async resolveQueueGenerationRuntime(settings = {}) {
    const { image, video } = this.getGenerationPlugins();
    const [imageAccess, videoAccess] = await Promise.all([image.refreshAgentAccess(), video.refreshAgentAccess()]);
    const exact = (models, requested) => models.find((candidate) => candidate === requested)
      || models.find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
    const requestedImageModel = String(settings.imageModel || "").trim();
    const requestedVideoModel = String(settings.videoModel || "").trim();
    const imageModels = Object.keys(imageAccess?.imageModelKeys || {});
    const videoModels = generationPolicy.eligibleModels(Object.keys(videoAccess?.videoModelKeys || {}));
    const imageModel = exact(imageModels, requestedImageModel);
    const model = exact(videoModels, requestedVideoModel);
    if (!imageModel) throw this.unavailableGenerationModel("image", requestedImageModel, imageModels);
    if (!model) throw this.unavailableGenerationModel("video", requestedVideoModel, videoModels);
    return {
      image,
      video,
      imageModel,
      model,
      resolution: String(settings.resolution || video.settings?.resolution || "").trim(),
    };
  }

  projectFileExists(projectFolder, vaultPath) {
    if (!String(vaultPath || "").trim()) return false;
    try {
      return Boolean(fs.statSync(this.checkedProjectPath(projectFolder, vaultPath), { throwIfNoEntry: false })?.isFile());
    } catch (_) {
      return false;
    }
  }

  async runWorkbenchQueueShot(projectFolder, shot, context) {
    const paths = this.workbenchProjectPaths(projectFolder, { createWorkDirectory: true });
    const runStartedAtMs = Date.now();
    const report = async (patch) => {
      if (typeof context?.updateState !== "function") return null;
      return context.updateState({
        progress: null,
        elapsedMs: Math.max(0, Date.now() - runStartedAtMs),
        ...patch,
      });
    };
    const assertPaidSubmissionAllowed = async () => {
      const allowed = await context?.assertPaidSubmissionAllowed?.();
      if (allowed !== false) return true;
      const stopped = new Error("用户已停止生成；不会再提交新的付费任务。");
      stopped.code = GENERATION_STOPPED_CODE;
      throw stopped;
    };
    const withPaidSubmissionGate = async (boundary, operation) => {
      if (typeof context?.withPaidSubmissionGate === "function") {
        return context.withPaidSubmissionGate(boundary, operation);
      }
      await assertPaidSubmissionAllowed();
      return operation();
    };
    await report({ status: "preparing", stage: "preflight", error: null });
    this.assertWorkbenchQueueRunnerLock(paths.folder, context.queueId);
    if (!paths.isV6) {
      for (const directory of ["01-人物参考", "02-分镜脚本", "03-视频片段", "04-最终成片", ".work"]) {
        this.checkedProjectPath(paths.folder, directory, { createParents: true, directory: true });
      }
    }
    const versionSixArtifacts = paths.isV6 ? projectStorage.shotArtifactPaths(paths.folder, shot.id) : null;
    const initialProject = this.readJson(paths.projectPath);
    const submittedShot = (initialProject.shots || []).find((item) => String(item.id) === String(shot.id));
    const activeRunTaskId = String(context?.recoveryTaskId || "").trim();
    const legacyTaskId = submittedShot?.videoTaskId && submittedShot.videoTaskPlanId === context.planId
      ? String(submittedShot.videoTaskId)
      : "";
    const recoveryTaskId = activeRunTaskId || legacyTaskId;
    if (recoveryTaskId) {
      const { video } = this.getGenerationPlugins();
      const videoPath = versionSixArtifacts?.video
        || paths.folder + "/03-视频片段/镜头-" + shot.id + "-" + core.safeSegment(shot.title) + ".mp4";
      const previousArtifactState = this.projectShotArtifactState(submittedShot);
      const validatedRecoveryFingerprint = paths.isV6
        && String(submittedShot?.videoTaskId || "") === recoveryTaskId
        && String(submittedShot?.videoTaskPlanId || "") === String(context.planId || "")
        && String(submittedShot?.videoTaskFingerprint || "").trim()
        ? String(submittedShot.videoTaskFingerprint).trim()
        : "";
      const persistedVideoTask = (video.settings?.videoTasks || [])
        .find((item) => String(item?.id || "") === recoveryTaskId);
      const targetAlreadyLanded = paths.isV6
        && persistedVideoTask?.status === "completed"
        && persistedVideoTask.localPath === videoPath
        && this.projectFileExists(paths.folder, videoPath);
      this.updateProjectShot(paths.folder, shot.id, {
        status: "正在恢复并查询已有视频任务",
        videoTaskId: recoveryTaskId,
        videoTaskPlanId: context.planId,
        videoTaskStatus: "processing",
      });
      await report({
        status: "video-processing",
        stage: "provider-generation",
        taskId: recoveryTaskId,
        paidTaskSubmitted: true,
      });
      try {
        const finalizeRecoveredTask = async (completedTask) => {
          await report({
            status: "saving",
            stage: "saving",
            taskId: recoveryTaskId,
            paidTaskSubmitted: true,
          });
          let savedPath;
          if (paths.isV6) {
            if (completedTask.localPath !== videoPath) {
              throw new Error(`版本 6 视频恢复路径与项目目标不一致，已拒绝复制：${String(completedTask.localPath || "未返回路径")}`);
            }
            savedPath = this.assertDurableProjectArtifact(paths.folder, videoPath);
          } else {
            savedPath = this.copyVaultFile(completedTask.localPath, videoPath);
          }
          this.updateProjectShot(paths.folder, shot.id, {
            videoPath: savedPath,
            status: "已完成",
            error: "",
            videoTaskStatus: "completed",
            videoTaskCompletedAt: new Date().toISOString(),
            ...(validatedRecoveryFingerprint ? { generationFingerprint: validatedRecoveryFingerprint } : {}),
          });
          return { completed: completedTask, savedVideoPath: savedPath };
        };
        const recovered = targetAlreadyLanded
          ? await finalizeRecoveredTask(persistedVideoTask)
          : await this.withArchivedProjectArtifact({
            projectFolder: paths.folder,
            shotId: shot.id,
            kind: "shot-video",
            enabled: paths.isV6,
            restoreState: () => this.updateProjectShot(paths.folder, shot.id, previousArtifactState),
          }, async () => {
            const completedTask = await this.waitForVideo(video, recoveryTaskId, 45 * 60 * 1000, (progress) => report({
              status: "video-processing",
              stage: "provider-generation",
              taskId: recoveryTaskId,
              paidTaskSubmitted: true,
              ...progress,
            }), paths.isV6 ? videoPath : "");
            return finalizeRecoveredTask(completedTask);
          });
        return {
          videoPath: recovered.savedVideoPath,
          ...(submittedShot?.firstImagePath ? { firstImagePath: submittedShot.firstImagePath } : {}),
          ...(submittedShot?.lastImagePath ? { lastImagePath: submittedShot.lastImagePath } : {}),
        };
      } catch (error) {
        const message = String(error?.message || error);
        const terminalTaskFailure = error?.terminalTaskFailure === true || error?.code === "VIDEO_TASK_FAILED";
        this.updateProjectShot(paths.folder, shot.id, {
          status: "失败",
          error: message,
          videoTaskStatus: terminalTaskFailure ? "failed" : "unknown",
          ...(terminalTaskFailure ? {
            failedVideoTaskId: recoveryTaskId,
            failedVideoTaskPlanId: String(context.planId || ""),
            failedVideoTaskError: message,
            failedVideoTaskAt: new Date().toISOString(),
            videoTaskId: "",
            videoTaskFingerprint: "",
            videoTaskPlanId: "",
          } : {}),
        });
        throw error;
      }
    }
    this.updateProjectShot(paths.folder, shot.id, {
      status: "正在读取生成模型",
      error: "",
    }, {
      status: "generating",
      statusText: `镜头 ${shot.id} · 正在读取生成模型`,
    });
    let runtime;
    try {
      runtime = await this.resolveQueueGenerationRuntime(context.settings);
    } catch (error) {
      this.updateProjectShot(paths.folder, shot.id, { status: "失败", error: String(error?.message || error) });
      throw error;
    }
    const { image, video, imageModel, model, resolution } = runtime;
    const ensureAsset = async (kind, source) => {
      this.assertWorkbenchQueueRunnerLock(paths.folder, context.queueId);
      const label = kind === "character" ? "人物" : kind === "scene" ? "场景" : "产品";
      await report({ status: "reference-processing", stage: "reference-assets" });
      this.updateProjectShot(paths.folder, shot.id, {
        status: `正在准备${label}参考图 · ${String(source.id || "")}`,
      }, {
        status: "generating",
        statusText: `镜头 ${shot.id} · 正在准备${label}参考图`,
      });
      const resolver = kind === "character"
        ? referenceAssets.resolveCharacterAsset
        : kind === "scene"
          ? referenceAssets.resolveSceneAsset
          : referenceAssets.resolveProductAsset;
      const resolved = await withPaidSubmissionGate({ kind: "reference-asset", assetKind: kind, assetId: String(source.id || "") }, async ({ resolve } = {}) => {
        const accepted = await this.ensureReferenceAsset(image, resolver(this.vaultPath(), source.id), source.prompt, imageModel, context.visualStyle);
        await (resolve || report)({
          status: "reference-processing",
          stage: "reference-assets",
          ...(accepted.reused !== true ? { paidTaskSubmitted: true } : {}),
          recoveryContext: {
            boundary: "reference-asset",
            assetKind: kind,
            assetId: String(source.id || ""),
            imagePath: String(accepted.imagePath || ""),
          },
        });
        return accepted;
      });
      this.updateProjectShot(paths.folder, shot.id, { status: `${label}参考图已就绪 · ${String(source.id || "")}` });
      return {
        id: resolved.id,
        imagePath: resolved.imagePath,
        metadataPath: resolved.metadataPath,
        contentHash: resolved.contentHash || referenceAssets.hashAssetImage(this.vaultPath(), resolved),
        reused: resolved.reused,
      };
    };
    const characterAsset = await ensureAsset("character", context.character);
    const sceneAssets = [];
    for (const scene of context.scenes || []) sceneAssets.push(await ensureAsset("scene", scene));
    const productAssets = [];
    for (const product of context.products || []) productAssets.push(await ensureAsset("product", product));
    const mergeAssets = (current, updates) => {
      const byId = new Map((Array.isArray(current) ? current : []).map((asset) => [String(asset.id), asset]));
      for (const asset of updates) byId.set(String(asset.id), asset);
      return [...byId.values()];
    };
    this.mutateProject(paths.folder, (project) => {
      project.characterAsset = characterAsset;
      project.sceneAssets = mergeAssets(project.sceneAssets, sceneAssets);
      project.productAssets = mergeAssets(project.productAssets, productAssets);
      project.imageModel = imageModel;
      project.videoModel = model;
      project.status = "generating";
      project.statusText = "正在生成镜头 " + shot.id;
    });

    const sceneSource = (context.scenes || []).find((item) => String(item.id) === String(shot.sceneId));
    const sceneAsset = sceneAssets.find((item) => String(item.id) === String(shot.sceneId));
    if (!sceneSource || !sceneAsset) throw new Error("镜头 " + shot.id + " 找不到场景资产：" + shot.sceneId);
    const productSources = (shot.productIds || []).map((id) => {
      const source = (context.products || []).find((item) => String(item.id) === String(id));
      const asset = productAssets.find((item) => String(item.id) === String(id));
      if (!source || !asset) throw new Error("镜头 " + shot.id + " 找不到产品资产：" + id);
      return { source, asset };
    });
    const fingerprint = generationPolicy.createGenerationFingerprint({
      requestVersion: context.requestVersion,
      visualStyle: context.visualStyle,
      character: { ...context.character, contentHash: characterAsset.contentHash },
      scene: { ...sceneSource, contentHash: sceneAsset.contentHash },
      products: productSources.map(({ source, asset }) => ({ ...source, contentHash: asset.contentHash })),
      shot,
      model,
      ratio: context.settings.ratio,
      resolution,
    });
    const latestProject = this.readJson(paths.projectPath);
    const existing = (latestProject.shots || []).find((item) => String(item.id) === String(shot.id)) || {};
    const structuredTimeline = Number(context.requestVersion) >= 4
      && Array.isArray(shot.timeline) && shot.timeline.length > 0;
    const modelFamily = generationPolicy.classifyModel(model);
    const directReferenceMode = structuredTimeline && modelFamily === "seedance";
    const needsFirstFrame = !directReferenceMode;
    const needsLastFrame = !structuredTimeline && Boolean(shot.lastImagePrompt);
    const firstImagePath = needsFirstFrame
      ? versionSixArtifacts?.firstFrame || paths.folder + "/02-分镜脚本/镜头-" + shot.id + "-" + core.safeSegment(shot.title) + "-首帧.png"
      : "";
    const lastImagePath = needsLastFrame
      ? versionSixArtifacts?.lastFrame || paths.folder + "/02-分镜脚本/镜头-" + shot.id + "-" + core.safeSegment(shot.title) + "-尾帧.png"
      : "";
    const videoPath = versionSixArtifacts?.video
      || paths.folder + "/03-视频片段/镜头-" + shot.id + "-" + core.safeSegment(shot.title) + ".mp4";
    const firstImageOutputTarget = paths.isV6 && firstImagePath
      ? this.replicaOutputTarget(paths.folder, shot.id, "first-frame", firstImagePath)
      : null;
    const lastImageOutputTarget = paths.isV6 && lastImagePath
      ? this.replicaOutputTarget(paths.folder, shot.id, "last-frame", lastImagePath)
      : null;
    const videoOutputTarget = paths.isV6
      ? this.replicaOutputTarget(paths.folder, shot.id, "shot-video", videoPath)
      : null;
    const sameGeneration = existing.generationFingerprint === fingerprint;
    const reusableFirst = !needsFirstFrame || (sameGeneration && existing.firstImagePath === firstImagePath && this.projectFileExists(paths.folder, firstImagePath));
    const reusableLast = !needsLastFrame || (sameGeneration && existing.lastImagePath === lastImagePath && this.projectFileExists(paths.folder, lastImagePath));
    const reusableVideo = sameGeneration && reusableFirst && reusableLast
      && existing.videoPath === videoPath && this.projectFileExists(paths.folder, videoPath);
    const resumableVideoTaskId = existing.videoTaskId
      && existing.videoTaskPlanId === context.planId
      ? String(existing.videoTaskId)
      : "";
    let currentFirstImagePath = resumableVideoTaskId ? String(existing.firstImagePath || existing.imagePath || "") : reusableFirst ? firstImagePath : "";
    let currentLastImagePath = resumableVideoTaskId ? String(existing.lastImagePath || "") : reusableLast ? lastImagePath : "";
    const visibleFirstImagePath = paths.isV6 && existing.firstImagePath === firstImagePath && this.projectFileExists(paths.folder, firstImagePath)
      ? firstImagePath
      : currentFirstImagePath;
    const visibleLastImagePath = paths.isV6 && existing.lastImagePath === lastImagePath && this.projectFileExists(paths.folder, lastImagePath)
      ? lastImagePath
      : currentLastImagePath;
    const visibleVideoPath = paths.isV6 && existing.videoPath === videoPath && this.projectFileExists(paths.folder, videoPath)
      ? videoPath
      : reusableVideo ? videoPath : "";
    this.updateProjectShot(paths.folder, shot.id, {
      ...shot,
      generationFingerprint: paths.isV6 ? String(existing.generationFingerprint || "") : fingerprint,
      firstImagePath: visibleFirstImagePath,
      imagePath: visibleFirstImagePath,
      lastImagePath: visibleLastImagePath,
      videoPath: visibleVideoPath,
      status: reusableVideo ? "已完成" : "正在准备参考图",
      error: "",
      ...(resumableVideoTaskId ? {} : {
        videoTaskId: "",
        videoTaskFingerprint: "",
        videoTaskPlanId: "",
        videoTaskStatus: "",
      }),
    }, { status: "generating", statusText: "正在生成镜头 " + shot.id });
    if (reusableVideo) return { videoPath, firstImagePath, lastImagePath: lastImagePath || undefined };

    let videoTaskId = resumableVideoTaskId;
    try {
      const referencePaths = [
        characterAsset.imagePath,
        sceneAsset.imagePath,
        ...productSources.map(({ asset }) => asset.imagePath),
      ];
      const continuity = [
        "参考图1是人物设定板：人物身份、脸部、发型、发色、年龄与服装必须严格一致。",
        "参考图2是纯环境场景板：只参考空间、固定陈设、光线、天气与环境质感，不得从中创造人物或核心产品。",
        ...productSources.map(({ asset }, index) => "参考图" + (index + 3) + "是产品设定板（" + asset.id + "）：产品外形、颜色、材质、比例、包装和标识位置必须严格一致。"),
      ].join("\n");
      if (!videoTaskId && needsFirstFrame && !currentFirstImagePath) {
        this.assertWorkbenchQueueRunnerLock(paths.folder, context.queueId);
        await report({ status: "image-processing", stage: "first-frame" });
        this.updateProjectShot(paths.folder, shot.id, { status: "正在生成首帧" });
        const framePrompt = structuredTimeline ? shotTimeline.firstFramePrompt(shot.timeline) : String(shot.imagePrompt || "");
        const previousFirstFrameState = this.currentProjectShotArtifactState(paths.folder, shot.id);
        currentFirstImagePath = await withPaidSubmissionGate({ kind: "first-frame" }, async ({ accept, resolve } = {}) => this.withArchivedProjectArtifact({
          projectFolder: paths.folder,
          shotId: shot.id,
          kind: "first-frame",
          enabled: paths.isV6,
          restoreState: () => this.updateProjectShot(paths.folder, shot.id, previousFirstFrameState),
        }, async () => {
          const accepted = await this.generateImageMulti(image, visualStyle.applyVisualStyle(framePrompt + "\n" + continuity, context.visualStyle), referencePaths, imageModel, firstImageOutputTarget);
          await (accept || report)({ status: "submission-reserved", stage: "first-frame", paidTaskSubmitted: true });
          const savedPath = await this.saveImageCandidate(image, accepted, firstImagePath, firstImageOutputTarget);
          this.updateProjectShot(paths.folder, shot.id, {
            firstImagePath: savedPath,
            imagePath: savedPath,
            status: "首帧已完成",
          });
          await (resolve || report)({
            status: "image-processing",
            stage: "first-frame",
            paidTaskSubmitted: true,
            recoveryContext: { boundary: "first-frame", imagePath: savedPath },
          });
          return savedPath;
        }));
      }
      if (!videoTaskId && needsLastFrame && !currentLastImagePath) {
        this.assertWorkbenchQueueRunnerLock(paths.folder, context.queueId);
        await report({ status: "image-processing", stage: "last-frame" });
        this.updateProjectShot(paths.folder, shot.id, { status: "正在生成尾帧" });
        const previousLastFrameState = this.currentProjectShotArtifactState(paths.folder, shot.id);
        currentLastImagePath = await withPaidSubmissionGate({ kind: "last-frame" }, async ({ accept, resolve } = {}) => this.withArchivedProjectArtifact({
          projectFolder: paths.folder,
          shotId: shot.id,
          kind: "last-frame",
          enabled: paths.isV6,
          restoreState: () => this.updateProjectShot(paths.folder, shot.id, previousLastFrameState),
        }, async () => {
          const accepted = await this.generateImageMulti(image, visualStyle.applyVisualStyle(shot.lastImagePrompt + "\n" + continuity, context.visualStyle), referencePaths, imageModel, lastImageOutputTarget);
          await (accept || report)({ status: "submission-reserved", stage: "last-frame", paidTaskSubmitted: true });
          const savedPath = await this.saveImageCandidate(image, accepted, lastImagePath, lastImageOutputTarget);
          this.updateProjectShot(paths.folder, shot.id, { lastImagePath: savedPath, status: "尾帧已完成" });
          await (resolve || report)({
            status: "image-processing",
            stage: "last-frame",
            paidTaskSubmitted: true,
            recoveryContext: { boundary: "last-frame", imagePath: savedPath },
          });
          return savedPath;
        }));
      }

      const finishVideoTask = async (taskId, { resolveReservation = null, archiveBeforeWait = false } = {}) => {
        const previousVideoState = this.currentProjectShotArtifactState(paths.folder, shot.id);
        return this.withArchivedProjectArtifact({
          projectFolder: paths.folder,
          shotId: shot.id,
          kind: "shot-video",
          enabled: paths.isV6 && archiveBeforeWait,
          restoreState: () => this.updateProjectShot(paths.folder, shot.id, previousVideoState),
        }, async () => {
          const completed = await this.waitForVideo(video, taskId, 45 * 60 * 1000, (progress) => report({
            status: "video-processing",
            stage: "provider-generation",
            taskId,
            paidTaskSubmitted: true,
            ...progress,
          }), paths.isV6 ? videoPath : "");
          await report({
            status: "saving",
            stage: "saving",
            taskId,
            paidTaskSubmitted: true,
          });
          const savedPath = paths.isV6
            ? this.assertDurableProjectArtifact(paths.folder, videoPath)
            : this.copyVaultFile(completed.localPath, videoPath);
          this.updateProjectShot(paths.folder, shot.id, {
            generationFingerprint: fingerprint,
            videoPath: savedPath,
            status: "已完成",
            error: "",
            videoTaskStatus: "completed",
            videoTaskCompletedAt: new Date().toISOString(),
          });
          if (typeof resolveReservation === "function") {
            await resolveReservation({
              status: "saving",
              stage: "saving",
              taskId,
              paidTaskSubmitted: true,
              recoveryContext: { boundary: "video-submission", taskId, destinationPath: savedPath },
            });
          }
          return { completed, savedPath };
        });
      };

      let completedVideo;
      if (!videoTaskId) {
        this.assertWorkbenchQueueRunnerLock(paths.folder, context.queueId);
        await report({ status: "video-submitting", stage: "provider-submission", paidTaskSubmitted: false });
        this.updateProjectShot(paths.folder, shot.id, { status: "正在提交视频任务" });
        let task;
        try {
          const previousVideoState = this.currentProjectShotArtifactState(paths.folder, shot.id);
          const submitted = await withPaidSubmissionGate({ kind: "video-submission" }, async ({ accept, resolve } = {}) => this.withArchivedProjectArtifact({
            projectFolder: paths.folder,
            shotId: shot.id,
            kind: "shot-video",
            enabled: paths.isV6,
            restoreState: () => this.updateProjectShot(paths.folder, shot.id, previousVideoState),
          }, async () => {
            const accepted = await video.submitVideo(generationPolicy.buildVideoOptions({
              model,
              prompt: visualStyle.applyVisualStyle(String(shot.effectiveVideoPrompt || ""), context.visualStyle),
              duration: shot.duration,
              ratio: context.settings.ratio,
              resolution,
              firstImageFile: currentFirstImagePath ? this.localImage(currentFirstImagePath) : null,
              lastImageFile: currentLastImagePath ? this.localImage(currentLastImagePath) : null,
              referenceImageFiles: directReferenceMode ? referencePaths.map((referencePath) => this.localImage(referencePath)) : undefined,
              outputTarget: videoOutputTarget,
            }));
            const acceptedTaskId = String(accepted?.id || "").trim();
            if (!acceptedTaskId) {
              await (accept || report)({ status: "submission-reserved", stage: "provider-submission", paidTaskSubmitted: true });
              const missingTaskId = new Error("视频平台未返回任务编号，已停止等待以避免重复提交。");
              missingTaskId.paidTaskSubmitted = true;
              throw missingTaskId;
            }
            try {
              await (accept || report)({
                status: "submission-reserved",
                stage: "provider-submission",
                taskId: acceptedTaskId,
                paidTaskSubmitted: true,
                recoveryContext: { boundary: "video-submission", taskId: acceptedTaskId, accepted: true },
              });
            } catch (error) {
              error.taskId ||= acceptedTaskId;
              error.paidTaskSubmitted = true;
              throw error;
            }
            let projectTaskWriteError = null;
            try {
              this.updateProjectShot(paths.folder, shot.id, {
                status: "正在生成视频",
                videoTaskId: acceptedTaskId,
                videoTaskFingerprint: fingerprint,
                videoTaskPlanId: context.planId,
                videoTaskModel: model,
                videoTaskSubmittedAt: new Date().toISOString(),
                videoTaskStatus: "processing",
              });
            } catch (error) {
              projectTaskWriteError = error;
            }
            if (projectTaskWriteError) {
              projectTaskWriteError.taskId ||= acceptedTaskId;
              projectTaskWriteError.paidTaskSubmitted = true;
              throw projectTaskWriteError;
            }
            const completion = await finishVideoTask(acceptedTaskId, {
              resolveReservation: resolve || report,
              archiveBeforeWait: false,
            });
            return { accepted, ...completion };
          }));
          task = submitted.accepted;
          completedVideo = submitted;
        } catch (error) {
          throw this.generationModelError("video", model, error);
        }
        videoTaskId = String(task?.id || "").trim();
      } else {
        this.updateProjectShot(paths.folder, shot.id, { status: "正在恢复并查询已有视频任务", videoTaskStatus: "processing" });
        await report({
          status: "video-processing",
          stage: "provider-generation",
          taskId: videoTaskId,
          paidTaskSubmitted: true,
        });
      }
      if (!completedVideo) {
        try {
          const persistedVideoTask = (video.settings?.videoTasks || []).find((item) => String(item.id) === String(videoTaskId));
          const targetAlreadySaved = paths.isV6
            && persistedVideoTask?.status === "completed"
            && persistedVideoTask?.localPath === videoPath
            && this.projectFileExists(paths.folder, videoPath);
          completedVideo = await finishVideoTask(videoTaskId, {
            archiveBeforeWait: paths.isV6 && !targetAlreadySaved,
          });
        } catch (error) {
          throw this.generationModelError("video", model, error);
        }
      }
      const savedVideoPath = completedVideo.savedPath;
      return {
        videoPath: savedVideoPath,
        firstImagePath: currentFirstImagePath,
        ...(currentLastImagePath ? { lastImagePath: currentLastImagePath } : {}),
      };
    } catch (error) {
      const message = String(error?.message || error);
      const terminalTaskFailure = error?.terminalTaskFailure === true || error?.code === "VIDEO_TASK_FAILED";
      this.updateProjectShot(paths.folder, shot.id, {
        status: "失败",
        error: message,
        ...(videoTaskId ? {
          videoTaskStatus: terminalTaskFailure ? "failed" : "unknown",
          ...(terminalTaskFailure ? {
            failedVideoTaskId: String(videoTaskId),
            failedVideoTaskPlanId: String(context.planId || ""),
            failedVideoTaskError: message,
            failedVideoTaskAt: new Date().toISOString(),
            videoTaskId: "",
            videoTaskFingerprint: "",
            videoTaskPlanId: "",
          } : {}),
        } : {}),
      });
      throw error;
    }
  }

  async runAssetGeneration(projectFolder, request, requestMtimeMs, { image, video, imageModel, model }) {
    this.assertGenerationActive(projectFolder, requestMtimeMs);
    const projectPath = this.checkedProjectPath(projectFolder, "project.json");
    const project = this.readJson(projectPath);
    const previousShots = new Map((Array.isArray(project.shots) ? project.shots : []).map((shot) => [String(shot.id), shot]));
    const sceneRequestsById = new Map((request.scenes || []).map((scene) => [String(scene.id), scene]));
    const productRequestsById = new Map((request.products || []).map((product) => [String(product.id), product]));
    const effectiveResolution = String(request.settings.resolution || video.settings.resolution || "").trim();
    const state = { status: "processing", requestMtimeMs, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentStep: "人物资产" };
    this.writeState(projectFolder, state);
    project.status = "generating";
    project.statusText = "正在准备人物和场景资产";
    project.imageModel = imageModel;
    project.videoModel = model;
    project.finalVideoPath = "";
    delete project.concatError;
    project.characterAsset = null;
    project.productAssets = [];
    project.sceneAssets = [];
    this.saveProject(projectFolder, project);

    this.assertGenerationActive(projectFolder, requestMtimeMs);
    const character = await this.ensureReferenceAsset(
      image,
      referenceAssets.resolveCharacterAsset(this.vaultPath(), request.character.id),
      request.character.prompt,
      imageModel,
      request.visualStyle,
    );
    project.characterAsset = {
      id: character.id,
      imagePath: character.imagePath,
      metadataPath: character.metadataPath,
      contentHash: referenceAssets.hashAssetImage(this.vaultPath(), character),
      reused: character.reused,
    };
    this.saveProject(projectFolder, project);

    for (const product of request.products || []) {
      this.assertGenerationActive(projectFolder, requestMtimeMs);
      state.currentStep = `产品资产 ${product.id}`;
      state.updatedAt = new Date().toISOString();
      this.writeState(projectFolder, state);
      const resolved = await this.ensureReferenceAsset(
        image,
        referenceAssets.resolveProductAsset(this.vaultPath(), product.id),
        product.prompt,
        imageModel,
        request.visualStyle,
      );
      project.productAssets.push({
        id: resolved.id,
        imagePath: resolved.imagePath,
        metadataPath: resolved.metadataPath,
        contentHash: referenceAssets.hashAssetImage(this.vaultPath(), resolved),
        reused: resolved.reused,
      });
      this.saveProject(projectFolder, project);
    }

    for (const scene of request.scenes) {
      this.assertGenerationActive(projectFolder, requestMtimeMs);
      state.currentStep = `场景资产 ${scene.id}`;
      state.updatedAt = new Date().toISOString();
      this.writeState(projectFolder, state);
      const resolved = await this.ensureReferenceAsset(
        image,
        referenceAssets.resolveSceneAsset(this.vaultPath(), scene.id),
        scene.prompt,
        imageModel,
        request.visualStyle,
      );
      project.sceneAssets.push({
        id: resolved.id,
        imagePath: resolved.imagePath,
        metadataPath: resolved.metadataPath,
        contentHash: referenceAssets.hashAssetImage(this.vaultPath(), resolved),
        reused: resolved.reused,
      });
      this.saveProject(projectFolder, project);
    }

    const sceneAssetsById = new Map(project.sceneAssets.map((asset) => [asset.id, asset]));
    const productAssetsById = new Map(project.productAssets.map((asset) => [asset.id, asset]));
    project.shots = request.shots.map((shot) => {
      const previous = previousShots.get(String(shot.id));
      const requirements = generationPolicy.referenceRequirements(model, shot.lastImagePrompt);
      const sceneRequest = sceneRequestsById.get(String(shot.sceneId)) || { id: shot.sceneId, prompt: "" };
      const sceneAsset = sceneAssetsById.get(String(shot.sceneId));
      if (!sceneAsset) throw new Error(`镜头 ${shot.id} 找不到场景资产：${shot.sceneId}`);
      const shotProducts = (shot.productIds || []).map((productId) => {
        const productRequest = productRequestsById.get(String(productId));
        const productAsset = productAssetsById.get(String(productId));
        if (!productRequest || !productAsset) throw new Error(`镜头 ${shot.id} 找不到产品资产：${productId}`);
        return { ...productRequest, contentHash: productAsset.contentHash };
      });
      const generationFingerprint = generationPolicy.createGenerationFingerprint({
        requestVersion: request.version,
        visualStyle: request.visualStyle,
        character: { ...request.character, contentHash: project.characterAsset.contentHash },
        scene: { ...sceneRequest, contentHash: sceneAsset.contentHash },
        products: shotProducts,
        shot,
        model,
        ratio: request.settings.ratio,
        resolution: effectiveResolution,
      });
      const sameGeneration = previous?.generationFingerprint === generationFingerprint;
      const firstImagePath = `${projectFolder}/02-分镜脚本/镜头-${shot.id}-${core.safeSegment(shot.title)}-首帧.png`;
      const lastImagePath = shot.lastImagePrompt
        ? `${projectFolder}/02-分镜脚本/镜头-${shot.id}-${core.safeSegment(shot.title)}-尾帧.png`
        : "";
      const videoPath = `${projectFolder}/03-视频片段/镜头-${shot.id}-${core.safeSegment(shot.title)}.mp4`;
      const reusable = (candidate, expected) => Boolean(
        expected
        && candidate === expected
        && fs.statSync(this.checkedProjectPath(projectFolder, expected), { throwIfNoEntry: false })?.isFile()
      );
      const reusableFirst = sameGeneration && reusable(previous.firstImagePath || previous.imagePath, firstImagePath) ? firstImagePath : "";
      const reusableLast = sameGeneration && reusable(previous.lastImagePath, lastImagePath) ? lastImagePath : "";
      const mandatoryArtifactsExist = (!requirements.firstImage || Boolean(reusableFirst))
        && (!requirements.lastImage || Boolean(reusableLast));
      const reusableVideo = sameGeneration && mandatoryArtifactsExist && reusable(previous.videoPath, videoPath) ? videoPath : "";
      return {
        ...shot,
        generationFingerprint,
        status: reusableVideo ? "已完成" : "等待生成",
        imagePath: reusableFirst,
        firstImagePath: reusableFirst,
        lastImagePath: reusableLast,
        videoPath: reusableVideo,
        error: "",
      };
    });
    project.statusText = "人物和场景资产已准备，正在生成镜头";
    this.saveProject(projectFolder, project);

    for (const shot of project.shots) {
      this.assertGenerationActive(projectFolder, requestMtimeMs);
      state.currentStep = `镜头 ${shot.id}`;
      state.updatedAt = new Date().toISOString();
      this.writeState(projectFolder, state);
      if (shot.videoPath) continue;
      shot.status = shot.firstImagePath ? "复用已有首帧" : "正在生成首帧";
      this.saveProject(projectFolder, project);
      try {
        this.assertGenerationActive(projectFolder, requestMtimeMs);
        const sceneAsset = sceneAssetsById.get(shot.sceneId);
        if (!sceneAsset) throw new Error(`镜头 ${shot.id} 找不到场景资产：${shot.sceneId}`);
        const shotProductAssets = (shot.productIds || []).map((productId) => {
          const asset = productAssetsById.get(productId);
          if (!asset) throw new Error(`镜头 ${shot.id} 找不到产品资产：${productId}`);
          return asset;
        });
        const referencePaths = [
          project.characterAsset.imagePath,
          sceneAsset.imagePath,
          ...shotProductAssets.map((asset) => asset.imagePath),
        ];
        const continuity = [
          "参考图1是人物设定板：人物身份、脸部、发型、发色、年龄与服装必须严格一致。",
          "参考图2是纯环境场景板：只参考空间、固定陈设、光线、天气与环境质感，不得从中创造人物或核心产品。",
          ...shotProductAssets.map((asset, index) => `参考图${index + 3}是产品设定板（${asset.id}）：产品外形、颜色、材质、比例、包装和标识位置必须严格一致。`),
          shotProductAssets.length
            ? "将参考图1中的人物和产品设定板中的产品自然放入参考图2的环境，保持全片人物、产品与场景连续。"
            : "将参考图1中的人物自然放入参考图2的环境，保持全片人物与场景连续。",
        ].join("\n");
        const firstPrompt = visualStyle.applyVisualStyle(`${shot.imagePrompt}\n${continuity}`, request.visualStyle);
        if (!shot.firstImagePath) {
          this.assertGenerationActive(projectFolder, requestMtimeMs);
          const firstCandidate = await this.generateImageMulti(image, firstPrompt, referencePaths, imageModel);
          shot.firstImagePath = await this.saveImageCandidate(
            image,
            firstCandidate,
            `${projectFolder}/02-分镜脚本/镜头-${shot.id}-${core.safeSegment(shot.title)}-首帧.png`,
          );
        }
        shot.imagePath = shot.firstImagePath;

        if (shot.lastImagePrompt && !shot.lastImagePath) {
          this.assertGenerationActive(projectFolder, requestMtimeMs);
          shot.status = "正在生成尾帧";
          this.saveProject(projectFolder, project);
          const lastCandidate = await this.generateImageMulti(image, visualStyle.applyVisualStyle(`${shot.lastImagePrompt}\n${continuity}`, request.visualStyle), referencePaths, imageModel);
          shot.lastImagePath = await this.saveImageCandidate(
            image,
            lastCandidate,
            `${projectFolder}/02-分镜脚本/镜头-${shot.id}-${core.safeSegment(shot.title)}-尾帧.png`,
          );
        }

        shot.status = "正在生成视频";
        this.saveProject(projectFolder, project);
        this.assertGenerationActive(projectFolder, requestMtimeMs);
        let task;
        let completed;
        try {
          task = await video.submitVideo(generationPolicy.buildVideoOptions({
            model,
            prompt: generationPolicy.composeVideoPrompt({
              videoPrompt: shot.videoPrompt,
              dialogue: shot.dialogue,
              voiceProfile: request.character.voiceProfile,
              voiceDirection: shot.voiceDirection,
              visualStyle: request.visualStyle,
            }),
            duration: shot.duration,
            ratio: request.settings.ratio,
            resolution: effectiveResolution,
            firstImageFile: this.localImage(shot.firstImagePath),
            lastImageFile: shot.lastImagePath ? this.localImage(shot.lastImagePath) : null,
          }));
          completed = await this.waitForVideo(video, task.id);
        } catch (error) {
          throw this.generationModelError("video", model, error);
        }
        shot.videoPath = this.copyVaultFile(completed.localPath, `${projectFolder}/03-视频片段/镜头-${shot.id}-${core.safeSegment(shot.title)}.mp4`);
        shot.status = "已完成";
      } catch (error) {
        if (error?.code === GENERATION_STOPPED_CODE) throw error;
        if (error?.changeModel === true) throw error;
        shot.status = "失败";
        shot.error = String(error?.message || error);
      }
      this.saveProject(projectFolder, project);
    }

    const failed = project.shots.filter((shot) => shot.status === "失败").length;
    await this.finalizeProject(projectFolder, project, failed);
    Object.assign(state, { status: project.status, currentStep: "完成", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), failedShots: failed });
    this.writeState(projectFolder, state);
    await this.openVaultPath(`${projectFolder}/00-项目总览.md`);
  }

  async runGeneration(projectFolder, request, requestMtimeMs) {
    this.assertGenerationActive(projectFolder, requestMtimeMs);
    this.checkedProjectPath(projectFolder, "project.json");
    this.checkedProjectPath(projectFolder, REQUEST_FILE);
    for (const directory of ["01-人物参考", "02-分镜脚本", "03-视频片段", "04-最终成片", ".work"]) {
      this.checkedProjectPath(projectFolder, directory, { createParents: true, directory: true });
    }
    const { image, video } = this.getGenerationPlugins();
    const [imageAccess, access] = await Promise.all([image.refreshAgentAccess(), video.refreshAgentAccess()]);
    const imageModels = Object.keys(imageAccess?.imageModelKeys || {});
    const requestedImageModel = String(request.settings.imageModel || this.settings?.imageModel || image.settings.model || "").trim();
    const imageModel = imageModels.find((candidate) => candidate === requestedImageModel)
      || imageModels.find((candidate) => candidate.toLowerCase() === requestedImageModel.toLowerCase());
    if (!imageModel) throw this.unavailableGenerationModel("image", requestedImageModel, imageModels);
    const models = generationPolicy.eligibleModels(Object.keys(access?.videoModelKeys || {}));
    const requestedModel = String(request.settings.videoModel || video.settings.model || "").trim();
    const model = models.find((candidate) => candidate === requestedModel)
      || models.find((candidate) => candidate.toLowerCase() === requestedModel.toLowerCase());
    if (!model) {
      throw this.unavailableGenerationModel("video", requestedModel, models);
    }
    if (request.version >= 2) return this.runAssetGeneration(projectFolder, request, requestMtimeMs, { image, video, imageModel, model });
    const projectPath = this.checkedProjectPath(projectFolder, "project.json");
    const project = this.readJson(projectPath);
    const state = { status: "processing", requestMtimeMs, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentStep: "人物三视图" };
    this.writeState(projectFolder, state);
    project.status = "generating";
    project.statusText = "正在生成人物三视图";
    project.imageModel = imageModel;
    project.videoModel = model;
    project.finalVideoPath = "";
    delete project.concatError;
    project.shots = request.shots.map((shot) => ({ ...shot, status: "等待生成", imagePath: "", videoPath: "", error: "" }));
    this.saveProject(projectFolder, project);

    this.assertGenerationActive(projectFolder, requestMtimeMs);
    const characterCandidate = await this.generateImage(image, visualStyle.applyVisualStyle(request.character.prompt, request.visualStyle), "", imageModel);
    project.characterImagePath = await this.saveImageCandidate(image, characterCandidate, `${projectFolder}/01-人物参考/人物三视图.png`);
    project.statusText = "人物参考完成，正在生成分镜";
    this.saveProject(projectFolder, project);

    for (const shot of project.shots) {
      this.assertGenerationActive(projectFolder, requestMtimeMs);
      state.currentStep = `镜头 ${shot.id}`;
      state.updatedAt = new Date().toISOString();
      this.writeState(projectFolder, state);
      shot.status = "正在生成参考图";
      this.saveProject(projectFolder, project);
      try {
        this.assertGenerationActive(projectFolder, requestMtimeMs);
        const imagePrompt = visualStyle.applyVisualStyle(`${shot.imagePrompt}\n保持参考人物的脸部、发型、服装和年龄一致。`, request.visualStyle);
        const shotCandidate = await this.generateImage(image, imagePrompt, project.characterImagePath, imageModel);
        shot.imagePath = await this.saveImageCandidate(image, shotCandidate, `${projectFolder}/02-分镜脚本/镜头-${shot.id}-${core.safeSegment(shot.title)}.png`);
        shot.status = "正在生成视频";
        this.saveProject(projectFolder, project);
        this.assertGenerationActive(projectFolder, requestMtimeMs);
        let task;
        let completed;
        try {
          task = await video.submitVideo(generationPolicy.buildVideoOptions({
            model,
            prompt: generationPolicy.composeVideoPrompt({
              videoPrompt: shot.videoPrompt,
              dialogue: shot.dialogue,
              voiceProfile: request.character.voiceProfile,
              voiceDirection: shot.voiceDirection,
              visualStyle: request.visualStyle,
            }),
            duration: shot.duration,
            ratio: request.settings.ratio,
            resolution: request.settings.resolution || video.settings.resolution,
            firstImageFile: this.localImage(shot.imagePath),
          }));
          completed = await this.waitForVideo(video, task.id);
        } catch (error) {
          throw this.generationModelError("video", model, error);
        }
        shot.videoPath = this.copyVaultFile(completed.localPath, `${projectFolder}/03-视频片段/镜头-${shot.id}-${core.safeSegment(shot.title)}.mp4`);
        shot.status = "已完成";
      } catch (error) {
        if (error?.code === GENERATION_STOPPED_CODE) throw error;
        if (error?.changeModel === true) throw error;
        shot.status = "失败";
        shot.error = String(error?.message || error);
      }
      this.saveProject(projectFolder, project);
    }

    const failed = project.shots.filter((shot) => shot.status === "失败").length;
    await this.finalizeProject(projectFolder, project, failed);
    Object.assign(state, { status: project.status, currentStep: "完成", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), failedShots: failed });
    this.writeState(projectFolder, state);
    await this.openVaultPath(`${projectFolder}/00-项目总览.md`);
  }
};
