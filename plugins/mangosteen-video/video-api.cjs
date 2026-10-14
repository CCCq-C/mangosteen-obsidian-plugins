const crypto = require("crypto");

const QUOTA_PER_USD = 500000;
const DEFAULT_VIDEO_DOWNLOAD_LIMIT = 1024 * 1024 * 1024;
const MAX_LOCAL_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const VIDEO_PROGRESS_INTERVAL_MS = 5000;
const VIDEO_PROGRESS_ACTIONS = ["正在整理镜头顺序", "正在合成画面和节奏", "正在检查画面连贯性", "正在补齐最后的镜头细节", "正在把创意变成视频"];
const VIDEO_PROGRESS_COMPANIONS = ["可以先喝口咖啡～", "我会一直在这里守着～", "不妨翻两页笔记本～", "马上就能看到成片啦～", "先别关闭这个窗口呀～", "正在认真处理，请稍等～", "视频任务已经稳稳排队～", "好画面值得多等一小会儿～"];

const MODEL_PROFILES = {
  "klingo3": { resolutions: ["720p", "1080p"], maxDuration: 15, maxPrompt: 2500, maxImages: 3, maxVideos: 0, maxAudios: 0, prices: { output: 2 } },
  "minimax-h3": { resolutions: ["768p", "2k"], maxDuration: 15, maxImages: 9, maxVideos: 0, maxAudios: 3, prices: { "768p": 0.18, "2k": 0.28 } },
  "sd-2.0-fast": { resolutions: ["480p", "720p"], maxDuration: 15, maxImages: 9, maxVideos: 3, maxAudios: 3, prices: { "480p": 0.2, "720p": 0.42 }, referenceVideoPrices: { "480p": 0.24, "720p": 0.5 } },
  "sd-2.0-mini": { resolutions: ["480p", "720p"], maxDuration: 15, maxImages: 9, maxVideos: 3, maxAudios: 3, prices: { "480p": 0.14, "720p": 0.27 }, referenceVideoPrices: { "480p": 0.19, "720p": 0.27 } },
  "sd-2.0-stable": { resolutions: ["480p", "720p", "1080p"], maxDuration: 15, maxImages: 9, maxVideos: 3, maxAudios: 3, prices: { "480p": 0.42, "720p": 0.62, "1080p": 1.42 } },
  "seedance-2.5": { resolutions: ["480p", "720p", "1080p"], maxDuration: 30, maxPrompt: 5000, maxImages: 30, maxVideos: 10, maxAudios: 10, prices: { "480p": 0.5, "720p": 1.07, "1080p": 1.63 } },
  "seedance-2.5_k1": { resolutions: ["480p", "720p"], maxDuration: 30, maxPrompt: 5000, maxImages: 30, maxVideos: 10, maxAudios: 10, prices: { "480p": 0.36, "720p": 0.65 }, referenceVideoPrices: { "480p": 0.43, "720p": 0.75 } },
  "seedance-2.5_v1": { resolutions: ["720p"], maxDuration: 30, maxPrompt: 5000, maxImages: 30, maxVideos: 10, maxAudios: 10 },
  "seedance-2.5_y2": { resolutions: ["480p", "720p", "1080p"], maxDuration: 30, maxPrompt: 5000, maxImages: 30, maxVideos: 10, maxAudios: 10, prices: { "480p": 0.43, "720p": 0.65, "1080p": 1.43 } },
  "wan3.0-r2v-k1": { resolutions: ["480p", "720p", "1080p"], maxDuration: 30, maxImages: 10, maxVideos: 5, maxAudios: 5, prices: { "480p": 0.26, "720p": 0.35, "1080p": 0.53 } },
  "wan3.0-video-prime": { resolutions: ["480p", "720p", "1080p"], maxDuration: 30, maxImages: 10, maxVideos: 5, maxAudios: 5, prices: { "480p": 0.27, "720p": 0.54, "1080p": 1.08 } },
};

const VIDEO_INPUT_CAPABILITIES = {
  "minimax-h3": { mode: "frame", firstImage: true, lastImage: true, maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, omitRatioWithFrames: true },
  "seedance-2.0": { mode: "reference", firstImage: false, lastImage: false, maxReferenceImages: 9 },
  "seedance-2.5": { mode: "reference", firstImage: false, lastImage: false, maxReferenceImages: 30 },
  generic: { mode: "generic", firstImage: true, lastImage: true, omitRatioWithFrames: true },
};

const clean = (value) => String(value || "").trim();

function isPublicHttpsUrl(value) {
  let parsed;
  try { parsed = new URL(clean(value)); } catch (_) { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
  if (/^(?:0|10|127)\./.test(hostname) || /^169\.254\./.test(hostname) || /^192\.168\./.test(hostname)) return false;
  const private172 = hostname.match(/^172\.(\d{1,3})\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
  if (/^(?:::|::1|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(hostname)) return false;
  return hostname.includes(".") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function canonicalSubmissionValue(value) {
  if (Buffer.isBuffer(value)) return { bytesSha256: crypto.createHash("sha256").update(value).digest("hex") };
  if (value instanceof ArrayBuffer) return canonicalSubmissionValue(Buffer.from(value));
  if (ArrayBuffer.isView(value)) return canonicalSubmissionValue(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) return value.map(canonicalSubmissionValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
      .map((key) => [key, canonicalSubmissionValue(value[key])]));
  }
  return value;
}

function createSubmissionFingerprint(value) {
  const canonical = JSON.stringify(canonicalSubmissionValue(value));
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function localImageMimeType(file) {
  return clean(file?.type).toLowerCase()
    || (/\.webp$/i.test(file?.name) ? "image/webp" : /\.jpe?g$/i.test(file?.name) ? "image/jpeg" : "image/png");
}

function assertLocalImageUploadSize(file, maxBytes = MAX_LOCAL_IMAGE_UPLOAD_BYTES) {
  const size = Number(file?.size ?? file?.byteLength);
  if (Number.isFinite(size) && size > maxBytes) throw new Error("所选图片超过 20 MB，请压缩后重试。");
}

function validateUrls(values, label, limit) {
  const urls = (values || []).map(clean).filter(Boolean);
  if (urls.length > limit) throw new Error(`${label}最多填写 ${limit} 个`);
  if (urls.some((url) => !isPublicHttpsUrl(url))) throw new Error("参考材料仅支持公网 HTTPS 地址");
  return urls;
}

function resolveVideoModelFamily(model) {
  const id = clean(model).toLowerCase();
  if (id === "minimax-h3") return "minimax-h3";
  if (["seedance-2.0", "sd-2.0-fast", "sd-2.0-mini", "sd-2.0-stable"].includes(id)) return "seedance-2.0";
  if (["seedance-2.5", "seedance-2.5_k1", "seedance-2.5_v1", "seedance-2.5_y2"].includes(id)) return "seedance-2.5";
  return "generic";
}

function createVideoPayload(options = {}) {
  const model = clean(options.model);
  const prompt = clean(options.prompt);
  const duration = Number(options.duration);
  const ratio = clean(options.ratio) || "16:9";
  const resolution = clean(options.resolution) || "720p";
  if (!model) throw new Error("请选择视频模型");
  const capabilities = videoCapabilitiesForModel(model, options.allowedResolutions);
  const modelFamily = resolveVideoModelFamily(model);
  const inputCapabilities = VIDEO_INPUT_CAPABILITIES[modelFamily];
  if (!prompt) throw new Error("请先描述想生成的视频");
  if (capabilities.maxPrompt && prompt.length > capabilities.maxPrompt) throw new Error(`${model} 的视频描述不能超过 ${capabilities.maxPrompt} 个字符`);
  const hasDurationLimit = capabilities.maxDuration !== null && capabilities.maxDuration !== undefined && Number.isFinite(Number(capabilities.maxDuration));
  if (!Number.isInteger(duration) || duration < capabilities.minDuration || (hasDurationLimit && duration > capabilities.maxDuration)) {
    throw new Error(hasDurationLimit
      ? `视频时长必须是 ${capabilities.minDuration} 到 ${capabilities.maxDuration} 的整数秒`
      : `视频时长必须是不少于 ${capabilities.minDuration} 的整数秒`);
  }
  if (!["16:9", "9:16", "1:1"].includes(ratio)) throw new Error("视频比例仅支持 16:9、9:16 或 1:1");
  if (capabilities.enforceResolutions && !capabilities.resolutions.includes(resolution)) throw new Error(`${model} 的分辨率仅支持 ${capabilities.resolutions.join("、")}`);
  const firstImage = clean(options.firstImage);
  const lastImage = clean(options.lastImage);
  const usedReferenceLabels = [
    [options.referenceImages, "参考图片"],
    [options.referenceVideos, "参考视频"],
    [options.referenceAudios, "参考音频"],
  ].filter(([values]) => (values || []).map(clean).some(Boolean)).map(([, label]) => label);
  if (inputCapabilities.mode === "frame" && usedReferenceLabels.length) {
    if (firstImage || lastImage) throw new Error(`MiniMax-H3 首尾帧不能同时使用${usedReferenceLabels.join("、")}`);
    throw new Error(`MiniMax-H3 不支持${usedReferenceLabels.join("、")}`);
  }
  if ((firstImage && inputCapabilities.firstImage === false) || (lastImage && inputCapabilities.lastImage === false)) {
    throw new Error("Seedance 仅支持参考图片模式，不能使用首尾帧");
  }
  const payload = { model, prompt, duration, ratio, resolution };
  const referenceImages = validateUrls(options.referenceImages, "参考图片", inputCapabilities.maxReferenceImages ?? capabilities.maxImages);
  const referenceVideos = validateUrls(options.referenceVideos, "参考视频", inputCapabilities.maxReferenceVideos ?? capabilities.maxVideos);
  const referenceAudios = validateUrls(options.referenceAudios, "参考音频", inputCapabilities.maxReferenceAudios ?? capabilities.maxAudios);
  if (referenceImages.length) payload.referenceImages = referenceImages;
  if (referenceVideos.length) payload.referenceVideos = referenceVideos;
  if (referenceAudios.length) payload.referenceAudios = referenceAudios;
  if (options.generateAudio && modelFamily === "minimax-h3") throw new Error("MiniMax-H3 当前接口不支持同步生成音频");
  if (options.generateAudio) payload.generate_audio = true;
  for (const [url, field] of [[firstImage, "first_image"], [lastImage, "last_image"]]) {
    if (url && !isPublicHttpsUrl(url)) throw new Error("首尾帧仅支持公网 HTTPS 图片地址");
    if (url) payload[field] = url;
  }
  if (inputCapabilities.omitRatioWithFrames && (payload.first_image || payload.last_image)) delete payload.ratio;
  return payload;
}

function createVideoRequestShape(payload = {}) {
  const has = (field) => Object.prototype.hasOwnProperty.call(payload, field);
  return {
    version: 1,
    fields: Object.keys(payload).sort(),
    hasFirstImage: has("first_image"),
    hasLastImage: has("last_image"),
    hasRatio: has("ratio"),
    hasGenerateAudio: has("generate_audio"),
    referenceImageCount: Array.isArray(payload.referenceImages) ? payload.referenceImages.length : 0,
    referenceVideoCount: Array.isArray(payload.referenceVideos) ? payload.referenceVideos.length : 0,
    referenceAudioCount: Array.isArray(payload.referenceAudios) ? payload.referenceAudios.length : 0,
  };
}

function extractVideoTaskId(response) {
  return clean(response?.task_id || response?.id || response?.data?.task_id || response?.data?.id);
}

function readVideoTask(response = {}) {
  const data = response?.data && !Array.isArray(response.data) ? response.data : response;
  return {
    id: extractVideoTaskId(response),
    status: clean(response.status || data.status || response.state || data.state || "unknown").toLowerCase(),
    progress: Number.isFinite(Number(response.progress ?? data.progress)) ? Math.max(0, Math.min(100, Number(response.progress ?? data.progress))) : null,
    url: clean(response.url || data.url),
    error: clean(response?.error?.message || response?.message || data?.error?.message || data?.message),
  };
}

function readAllowedResolutions(response = {}) {
  const values = response?.data?.allowed_values || response?.json?.data?.allowed_values || [];
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter((value) => /^(?:\d+p|\d+k)$/i.test(value)))];
}

function resolutionOptionsForModel(model, learned = []) {
  return videoCapabilitiesForModel(model, learned).resolutions;
}

function videoCapabilitiesForModel(model, learned = []) {
  const saved = [...new Set((Array.isArray(learned) ? learned : []).map(clean).filter(Boolean))];
  const id = clean(model).toLowerCase();
  const profile = MODEL_PROFILES[id] || {};
  let resolutions = saved.length ? saved : profile.resolutions;
  let inferredResolution = false;
  if (!resolutions && /sd-fast-480p/i.test(id)) { resolutions = ["480p"]; inferredResolution = true; }
  if (!resolutions && /sd-fast-720p/i.test(id)) { resolutions = ["720p"]; inferredResolution = true; }
  return {
    resolutions: resolutions || ["480p", "720p", "768p", "1080p", "2k"],
    enforceResolutions: saved.length > 0 || Array.isArray(profile.resolutions) || inferredResolution,
    minDuration: 4,
    maxDuration: Number.isFinite(Number(profile.maxDuration)) ? Number(profile.maxDuration) : null,
    maxPrompt: profile.maxPrompt || null,
    maxImages: Number.isInteger(profile.maxImages) ? profile.maxImages : 9,
    maxVideos: Number.isInteger(profile.maxVideos) ? profile.maxVideos : 3,
    maxAudios: Number.isInteger(profile.maxAudios) ? profile.maxAudios : 3,
  };
}

function videoDurationHint(capabilities = {}) {
  if (capabilities.maxDuration === null || capabilities.maxDuration === undefined || !Number.isFinite(Number(capabilities.maxDuration))) return "当前模型参数由上游平台校验，山竹不会在本地拦截模型。";
  const maxDuration = Math.max(0, Number(capabilities.maxDuration));
  if (maxDuration >= 30) return `当前模型最长 ${maxDuration} 秒。`;
  return `当前模型最多 ${maxDuration} 秒；需要更长视频时，请切换到支持 30 秒的 Seedance 2.5 或 Wan 3.0 模型。`;
}

function videoPriceForSelection(model, resolution, duration, hasReferenceVideo = false) {
  const profile = MODEL_PROFILES[clean(model).toLowerCase()];
  if (!profile?.prices) return null;
  if (Number.isFinite(profile.prices.output)) return { amount: profile.prices.output, unit: "output", total: profile.prices.output };
  const prices = hasReferenceVideo && profile.referenceVideoPrices ? profile.referenceVideoPrices : profile.prices;
  const amount = Number(prices[clean(resolution).toLowerCase()]);
  if (!Number.isFinite(amount)) return null;
  const seconds = Number(duration);
  return { amount, unit: "second", total: Number((amount * (Number.isFinite(seconds) ? seconds : 0)).toFixed(4)) };
}

function shouldTryNextVideoKey(response = {}) {
  const status = Number(response.status);
  const message = clean(response?.json?.error?.message || response?.json?.message || response?.json?.error || response?.json?.code);
  return status === 401 || status === 403 || /auth|token|api.?key|no available channel|group.*not|permission|forbidden/i.test(message);
}

function selectVideoGroups(groups) {
  return Object.keys(groups || {}).map(clean).filter((group) => /video|seedance|视频/i.test(group));
}

function createVideoKeyPayload(group) {
  group = clean(group);
  if (!group) throw new Error("视频分组名称无效");
  return { name: `山竹智能体-${group}`, group, unlimited_quota: true };
}

function createBalanceRequest(apiKey) {
  apiKey = clean(apiKey);
  if (!apiKey) throw new Error("请先在山竹账号中心登录");
  return { path: "/api/user/self_v2", headers: { Authorization: `Bearer ${apiKey}` } };
}

function readQuota(response) {
  const quota = Number(response?.data?.quota);
  return Number.isFinite(quota) && quota >= 0 ? Number((quota / QUOTA_PER_USD).toFixed(4)) : null;
}

function calculateCost(before, after) {
  before = Number(before);
  after = Number(after);
  return Number.isFinite(before) && Number.isFinite(after) && after <= before
    ? Number(((before - after) / QUOTA_PER_USD).toFixed(4))
    : null;
}

function safeVideoFilename(value) {
  const sanitized = clean(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/[. ]+$/g, "");
  const extension = sanitized.toLowerCase().endsWith(".mp4") ? sanitized.slice(-4) : "";
  let name = `${extension ? sanitized.slice(0, -4) : sanitized}`.slice(0, 120 - extension.length) + extension;
  if (WINDOWS_RESERVED_NAME.test(name)) name = `视频-${name}`;
  return name || `山竹视频-${Date.now()}.mp4`;
}

function safeVideoTaskSegment(value) {
  const segment = clean(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\.{2,}/g, "-").replace(/[. ]+$/g, "").slice(0, 80);
  return segment && !WINDOWS_RESERVED_NAME.test(segment) ? segment : `任务-${Date.now()}`;
}

function withTimeout(promise, timeoutMs = 45000, label = "视频服务请求") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时，请检查网络后重试。`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function assertVideoDownloadSize(response, maxBytes = DEFAULT_VIDEO_DOWNLOAD_LIMIT) {
  const length = Number(response?.headers?.["content-length"] ?? response?.headers?.["Content-Length"] ?? response?.arrayBuffer?.byteLength);
  if (Number.isFinite(length) && length > maxBytes) throw new Error("生成视频文件过大，已停止下载以保护电脑空间。");
}

function isRetryableVideoError(error) {
  const message = clean(error?.message || error);
  if (/\b(?:400|401|403|404)\b|unauthori|forbidden|authentication|invalid|content|moderation|审核|敏感/i.test(message)) return false;
  return /\b(?:408|429|50[0-4])\b|timeout|network|failed to fetch|enotfound|econn|socket|temporar|overload/i.test(message);
}

function redactLogText(value) {
  return clean(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[已隐藏]")
    .replace(/(https?:\/\/[^\s?]+)\?\S+/gi, "$1");
}

function toChineseVideoError(error) {
  const message = redactLogText(error?.message || error || "未知错误");
  if (/first_image/i.test(message)) return "当前模型或线路暂不支持首帧图片，请取消首帧后重试。";
  if (/last_image/i.test(message)) return "当前模型或线路暂不支持尾帧图片，请取消尾帧后重试。";
  if (/insufficient|quota|balance|credit|余额/i.test(message)) return "账户余额不足，请充值后重试。";
  if (/401|unauthori|authentication|api.?key|token|登录会话/i.test(message)) return `视频模型线路鉴权失败，请打开“山竹账号中心”刷新视频分组后重试。平台原始提示：${message}`;
  if (/no available channel|group.*not|model.*not/i.test(message)) return "当前视频模型暂时没有可用线路，请在“山竹账号中心”检查视频分组权限后重试。";
  if (/rate.?limit|429|too many/i.test(message)) return "平台当前请求较多，请稍等一分钟后重试。";
  if (/content|moderation|safety|审核|敏感/i.test(message)) return "视频描述或参考材料未通过平台审核，请调整内容后重试。";
  if (/timeout|failed to fetch|network|enotfound|econn|socket/i.test(message)) return "网络连接中断，任务已经保留，稍后会自动重新查询。";
  if (/resolution|duration|ratio|parameter|invalid/i.test(message)) return `视频参数不被当前模型支持：${message}`;
  return `视频生成失败：${message}`;
}

function videoProgressText(status, previous = "", random = Math.random) {
  if (status === "queued") return "任务已排队，正在等画面开拍～";
  if (status === "saving") return "成片出炉啦，正在保存到知识库～";
  if (status === "completed") return "视频已经生成并保存好啦～";
  let index = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * VIDEO_PROGRESS_ACTIONS.length * VIDEO_PROGRESS_COMPANIONS.length);
  let message = `${VIDEO_PROGRESS_ACTIONS[Math.floor(index / VIDEO_PROGRESS_COMPANIONS.length)]}，${VIDEO_PROGRESS_COMPANIONS[index % VIDEO_PROGRESS_COMPANIONS.length]}`;
  if (message === previous) {
    index = (index + 1) % (VIDEO_PROGRESS_ACTIONS.length * VIDEO_PROGRESS_COMPANIONS.length);
    message = `${VIDEO_PROGRESS_ACTIONS[Math.floor(index / VIDEO_PROGRESS_COMPANIONS.length)]}，${VIDEO_PROGRESS_COMPANIONS[index % VIDEO_PROGRESS_COMPANIONS.length]}`;
  }
  return message;
}

module.exports = {
  VIDEO_INPUT_CAPABILITIES,
  VIDEO_PROGRESS_INTERVAL_MS,
  assertVideoDownloadSize,
  assertLocalImageUploadSize,
  calculateCost,
  createBalanceRequest,
  createSubmissionFingerprint,
  createVideoKeyPayload,
  createVideoPayload,
  createVideoRequestShape,
  extractVideoTaskId,
  isRetryableVideoError,
  localImageMimeType,
  readQuota,
  readAllowedResolutions,
  readVideoTask,
  redactLogText,
  resolutionOptionsForModel,
  resolveVideoModelFamily,
  safeVideoFilename,
  safeVideoTaskSegment,
  selectVideoGroups,
  shouldTryNextVideoKey,
  toChineseVideoError,
  videoCapabilitiesForModel,
  videoDurationHint,
  videoPriceForSelection,
  videoProgressText,
  withTimeout,
};
