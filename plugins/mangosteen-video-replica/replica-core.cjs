const fs = require("fs");
const path = require("path");
const { classifyModel, normalizeVideoDuration } = require("./generation-policy.cjs");
const { assertAssetId } = require("./reference-assets.cjs");
const { fitTimelineDuration, legacyTimeline, normalizeTimeline } = require("./shot-timeline.cjs");
const { normalizeVisualStyle } = require("./visual-style.cjs");

const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function cleanText(value) {
  return String(value ?? "").trim();
}

function validationError(message, path) {
  const error = new Error(message);
  error.path = path;
  return error;
}

function withValidationPath(path, operation) {
  try {
    return operation();
  } catch (error) {
    if (error && (typeof error === "object" || typeof error === "function")) error.path = path;
    throw error;
  }
}

function safeSegment(value, fallback = "未命名") {
  let output = cleanText(value)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*#[\]^\x00-\x1f]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  if (!output || WINDOWS_RESERVED_NAME.test(output)) output = fallback;
  return output;
}

function dateStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function createProjectFolder(sourcePath, date = new Date()) {
  const name = safeSegment(path.basename(sourcePath, path.extname(sourcePath)), "视频复刻");
  return `山竹视频复刻/${name}-${dateStamp(date)}`;
}

function normalizeVaultPath(value) {
  const normalized = cleanText(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("知识库输出路径不安全，请重新选择项目名称。");
  }
  return normalized;
}

function validateSourceVideo(sourcePath, { maxDuration = 180, duration = null, maxBytes = 5 * 1024 ** 3 } = {}) {
  const absolute = path.resolve(cleanText(sourcePath));
  const extension = path.extname(absolute).toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) throw new Error("目前只支持 MP4、MOV 和 M4V 视频。");
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error("找不到源视频，请重新选择本地视频文件。");
  if (stat.size <= 0) throw new Error("源视频是空文件，无法处理。");
  if (stat.size > maxBytes) throw new Error("源视频超过 5GB，已停止处理以保护电脑空间。");
  if (duration !== null && (!Number.isFinite(Number(duration)) || Number(duration) <= 0)) throw new Error("无法读取视频时长，请确认文件可以正常播放。");
  if (duration !== null && Number(duration) > maxDuration + 0.05) throw new Error(`MVP 暂时只处理 ${maxDuration} 秒以内的视频。`);
  return { absolute, extension, size: stat.size, duration: duration === null ? null : Number(duration) };
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const millis = Math.round((value - Math.floor(value)) * 1000);
  const base = `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  return hours ? `${String(hours).padStart(2, "0")}:${base}` : base;
}

function normalizeGenerationRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw validationError("生成任务格式错误。", "request");
  if (input.confirmed !== true) throw validationError("生成任务尚未确认，不会调用付费算力。", "confirmed");
  const version = input.version === undefined ? 1 : Number(input.version);
  const isVersionSix = Number(input.schemaVersion) === 6;
  if (![1, 2, 3, 4, 5].includes(version)) throw validationError(`不支持生成任务版本：${String(input.version)}`, "version");
  let visualStyle;
  try {
    visualStyle = normalizeVisualStyle(input.visualStyle, { required: version >= 5 });
  } catch (error) {
    throw validationError(String(error?.message || error), "visualStyle");
  }
  const characterPrompt = cleanText(input.character?.prompt);
  if (!characterPrompt) throw validationError("缺少人物参考图提示词。", "character.prompt");
  const inputShots = Array.isArray(input.shots) ? input.shots : [];
  if (version >= 2 && inputShots.length > 12) throw validationError("一个任务最多只能包含 12 个分镜。", "shots");
  const shots = version === 1 ? inputShots.slice(0, 12) : inputShots;
  if (!shots.length) throw validationError("至少需要一个分镜。", "shots");

  if (version >= 2) {
    const characterId = withValidationPath("character.id", () => assertAssetId(input.character?.id));
    const model = cleanText(input.settings?.videoModel);
    if (!classifyModel(model)) throw validationError(`视频复刻不支持模型：${model || "未选择"}`, "settings.videoModel");
    const inputScenes = Array.isArray(input.scenes) ? input.scenes : [];
    if (!inputScenes.length) throw validationError("至少需要一个场景资产。", "scenes");
    const scenes = inputScenes.map((scene, index) => {
      const id = withValidationPath(`scenes.${index}.id`, () => assertAssetId(scene?.id));
      const prompt = cleanText(scene?.prompt);
      if (!prompt) throw validationError(`场景 ${id} 缺少参考图提示词。`, `scenes.${index}.prompt`);
      return { id, prompt };
    });
    const sceneIds = new Set();
    for (const [index, scene] of scenes.entries()) {
      if (sceneIds.has(scene.id)) throw validationError(`场景 ID 重复：${scene.id}`, `scenes.${index}.id`);
      sceneIds.add(scene.id);
    }
    const products = version >= 3 ? (Array.isArray(input.products) ? input.products : []).map((product, index) => {
      const id = withValidationPath(`products.${index}.id`, () => assertAssetId(product?.id));
      const prompt = cleanText(product?.prompt);
      if (!prompt) throw validationError(`产品 ${id} 缺少参考图提示词。`, `products.${index}.prompt`);
      return { id, prompt };
    }) : [];
    const productIds = new Set();
    for (const [index, product] of products.entries()) {
      if (productIds.has(product.id)) throw validationError(`产品 ID 重复：${product.id}`, `products.${index}.id`);
      productIds.add(product.id);
    }
    const stableShotIds = new Set();
    return {
      ...(isVersionSix ? { schemaVersion: 6 } : {}),
      version,
      confirmed: true,
      visualStyle,
      character: { id: characterId, prompt: characterPrompt, voiceProfile: cleanText(input.character?.voiceProfile) },
      ...(version >= 3 ? { products } : {}),
      scenes,
      settings: {
        imageModel: cleanText(input.settings?.imageModel),
        ratio: cleanText(input.settings?.ratio) || "9:16",
        resolution: cleanText(input.settings?.resolution),
        videoModel: model,
      },
      shots: shots.map((shot, index) => {
        let id = String(index + 1).padStart(3, "0");
        if (isVersionSix) {
          const rawId = String(shot?.id ?? "");
          const numericId = Number(rawId);
          if (!/^\d{3}$/.test(rawId) || !Number.isInteger(numericId) || numericId < 1 || numericId > 999) {
            throw validationError("schema v6 镜头 ID 必须是 001 到 999 的规范三位数字。", `shots.${index}.id`);
          }
          id = rawId;
          if (stableShotIds.has(id)) throw validationError(`镜头 ID 重复：${id}`, `shots.${index}.id`);
          stableShotIds.add(id);
        }
        const sceneId = cleanText(shot?.sceneId);
        if (!sceneId) throw validationError(`镜头 ${id} 缺少场景 ID。`, `shots.${index}.sceneId`);
        withValidationPath(`shots.${index}.sceneId`, () => assertAssetId(sceneId));
        if (!sceneIds.has(sceneId)) throw validationError(`镜头 ${id} 找不到场景 ID：${sceneId}`, `shots.${index}.sceneId`);
        const shotProductIds = version >= 3
          ? (Array.isArray(shot?.productIds) ? shot.productIds : []).map((productId, productIndex) => (
            withValidationPath(`shots.${index}.productIds.${productIndex}`, () => assertAssetId(productId))
          ))
          : [];
        if (shotProductIds.length > 2) throw validationError(`镜头 ${id} 最多引用 2 个产品。`, `shots.${index}.productIds`);
        for (const [productIndex, productId] of shotProductIds.entries()) {
          if (!productIds.has(productId)) {
            throw validationError(`镜头 ${id} 找不到产品 ID：${productId}`, `shots.${index}.productIds.${productIndex}`);
          }
        }
        const title = safeSegment(shot?.title, `镜头-${id}`);
        const duration = normalizeVideoDuration(shot?.duration, model);
        if (version >= 4) {
          const legacyFrameMode = shot?.legacyFrameMode === true;
          const imagePrompt = cleanText(shot?.imagePrompt || shot?.prompt);
          if (legacyFrameMode && !imagePrompt) {
            throw validationError(`镜头 ${id} 缺少旧版首帧提示词。`, `shots.${index}.imagePrompt`);
          }
          return {
            id,
            title,
            sceneId,
            productIds: shotProductIds,
            duration,
            timeline: withValidationPath(`shots.${index}.timeline`, () => normalizeTimeline(shot?.timeline, duration)),
            legacyFrameMode,
            ...(legacyFrameMode ? {
              imagePrompt,
              lastImagePrompt: cleanText(shot?.lastImagePrompt),
              videoPrompt: cleanText(shot?.videoPrompt || shot?.prompt),
            } : {}),
            videoPromptOverride: cleanText(shot?.videoPromptOverride),
          };
        }
        const imagePrompt = cleanText(shot?.imagePrompt || shot?.prompt);
        const videoPrompt = cleanText(shot?.videoPrompt || shot?.prompt);
        if (!imagePrompt || !videoPrompt) {
          throw validationError(
            `镜头 ${id} 缺少图片或视频提示词。`,
            `shots.${index}.${!imagePrompt ? "imagePrompt" : "videoPrompt"}`,
          );
        }
        return {
          id,
          title,
          sceneId,
          ...(version >= 3 ? { productIds: shotProductIds } : {}),
          duration,
          timeline: normalizeTimeline(legacyTimeline({ ...shot, duration }), duration),
          dialogue: cleanText(shot?.dialogue),
          voiceDirection: cleanText(shot?.voiceDirection),
          plot: cleanText(shot?.plot),
          environment: cleanText(shot?.environment),
          camera: cleanText(shot?.camera),
          imagePrompt,
          lastImagePrompt: cleanText(shot?.lastImagePrompt),
          videoPrompt,
          videoPromptOverride: cleanText(shot?.videoPromptOverride),
        };
      }),
    };
  }

  return {
    version: 1,
    confirmed: true,
    visualStyle,
    character: { prompt: characterPrompt, voiceProfile: cleanText(input.character?.voiceProfile) },
    settings: {
      imageModel: cleanText(input.settings?.imageModel),
      ratio: cleanText(input.settings?.ratio) || "9:16",
      resolution: cleanText(input.settings?.resolution),
      videoModel: cleanText(input.settings?.videoModel),
    },
    shots: shots.map((shot, index) => {
      const id = String(index + 1).padStart(3, "0");
      const title = safeSegment(shot?.title, `镜头-${id}`);
      const imagePrompt = cleanText(shot?.imagePrompt || shot?.prompt);
      const videoPrompt = cleanText(shot?.videoPrompt || shot?.prompt);
      if (!imagePrompt || !videoPrompt) {
        throw validationError(
          `镜头 ${id} 缺少图片或视频提示词。`,
          `shots.${index}.${!imagePrompt ? "imagePrompt" : "videoPrompt"}`,
        );
      }
      const duration = normalizeVideoDuration(shot?.duration, input.settings?.videoModel);
      return {
        id,
        title,
        duration,
        timeline: normalizeTimeline(legacyTimeline({ ...shot, duration }), duration),
        dialogue: cleanText(shot?.dialogue),
        voiceDirection: cleanText(shot?.voiceDirection),
        plot: cleanText(shot?.plot),
        environment: cleanText(shot?.environment),
        camera: cleanText(shot?.camera),
        imagePrompt,
        videoPrompt,
        videoPromptOverride: cleanText(shot?.videoPromptOverride),
      };
    }),
  };
}

function buildGenerationDraft(project, analysis, settings = {}) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) throw new Error("AI 分析结果格式错误。");
  const characterId = assertAssetId(analysis.character?.id || "main-character");
  const products = (Array.isArray(analysis.products) ? analysis.products : []).map((product) => ({
    id: assertAssetId(product?.id),
    prompt: cleanText(product?.prompt),
  }));
  if (products.some((product) => !product.prompt)) throw new Error("AI 分析生成了无效产品资产。");
  const scenes = (Array.isArray(analysis.scenes) ? analysis.scenes : []).map((scene) => ({
    id: assertAssetId(scene?.id),
    prompt: cleanText(scene?.prompt),
  }));
  if (!scenes.length || scenes.some((scene) => !scene.prompt)) throw new Error("AI 分析没有生成有效场景资产。");
  const rawShots = Array.isArray(analysis.shots) ? analysis.shots.slice(0, 12) : [];
  const videoModel = cleanText(settings.videoModel) || "MiniMax-H3";
  const draft = {
    version: 5,
    confirmed: true,
    visualStyle: normalizeVisualStyle(analysis.visualStyle),
    character: {
      id: characterId,
      prompt: cleanText(analysis.character?.prompt),
      voiceProfile: cleanText(analysis.character?.voiceProfile),
    },
    products,
    scenes,
    settings: {
      imageModel: cleanText(settings.imageModel) || "gpt-image-2",
      videoModel,
      ratio: cleanText(settings.ratio) || (Number(project?.height) > Number(project?.width) ? "9:16" : "16:9"),
      resolution: cleanText(settings.resolution) || "720p",
    },
    shots: rawShots.map((shot) => {
      const rawDuration = Number(shot?.endTime) - Number(shot?.startTime) || Number(shot?.duration) || 4;
      const duration = normalizeVideoDuration(rawDuration, videoModel);
      let timeline = Array.isArray(shot?.timeline) ? shot.timeline.map((segment) => ({ ...segment })) : legacyTimeline({ ...shot, duration });
      timeline = fitTimelineDuration(timeline, duration);
      timeline = normalizeTimeline(timeline, duration);
      return {
        title: cleanText(shot?.title),
        sceneId: cleanText(shot?.sceneId),
        productIds: Array.isArray(shot?.productIds) ? shot.productIds.map((id) => cleanText(id)).filter(Boolean) : [],
        duration,
        timeline,
      };
    }),
  };
  const normalized = normalizeGenerationRequest(draft);
  return { ...normalized, confirmed: false };
}

function analysisStoryboardMarkdown(project, request) {
  const lines = [
    `# AI 分镜分析｜${safeSegment(project?.title || "视频复刻项目")}`,
    "",
    "> 已根据原片画面和台词生成复刻草案。原片截图只用于分析，不会作为生图或视频参考图。",
    "",
    "| 镜头 | 时间段 | 画面动作 | 台词 | 情绪与声音 | 景别与运镜 | 环境 |",
    "|---|---:|---|---|---|---|---|",
  ];
  for (const shot of request.shots || []) {
    for (const segment of shot.timeline || legacyTimeline(shot)) {
      lines.push(`| ${shot.id}｜${safeSegment(shot.title)} | ${Number(segment.start)}～${Number(segment.end)} 秒 | ${cleanText(segment.action).replace(/\|/g, "\\|")} | ${cleanText(segment.dialogue).replace(/\|/g, "\\|")} | ${cleanText(segment.performance).replace(/\|/g, "\\|")} | ${cleanText(segment.camera).replace(/\|/g, "\\|")} | ${cleanText(segment.environment).replace(/\|/g, "\\|")} |`);
    }
  }
  lines.push("", "## 统一视觉风格", "", `**${request.visualStyle.category}**`, "", request.visualStyle.prompt, "");
  lines.push("", "## 人物参考提示词", "", request.character.prompt, "", "## 人物声音设定", "", request.character.voiceProfile || "未指定，由视频模型根据人物和剧情自然生成。", "", "## 产品参考提示词", "");
  if (!(request.products || []).length) lines.push("本项目没有需要固定外观的核心产品。", "");
  for (const product of request.products || []) lines.push(`### ${product.id}`, "", product.prompt, "");
  lines.push("## 场景参考提示词", "");
  for (const scene of request.scenes || []) lines.push(`### ${scene.id}`, "", scene.prompt, "");
  lines.push("## 分镜时间轴", "");
  for (const shot of request.shots || []) {
    lines.push(`### ${shot.id}｜${safeSegment(shot.title)}`, "");
    for (const segment of shot.timeline || legacyTimeline(shot)) {
      lines.push(`- **${Number(segment.start)}～${Number(segment.end)} 秒**：${segment.action || "保持自然动作"}；台词：${segment.dialogue || "无"}；情绪与声音：${segment.performance || "自然"}；景别与运镜：${segment.camera || "稳定"}；环境：${segment.environment || "延续场景"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function currentShotArtifacts(shot = {}) {
  return shot.currentArtifacts && typeof shot.currentArtifacts === "object" && !Array.isArray(shot.currentArtifacts)
    ? { ...shot.currentArtifacts, ...shot }
    : shot;
}

function expectedReferenceAssetPath(kind, id) {
  const safeId = cleanText(id);
  if (!safeId) return "";
  if (kind === "character") return `山竹视频资产库/人物/${safeId}/人物参考板.png`;
  if (kind === "scene") return `山竹视频资产库/场景/${safeId}/场景参考图.png`;
  if (kind === "product") return `山竹视频资产库/产品/${safeId}/产品参考板.png`;
  return "";
}

function referenceAssetsMarkdown(project = {}, draft = {}) {
  const characterAssets = [project.characterAsset].filter(Boolean);
  const sceneAssets = Array.isArray(project.sceneAssets) ? project.sceneAssets : [];
  const productAssets = Array.isArray(project.productAssets) ? project.productAssets : [];
  const byId = (assets) => new Map(assets.map((asset) => [cleanText(asset?.id), asset]));
  const characterById = byId(characterAssets);
  const scenesById = byId(sceneAssets);
  const productsById = byId(productAssets);
  const lines = [
    `# 参考资产｜${safeSegment(project.title || project.sourceName || "视频复刻项目")}`,
    "",
    "> 人物、场景和产品原图保存在山竹视频资产库；本页只使用 Obsidian 嵌入，不复制资产。",
    "",
    "## 人物",
    "",
  ];
  const characterId = cleanText(draft.character?.id || project.characterAsset?.id);
  if (characterId) {
    const imagePath = cleanText(characterById.get(characterId)?.imagePath) || expectedReferenceAssetPath("character", characterId);
    lines.push(`### ${safeSegment(characterId, "人物")}`, "", `![[${imagePath}]]`, "");
  } else lines.push("等待分镜分析确定人物资产。", "");

  lines.push("## 场景", "");
  const scenes = Array.isArray(draft.scenes) ? draft.scenes : [];
  if (!scenes.length) lines.push("等待分镜分析确定场景资产。", "");
  for (const scene of scenes) {
    const id = cleanText(scene?.id);
    const imagePath = cleanText(scenesById.get(id)?.imagePath) || expectedReferenceAssetPath("scene", id);
    lines.push(`### ${safeSegment(id, "场景")}`, "", `![[${imagePath}]]`, "");
  }

  lines.push("## 产品", "");
  const products = Array.isArray(draft.products) ? draft.products : [];
  if (!products.length) lines.push("本项目没有需要固定外观的核心产品。", "");
  for (const product of products) {
    const id = cleanText(product?.id);
    const imagePath = cleanText(productsById.get(id)?.imagePath) || expectedReferenceAssetPath("product", id);
    lines.push(`### ${safeSegment(id, "产品")}`, "", `![[${imagePath}]]`, "");
  }
  return lines.join("\n");
}

function versionSixDashboardMarkdown(project, draft = {}) {
  const folder = normalizeVaultPath(project.folder);
  const title = safeSegment(project.title || project.sourceName || "视频复刻项目");
  const sourcePath = cleanText(project.source?.videoPath || project.sourcePath);
  const duration = Number(project.source?.duration ?? project.duration ?? 0);
  const frames = Array.isArray(project.frames) ? project.frames : [];
  const draftShots = Array.isArray(draft.shots) ? draft.shots : [];
  const artifactsById = new Map((Array.isArray(project.shots) ? project.shots : []).map((shot) => [String(shot.id), currentShotArtifacts(shot)]));
  const status = cleanText(draft.analysisStatusText || draft.analysisStatus || "本地素材已准备");
  const lines = [
    "---",
    `title: "${title.replace(/"/g, "\\\"")}"`,
    "type: video-replica",
    "schemaVersion: 6",
    `created: "${cleanText(project.createdAt)}"`,
    "---",
    "",
    `# ${title}`,
    "",
    `> [!info] 当前阶段：${status}`,
    "",
    "## 原始素材",
    "",
    sourcePath ? `![[${sourcePath}]]` : "等待保存原视频。",
    "",
    `- 时长：${duration.toFixed(1)} 秒`,
    "",
    "### 台词转写",
    "",
    project.transcriptPath ? `![[${project.transcriptPath}]]` : "等待本地 Whisper 转写。",
    "",
    "### 抽帧",
    "",
  ];
  if (!frames.length) lines.push("等待抽取关键画面。", "");
  for (const frame of frames) lines.push(`#### ${String(frame.index).padStart(3, "0")} · ${formatTime(frame.timestamp)}`, "", `![[${frame.path}]]`, "");
  lines.push("## 参考资产", "", `![[${folder}/02-参考资产/参考资产.md]]`, "", "## 分镜", "");
  if (!draftShots.length) lines.push("等待山竹完成分镜分析。", "");
  for (const shot of draftShots) {
    const id = String(shot.id || "").padStart(3, "0");
    const artifacts = artifactsById.get(String(shot.id)) || {};
    const shotFolder = `${folder}/03-分镜/${id}`;
    lines.push(`### ${id}｜${safeSegment(shot.title, `镜头-${id}`)}`, "");
    const firstImagePath = cleanText(artifacts.firstImagePath || artifacts.imagePath);
    if (firstImagePath) lines.push("**首帧**", "", `![[${firstImagePath}]]`, "");
    else lines.push(`[[${shotFolder}/首帧.png|首帧]]`, "");
    if (artifacts.lastImagePath) lines.push("**尾帧**", "", `![[${artifacts.lastImagePath}]]`, "");
    else lines.push(`[[${shotFolder}/尾帧.png|尾帧]]`, "");
    if (artifacts.videoPath) lines.push(`![[${artifacts.videoPath}]]`, "");
    else lines.push(`[[${shotFolder}/视频.mp4|视频]]`, "");
  }
  lines.push("## 最终成片", "");
  if (project.finalVideoPath) lines.push(`![[${project.finalVideoPath}]]`, "");
  else lines.push(`[[${folder}/04-最终成片/最终成片.mp4|最终成片（生成后可用）]]`, "");
  lines.push(`<!-- project-folder: ${folder} -->`, "");
  return lines.join("\n");
}

function dashboardMarkdown(project, draft = {}) {
  if (Number(project?.schemaVersion) >= 6 || Number(project?.layoutVersion) >= 6) {
    return versionSixDashboardMarkdown(project, draft);
  }
  const folder = normalizeVaultPath(project.folder);
  const status = cleanText(project.statusText || project.status || "准备中");
  const frames = Array.isArray(project.frames) ? project.frames : [];
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const sceneAssets = Array.isArray(project.sceneAssets) ? project.sceneAssets : [];
  const productAssets = Array.isArray(project.productAssets) ? project.productAssets : [];
  const characterImagePath = project.characterAsset?.imagePath || project.characterImagePath;
  const lines = [
    "---",
    `title: "${safeSegment(project.title || project.sourceName || "视频复刻项目").replace(/"/g, "\\\"")}"`,
    "type: video-replica",
    `status: "${status.replace(/"/g, "\\\"")}"`,
    `created: "${cleanText(project.createdAt)}"`,
    "---",
    "",
    `# ${safeSegment(project.title || project.sourceName || "视频复刻项目")}`,
    "",
    `> [!info] 当前状态：${status}`,
    "",
    "## 生成设置",
    "",
    `- 图片模型：\`${cleanText(project.imageModel) || "等待选择"}\``,
    `- 视频模型：\`${cleanText(project.videoModel) || "等待选择"}\``,
    "",
    "## 源视频",
    "",
    `- 文件：\`${cleanText(project.sourcePath)}\``,
    `- 时长：${Number(project.duration || 0).toFixed(1)} 秒`,
    "",
    "## 台词转写",
    "",
    project.transcriptPath ? `![[${project.transcriptPath}]]` : "等待本地 Whisper 转写。",
    "",
    "## 人物参考",
    "",
    characterImagePath ? `![[${characterImagePath}]]` : "等待生成人物三视图。",
    "",
    "## 产品资产",
    "",
  "## 场景资产",
    "",
  ];
  const sceneHeadingIndex = lines.indexOf("## 场景资产");
  const productLines = productAssets.length
    ? productAssets.flatMap((asset) => [`### ${safeSegment(asset.id, "产品")}`, "", `![[${asset.imagePath}]]`, ""])
    : ["本项目没有需要固定外观的核心产品。", ""];
  lines.splice(sceneHeadingIndex, 0, ...productLines);
  if (!sceneAssets.length) lines.push("等待生成场景参考图。", "");
  for (const asset of sceneAssets) {
    lines.push(`### ${safeSegment(asset.id, "场景")}`, "", `![[${asset.imagePath}]]`, "");
  }
  lines.push(
    "## 分镜脚本",
    "",
    project.storyboardPath ? `![[${project.storyboardPath}]]` : "等待山竹完成分镜分析。",
    "",
    "## 提取画面",
    "",
  );
  if (!frames.length) lines.push("等待抽取关键画面。");
  for (const frame of frames) {
    lines.push(`### 镜头参考 ${String(frame.index).padStart(3, "0")} · ${formatTime(frame.timestamp)}`, "", `![[${frame.path}]]`, "");
  }
  lines.push("## 生成的视频片段", "");
  if (!shots.length) lines.push("尚未提交生成任务。", "");
  for (const shot of shots) {
    lines.push(`### ${shot.id}｜${safeSegment(shot.title, `镜头-${shot.id}`)}`, "");
    const firstImagePath = shot.firstImagePath || shot.imagePath;
    if (firstImagePath) lines.push("**首帧**", "", `![[${firstImagePath}]]`, "");
    if (shot.lastImagePath) lines.push("**尾帧**", "", `![[${shot.lastImagePath}]]`, "");
    if (shot.videoPath) lines.push(`![[${shot.videoPath}]]`, "");
    else lines.push(`状态：${cleanText(shot.status || "等待生成")}`, "");
    if (shot.error) lines.push(`> [!warning] ${cleanText(shot.error)}`, "");
  }
  lines.push(`<!-- project-folder: ${folder} -->`, "");
  if (project.finalVideoPath) lines.splice(lines.length - 2, 0, "## 最终成片", "", `![[${project.finalVideoPath}]]`, "");
  else if (project.concatError) lines.splice(lines.length - 2, 0, "## 最终成片", "", `> [!warning] 自动拼接失败：${cleanText(project.concatError)}`, "");
  return lines.join("\n");
}

module.exports = {
  ALLOWED_VIDEO_EXTENSIONS,
  analysisStoryboardMarkdown,
  buildGenerationDraft,
  createProjectFolder,
  dashboardMarkdown,
  dateStamp,
  formatTime,
  normalizeGenerationRequest,
  normalizeVaultPath,
  referenceAssetsMarkdown,
  safeSegment,
  validateSourceVideo,
};
