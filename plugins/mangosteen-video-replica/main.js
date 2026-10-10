const { Modal, Notice, Plugin, requestUrl } = require("obsidian");
const fs = require("fs");
const path = require("path");

let core;
let generationPolicy;
let referenceAssets;
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
    generationPolicy = require(path.join(pluginRoot, "generation-policy.cjs"));
    referenceAssets = require(path.join(pluginRoot, "reference-assets.cjs"));
    workflow = require(path.join(pluginRoot, "replica-cli.cjs"));
    this.pluginRoot = pluginRoot;
    this.processing = new Set();
    this.referenceAssetPromises = new Map();
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

  absolute(vaultPath) {
    const normalized = String(vaultPath).replace(/\\/g, "/");
    if (normalized.startsWith("山竹视频资产库/")) return referenceAssets.checkedAssetPath(this.vaultPath(), normalized);
    return path.join(this.vaultPath(), ...normalized.split("/"));
  }

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
    if (!video?.submitVideo || !video?.refreshVideoTasks || !video?.refreshAgentAccess) throw new Error("山竹视频插件未启用或版本不兼容。");
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

  async generateImageMulti(imagePlugin, prompt, referencePaths) {
    if (typeof imagePlugin.generateEditMulti !== "function") throw new Error("山竹生图插件版本过低，缺少多图参考能力。请先更新插件。");
    const response = await imagePlugin.generateEditMulti(prompt, referencePaths.map((vaultPath) => this.localImage(vaultPath)));
    const candidate = imagePlugin.extractResults(response)?.[0];
    if (!candidate) throw new Error("多图参考生图完成，但没有返回图片。");
    return candidate;
  }

  async ensureReferenceAsset(imagePlugin, asset, prompt) {
    this.referenceAssetPromises ||= new Map();
    const key = `${asset.kind}:${asset.id}`;
    const pending = this.referenceAssetPromises.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const current = asset.kind === "character"
        ? referenceAssets.resolveCharacterAsset(this.vaultPath(), asset.id)
        : referenceAssets.resolveSceneAsset(this.vaultPath(), asset.id);
      if (current.exists) return { ...current, reused: true };
      const candidate = await this.generateImage(imagePlugin, prompt);
      await this.saveImageCandidate(imagePlugin, candidate, current.imagePath);
      referenceAssets.writeAssetMetadata(this.vaultPath(), current, {
        prompt,
        createdAt: new Date().toISOString(),
      });
      const refreshed = current.kind === "character"
        ? referenceAssets.resolveCharacterAsset(this.vaultPath(), current.id)
        : referenceAssets.resolveSceneAsset(this.vaultPath(), current.id);
      return { ...refreshed, reused: false };
    })();
    this.referenceAssetPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.referenceAssetPromises.get(key) === promise) this.referenceAssetPromises.delete(key);
    }
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

  async runAssetGeneration(projectFolder, request, requestMtimeMs, { image, video, model }) {
    const projectPath = path.join(this.absolute(projectFolder), "project.json");
    const project = this.readJson(projectPath);
    const previousShots = new Map((Array.isArray(project.shots) ? project.shots : []).map((shot) => [String(shot.id), shot]));
    const sceneRequestsById = new Map((request.scenes || []).map((scene) => [String(scene.id), scene]));
    const effectiveResolution = String(request.settings.resolution || video.settings.resolution || "").trim();
    const state = { status: "processing", requestMtimeMs, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentStep: "人物资产" };
    this.writeState(projectFolder, state);
    project.status = "generating";
    project.statusText = "正在准备人物和场景资产";
    project.videoModel = model;
    project.characterAsset = null;
    project.sceneAssets = [];
    project.shots = request.shots.map((shot) => {
      const previous = previousShots.get(String(shot.id));
      const requirements = generationPolicy.referenceRequirements(model, shot.lastImagePrompt);
      const generationFingerprint = generationPolicy.createGenerationFingerprint({
        character: request.character,
        scene: sceneRequestsById.get(String(shot.sceneId)) || { id: shot.sceneId, prompt: "" },
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
        && fs.statSync(this.absolute(expected), { throwIfNoEntry: false })?.isFile()
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
    this.saveProject(projectFolder, project);

    const character = await this.ensureReferenceAsset(
      image,
      referenceAssets.resolveCharacterAsset(this.vaultPath(), request.character.id),
      request.character.prompt,
    );
    project.characterAsset = {
      id: character.id,
      imagePath: character.imagePath,
      metadataPath: character.metadataPath,
      reused: character.reused,
    };
    this.saveProject(projectFolder, project);

    for (const scene of request.scenes) {
      state.currentStep = `场景资产 ${scene.id}`;
      state.updatedAt = new Date().toISOString();
      this.writeState(projectFolder, state);
      const resolved = await this.ensureReferenceAsset(
        image,
        referenceAssets.resolveSceneAsset(this.vaultPath(), scene.id),
        scene.prompt,
      );
      project.sceneAssets.push({
        id: resolved.id,
        imagePath: resolved.imagePath,
        metadataPath: resolved.metadataPath,
        reused: resolved.reused,
      });
      this.saveProject(projectFolder, project);
    }

    const sceneAssetsById = new Map(project.sceneAssets.map((asset) => [asset.id, asset]));
    project.statusText = "人物和场景资产已准备，正在生成镜头";
    this.saveProject(projectFolder, project);

    for (const shot of project.shots) {
      state.currentStep = `镜头 ${shot.id}`;
      state.updatedAt = new Date().toISOString();
      this.writeState(projectFolder, state);
      if (shot.videoPath) continue;
      shot.status = shot.firstImagePath ? "复用已有首帧" : "正在生成首帧";
      this.saveProject(projectFolder, project);
      try {
        const sceneAsset = sceneAssetsById.get(shot.sceneId);
        if (!sceneAsset) throw new Error(`镜头 ${shot.id} 找不到场景资产：${shot.sceneId}`);
        const referencePaths = [project.characterAsset.imagePath, sceneAsset.imagePath];
        const continuity = "保持参考人物的脸部、发型、服装和年龄一致，并保持场景一致。";
        const firstPrompt = `${shot.imagePrompt}\n${continuity}`;
        if (!shot.firstImagePath) {
          const firstCandidate = await this.generateImageMulti(image, firstPrompt, referencePaths);
          shot.firstImagePath = await this.saveImageCandidate(
            image,
            firstCandidate,
            `${projectFolder}/02-分镜脚本/镜头-${shot.id}-${core.safeSegment(shot.title)}-首帧.png`,
          );
        }
        shot.imagePath = shot.firstImagePath;

        if (shot.lastImagePrompt && !shot.lastImagePath) {
          shot.status = "正在生成尾帧";
          this.saveProject(projectFolder, project);
          const lastCandidate = await this.generateImageMulti(image, `${shot.lastImagePrompt}\n${continuity}`, referencePaths);
          shot.lastImagePath = await this.saveImageCandidate(
            image,
            lastCandidate,
            `${projectFolder}/02-分镜脚本/镜头-${shot.id}-${core.safeSegment(shot.title)}-尾帧.png`,
          );
        }

        shot.status = "正在生成视频";
        this.saveProject(projectFolder, project);
        const task = await video.submitVideo(generationPolicy.buildVideoOptions({
          model,
          prompt: shot.videoPrompt,
          duration: shot.duration,
          ratio: request.settings.ratio,
          resolution: effectiveResolution,
          firstImageFile: this.localImage(shot.firstImagePath),
          lastImageFile: shot.lastImagePath ? this.localImage(shot.lastImagePath) : null,
        }));
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
    project.statusText = failed ? `已完成，${failed} 个镜头需要重试` : "人物、场景、关键帧和视频片段已全部生成";
    this.saveProject(projectFolder, project);
    Object.assign(state, { status: project.status, currentStep: "完成", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), failedShots: failed });
    this.writeState(projectFolder, state);
    await this.openVaultPath(`${projectFolder}/00-项目总览.md`);
  }

  async runGeneration(projectFolder, request, requestMtimeMs) {
    const { image, video } = this.getGenerationPlugins();
    const access = await video.refreshAgentAccess();
    const models = generationPolicy.eligibleModels(Object.keys(access?.videoModelKeys || {}));
    const requestedModel = String(request.settings.videoModel || video.settings.model || "").trim();
    const model = models.find((candidate) => candidate === requestedModel)
      || models.find((candidate) => candidate.toLowerCase() === requestedModel.toLowerCase());
    if (!model) {
      const detail = models.length ? `当前可用：${models.join("、")}` : "当前账号没有可用的 MiniMax-H3 或 Seedance 模型";
      throw new Error(`视频复刻不能使用模型“${requestedModel || "未选择"}”。${detail}，请刷新山竹账号中心或选择已开通模型。`);
    }
    if (request.version === 2) return this.runAssetGeneration(projectFolder, request, requestMtimeMs, { image, video, model });
    const projectPath = path.join(this.absolute(projectFolder), "project.json");
    const project = this.readJson(projectPath);
    const state = { status: "processing", requestMtimeMs, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentStep: "人物三视图" };
    this.writeState(projectFolder, state);
    project.status = "generating";
    project.statusText = "正在生成人物三视图";
    project.videoModel = model;
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
        const task = await video.submitVideo(generationPolicy.buildVideoOptions({
          model,
          prompt: shot.videoPrompt,
          duration: shot.duration,
          ratio: request.settings.ratio,
          resolution: request.settings.resolution || video.settings.resolution,
          firstImageFile: this.localImage(shot.imagePath),
        }));
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
