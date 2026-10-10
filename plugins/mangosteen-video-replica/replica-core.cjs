const fs = require("fs");
const path = require("path");

const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function cleanText(value) {
  return String(value ?? "").trim();
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
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("生成任务格式错误。");
  if (input.confirmed !== true) throw new Error("生成任务尚未确认，不会调用付费算力。");
  const characterPrompt = cleanText(input.character?.prompt);
  if (!characterPrompt) throw new Error("缺少人物参考图提示词。");
  const shots = Array.isArray(input.shots) ? input.shots.slice(0, 12) : [];
  if (!shots.length) throw new Error("至少需要一个分镜。");
  return {
    version: 1,
    confirmed: true,
    character: { prompt: characterPrompt },
    settings: {
      ratio: cleanText(input.settings?.ratio) || "9:16",
      resolution: cleanText(input.settings?.resolution),
      videoModel: cleanText(input.settings?.videoModel),
    },
    shots: shots.map((shot, index) => {
      const id = String(index + 1).padStart(3, "0");
      const title = safeSegment(shot?.title, `镜头-${id}`);
      const imagePrompt = cleanText(shot?.imagePrompt || shot?.prompt);
      const videoPrompt = cleanText(shot?.videoPrompt || shot?.prompt);
      if (!imagePrompt || !videoPrompt) throw new Error(`镜头 ${id} 缺少图片或视频提示词。`);
      return {
        id,
        title,
        duration: Math.max(2, Math.min(15, Number(shot?.duration) || 5)),
        dialogue: cleanText(shot?.dialogue),
        plot: cleanText(shot?.plot),
        environment: cleanText(shot?.environment),
        camera: cleanText(shot?.camera),
        imagePrompt,
        videoPrompt,
      };
    }),
  };
}

function dashboardMarkdown(project) {
  const folder = normalizeVaultPath(project.folder);
  const status = cleanText(project.statusText || project.status || "准备中");
  const frames = Array.isArray(project.frames) ? project.frames : [];
  const shots = Array.isArray(project.shots) ? project.shots : [];
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
    project.characterImagePath ? `![[${project.characterImagePath}]]` : "等待生成人物三视图。",
    "",
    "## 分镜脚本",
    "",
    project.storyboardPath ? `![[${project.storyboardPath}]]` : "等待山竹完成分镜分析。",
    "",
    "## 提取画面",
    "",
  ];
  if (!frames.length) lines.push("等待抽取关键画面。");
  for (const frame of frames) {
    lines.push(`### 镜头参考 ${String(frame.index).padStart(3, "0")} · ${formatTime(frame.timestamp)}`, "", `![[${frame.path}]]`, "");
  }
  lines.push("## 生成的视频片段", "");
  if (!shots.length) lines.push("尚未提交生成任务。", "");
  for (const shot of shots) {
    lines.push(`### ${shot.id}｜${safeSegment(shot.title, `镜头-${shot.id}`)}`, "");
    if (shot.imagePath) lines.push(`![[${shot.imagePath}]]`, "");
    if (shot.videoPath) lines.push(`![[${shot.videoPath}]]`, "");
    else lines.push(`状态：${cleanText(shot.status || "等待生成")}`, "");
    if (shot.error) lines.push(`> [!warning] ${cleanText(shot.error)}`, "");
  }
  lines.push(`<!-- project-folder: ${folder} -->`, "");
  return lines.join("\n");
}

module.exports = {
  ALLOWED_VIDEO_EXTENSIONS,
  createProjectFolder,
  dashboardMarkdown,
  dateStamp,
  formatTime,
  normalizeGenerationRequest,
  normalizeVaultPath,
  safeSegment,
  validateSourceVideo,
};
