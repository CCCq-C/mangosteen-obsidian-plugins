const { Modal, Notice, Plugin, requestUrl } = require("obsidian");
const fs = require("fs");
const path = require("path");

let core;
let workflow;

const ROOT = "山竹视频复刻";
const REQUEST_FILE = "generation-request.json";
const STATE_FILE = ".work/generation-state.json";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}

function writeJson(filePath, value) { atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`); }

class PrepareModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.sourcePath = ""; }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mangosteen-replica-modal");
    contentEl.createEl("h2", { text: "新建视频复刻项目" });
    contentEl.createEl("p", { text: "选择 3 分钟以内的 MP4、MOV 或 M4V。处理在本机完成，不上传整条源视频。" });
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
        status.setText("本地拆解完成，正在打开项目总览。");
        await this.plugin.openVaultPath(`${project.folder}/00-项目总览.md`);
        new Notice("视频拆解完成。请在山竹对话中继续分析分镜。", 7000);
        this.close();
      } catch (error) {
        status.setText(`失败：${String(error?.message || error)}`);
        new Notice(String(error?.message || error), 9000);
      } finally { button.disabled = false; }
    });
  }
}

module.exports = class MangosteenVideoReplicaPlugin extends Plugin {
  async onload() {
    const pluginRoot = path.join(this.vaultPath(), ...String(this.manifest.dir || "").split(/[\\/]/).filter(Boolean));
    core = require(path.join(pluginRoot, "replica-core.cjs"));
    workflow = require(path.join(pluginRoot, "replica-cli.cjs"));
    this.pluginRoot = pluginRoot;
    this.processing = new Set();
    this.addRibbonIcon("clapperboard", "山竹视频复刻", () => new PrepareModal(this).open());
    this.addCommand({ id: "prepare-local-video", name: "从本地视频新建复刻项目", callback: () => new PrepareModal(this).open() });
    this.addCommand({ id: "scan-generation-requests", name: "检查已确认的视频复刻任务", callback: () => void this.scanRequests(true) });
    this.registerInterval(window.setInterval(() => void this.scanRequests(false), 5000));
    this.registerEvent(this.app.vault.on("create", (file) => { if (file?.name === REQUEST_FILE) void this.processRequestByVaultPath(file.path, true); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (file?.name === REQUEST_FILE) void this.processRequestByVaultPath(file.path, true); }));
    window.setTimeout(() => void this.scanRequests(false), 1500);
  }

  vaultPath() {
    const adapter = this.app.vault.adapter;
    const base = adapter?.getBasePath?.() || adapter?.basePath;
    if (!base) throw new Error("无法定位当前 Obsidian 知识库。");
    return base;
  }

  absolute(vaultPath) { return path.join(this.vaultPath(), ...String(vaultPath).replace(/\\/g, "/").split("/")); }

  async prepareVideo(sourcePath) {
    return workflow.prepareProject({ sourcePath, vaultPath: this.vaultPath(), pluginRoot: this.pluginRoot });
  }

  async openVaultPath(vaultPath) {
    for (let index = 0; index < 25; index += 1) {
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (file) { await this.app.workspace.getLeaf(true).openFile(file); return true; }
      await sleep(200);
    }
    new Notice(`文件已生成：${vaultPath}`, 6000);
    return false;
  }

  findRequestFiles() {
    const root = this.absolute(ROOT);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, REQUEST_FILE))
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
    const absoluteFolder = this.absolute(projectFolder);
    writeJson(path.join(absoluteFolder, "project.json"), project);
    atomicWrite(path.join(absoluteFolder, "00-项目总览.md"), core.dashboardMarkdown(project));
  }

  writeState(projectFolder, state) { writeJson(path.join(this.absolute(projectFolder), STATE_FILE), state); }

  requestAlreadyHandled(projectFolder, requestMtimeMs) {
    const statePath = path.join(this.absolute(projectFolder), STATE_FILE);
    if (!fs.existsSync(statePath)) return false;
    try {
      const state = this.readJson(statePath);
      return Number(state.requestMtimeMs) === Number(requestMtimeMs) && ["processing", "completed", "completed_with_errors", "failed"].includes(state.status);
    } catch (_) { return false; }
  }

  async processRequest(requestPath, notify = false) {
    if (this.processing.has(requestPath)) return;
    let projectFolder;
    let requestMtimeMs = null;
    try {
      const root = this.absolute(ROOT);
      const relative = path.relative(root, path.dirname(requestPath));
      projectFolder = core.normalizeVaultPath(`${ROOT}/${relative.replace(/\\/g, "/")}`);
      const stat = fs.statSync(requestPath);
      requestMtimeMs = stat.mtimeMs;
      if (this.requestAlreadyHandled(projectFolder, requestMtimeMs)) return;
      const request = core.normalizeGenerationRequest(this.readJson(requestPath));
      this.processing.add(requestPath);
      await this.runGeneration(projectFolder, request, requestMtimeMs);
      if (notify) new Notice("视频复刻任务已经全部处理完成。", 7000);
    } catch (error) {
      if (projectFolder) {
        const state = { status: "failed", requestMtimeMs, updatedAt: new Date().toISOString(), error: String(error?.message || error) };
        this.writeState(projectFolder, state);
        try {
          const project = this.readJson(path.join(this.absolute(projectFolder), "project.json"));
          project.status = "failed";
          project.statusText = `生成失败：${state.error}`;
          this.saveProject(projectFolder, project);
        } catch (_) {}
      }
      if (notify) new Notice(`视频复刻失败：${String(error?.message || error)}`, 10000);
    } finally { this.processing.delete(requestPath); }
  }

  getGenerationPlugins() {
    const image = this.app.plugins.getPlugin("mangosteen-image");
    const video = this.app.plugins.getPlugin("mangosteen-video");
    if (!image?.generateText || !image?.generateEdit) throw new Error("山竹生图插件未启用或版本不兼容。");
    if (!video?.submitVideo || !video?.refreshVideoTasks) throw new Error("山竹视频插件未启用或版本不兼容。");
    return { image, video };
  }

  async saveImageCandidate(imagePlugin, candidate, vaultPath) {
    let bytes;
    if (candidate?.kind === "base64") bytes = Buffer.from(candidate.value, "base64");
    else if (candidate?.kind === "url") {
      const response = await requestUrl({ url: candidate.value, method: "GET", throw: false });
      if (response.status >= 400 || !response.arrayBuffer) throw new Error("图片已生成，但下载失败。");
      imagePlugin.api?.assertImageDownloadSize?.(response);
      bytes = Buffer.from(response.arrayBuffer);
    } else throw new Error("生图接口没有返回可保存的图片。");
    const absolutePath = this.absolute(vaultPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    atomicWrite(absolutePath, bytes);
    return vaultPath;
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

  async generateImage(imagePlugin, prompt, referencePath = "") {
    const response = referencePath
      ? await imagePlugin.generateEdit(prompt, this.localImage(referencePath))
      : await imagePlugin.generateText(prompt, 1);
    const candidate = imagePlugin.extractResults(response)?.[0];
    if (!candidate) throw new Error("生图任务完成，但没有返回图片。");
    return candidate;
  }

  async waitForVideo(videoPlugin, taskId, timeoutMs = 45 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await videoPlugin.refreshVideoTasks();
      const task = (videoPlugin.settings.videoTasks || []).find((item) => item.id === taskId);
      if (task?.status === "completed" && task.localPath) return task;
      if (task?.status === "failed") throw new Error(task.lastError || "视频生成失败。");
      await sleep(7000);
    }
    throw new Error("视频任务等待超过 45 分钟。任务仍保留在山竹视频中，可稍后继续查看。");
  }

  copyVaultFile(sourceVaultPath, targetVaultPath) {
    const source = this.absolute(sourceVaultPath);
    const target = this.absolute(targetVaultPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return targetVaultPath;
  }

  async runGeneration(projectFolder, request, requestMtimeMs) {
    const { image, video } = this.getGenerationPlugins();
    const projectPath = path.join(this.absolute(projectFolder), "project.json");
    const project = this.readJson(projectPath);
    const state = { status: "processing", requestMtimeMs, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentStep: "人物三视图" };
    this.writeState(projectFolder, state);
    project.status = "generating";
    project.statusText = "正在生成人物三视图";
    project.shots = request.shots.map((shot) => ({ ...shot, status: "等待生成", imagePath: "", videoPath: "", error: "" }));
    this.saveProject(projectFolder, project);

    const characterCandidate = await this.generateImage(image, request.character.prompt);
    project.characterImagePath = await this.saveImageCandidate(image, characterCandidate, `${projectFolder}/01-人物参考/人物三视图.png`);
    project.statusText = "人物参考完成，正在生成分镜";
    this.saveProject(projectFolder, project);

    for (const shot of project.shots) {
      state.currentStep = `镜头 ${shot.id}`;
      state.updatedAt = new Date().toISOString();
      this.writeState(projectFolder, state);
      shot.status = "正在生成参考图";
      this.saveProject(projectFolder, project);
      try {
        const imagePrompt = `${shot.imagePrompt}\n保持参考人物的脸部、发型、服装和年龄一致。`;
        const shotCandidate = await this.generateImage(image, imagePrompt, project.characterImagePath);
        shot.imagePath = await this.saveImageCandidate(image, shotCandidate, `${projectFolder}/02-分镜脚本/镜头-${shot.id}-${core.safeSegment(shot.title)}.png`);
        shot.status = "正在生成视频";
        this.saveProject(projectFolder, project);
        const model = request.settings.videoModel || video.settings.model;
        const task = await video.submitVideo({
          model,
          prompt: shot.videoPrompt,
          duration: shot.duration,
          ratio: request.settings.ratio,
          resolution: request.settings.resolution || video.settings.resolution,
          firstImageFile: this.localImage(shot.imagePath),
        });
        const completed = await this.waitForVideo(video, task.id);
        shot.videoPath = this.copyVaultFile(completed.localPath, `${projectFolder}/03-视频片段/镜头-${shot.id}-${core.safeSegment(shot.title)}.mp4`);
        shot.status = "已完成";
      } catch (error) {
        shot.status = "失败";
        shot.error = String(error?.message || error);
      }
      this.saveProject(projectFolder, project);
    }

    const failed = project.shots.filter((shot) => shot.status === "失败").length;
    project.status = failed ? "completed_with_errors" : "completed";
    project.statusText = failed ? `已完成，${failed} 个镜头需要重试` : "人物、分镜图和视频片段已全部生成";
    this.saveProject(projectFolder, project);
    Object.assign(state, { status: project.status, currentStep: "完成", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), failedShots: failed });
    this.writeState(projectFolder, state);
    await this.openVaultPath(`${projectFolder}/00-项目总览.md`);
  }
};
