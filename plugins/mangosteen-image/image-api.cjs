const QUOTA_PER_USD = 500000;
const DEFAULT_IMAGE_DOWNLOAD_LIMIT = 25 * 1024 * 1024;
const MAX_LOCAL_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const IMAGE_PROGRESS_INTERVAL_MS = 7000;
const PROGRESS_ACTIONS = ["正在整理画面细节", "正在搭配颜色和光影", "正在检查构图", "正在完善最后的小细节", "正在把灵感变成图片"];
const PROGRESS_COMPANIONS = ["可以先喝口咖啡～", "我会一直在这里守着～", "不妨翻两页笔记本～", "马上就能看到啦～", "先别关闭这个窗口呀～", "正在认真处理，请稍等～", "好作品值得多等一小会儿～", "图片正在慢慢长出来～"];

function cleanText(value) {
  return String(value || "").trim();
}

function localImageMimeType(file) {
  return cleanText(file?.type).toLowerCase()
    || (/\.webp$/i.test(file?.name) ? "image/webp" : /\.jpe?g$/i.test(file?.name) ? "image/jpeg" : "image/png");
}

function assertLocalImageUploadSize(file, maxBytes = MAX_LOCAL_IMAGE_UPLOAD_BYTES) {
  const size = Number(file?.size ?? file?.buffer?.byteLength ?? file?.byteLength);
  if (Number.isFinite(size) && size > maxBytes) throw new Error("所选图片超过 20 MB，请压缩后重试。");
}

function buildImageEditMultipart(fields, boundary) {
  const input = fields?.images ?? fields?.image;
  const images = input === undefined || input === null ? [] : Array.isArray(input) ? input : [input];
  if (images.length < 1 || images.length > 4) throw new Error("请选择 1–4 张参考图片");

  const chunks = [];
  const pushText = (name, value) => chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for (const [name, value] of Object.entries(fields || {})) {
    if (name !== "image" && name !== "images" && value !== undefined && value !== null) pushText(name, value);
  }
  for (const image of images) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="${image.name.replaceAll('"', '')}"\r\nContent-Type: ${image.type}\r\n\r\n`),
      image.buffer,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function generationProgressText(previous = "", random = Math.random) {
  let index = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * PROGRESS_ACTIONS.length * PROGRESS_COMPANIONS.length);
  let message = `${PROGRESS_ACTIONS[Math.floor(index / PROGRESS_COMPANIONS.length)]}，${PROGRESS_COMPANIONS[index % PROGRESS_COMPANIONS.length]}`;
  if (message === previous) {
    index = (index + 1) % (PROGRESS_ACTIONS.length * PROGRESS_COMPANIONS.length);
    message = `${PROGRESS_ACTIONS[Math.floor(index / PROGRESS_COMPANIONS.length)]}，${PROGRESS_COMPANIONS[index % PROGRESS_COMPANIONS.length]}`;
  }
  return message;
}

function accountProgressText(step) {
  const messages = [
    "正在确认账号信息呀～",
    "正在读取可用服务～",
    "正在为你准备图片模型～",
    "马上就绑定好啦，再等一下下～",
  ];
  return messages[Math.abs(Number(step) || 0) % messages.length];
}

function createHistoryEntry({ createdAt, mode, model, prompt, cost, imagePaths }) {
  const safePrompt = cleanText(prompt).split(/\r?\n/).map((line) => `> ${line}`).join("\n") || "> （未填写提示词）";
  const images = (imagePaths || []).map((item) => `![[${item}]]`).join("\n");
  const fee = Number.isFinite(Number(cost)) ? `约 $${Number(cost).toFixed(2)}` : "未读取到";
  return `\n## ${cleanText(createdAt)}｜${cleanText(mode)}\n- 模型：${cleanText(model)}\n- 本次扣费：${fee}\n- 提示词：\n${safePrompt}\n\n${images}\n`;
}

function extractImageTaskId(response) {
  const id = response?.task_id || response?.id || response?.data?.task_id || response?.data?.id || response?.data?.task?.id;
  return cleanText(id);
}

function readImageTaskState(response) {
  return cleanText(response?.status || response?.state || response?.data?.status || response?.data?.state || response?.data?.task?.status).toLowerCase();
}

function readImageTaskProgress(response) {
  const progress = Number(response?.progress ?? response?.data?.progress ?? response?.data?.task?.progress ?? response?.result?.progress);
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
}

function createBalanceRequest(apiKey) {
  const key = cleanText(apiKey);
  if (!key) throw new Error("请先填写 API Key");
  return { path: "/api/user/self_v2", headers: { Authorization: `Bearer ${key}` } };
}

function selectAvailableGroups(groups) {
  return Object.keys(groups || {}).map(cleanText).filter(Boolean);
}

function selectImageGroups(groups) {
  const available = selectAvailableGroups(groups);
  const named = available.filter((group) => /(?:image|seed|codex|绘图|生图|图片|图像)/i.test(group));
  return named.length ? named : available;
}

function describeAvailableGroups(groups) {
  const names = Object.keys(groups || {}).map(cleanText).filter(Boolean);
  return names.length ? names.join("、") : "未返回任何分组";
}

function createSessionTokenRequest(sessionCookie, userId) {
  const session = cleanText(sessionCookie).match(/(?:^|;\s*)(session=[^;]+)/i)?.[1];
  const id = cleanText(userId);
  if (!session || !id) throw new Error("登录会话或用户 ID 不完整");
  return { path: "/api/user/token", headers: { Cookie: session, "New-Api-User": id } };
}

function createAccountBalanceRequest(sessionCookie, userId) {
  const request = createSessionTokenRequest(sessionCookie, userId);
  return { path: "/api/user/self", headers: request.headers };
}

function createImageKeyPayload(group) {
  const normalizedGroup = cleanText(group);
  if (!normalizedGroup) throw new Error("图片分组名称无效");
  return { name: `山竹智能体-${normalizedGroup}`, group: normalizedGroup, unlimited_quota: true };
}

function isImageModel(modelId) {
  return /(?:image|seed|flux|dall|recraft|midjourney|mj-|banana|wanx|cogview|kolors|hunyuanimage|qwen-image|ideogram|stable-diffusion|sdxl)/i.test(cleanText(modelId));
}

function buildImageModelKeyMap(groupKeys) {
  const result = {};
  for (const item of Object.values(groupKeys || {})) {
    if (!item?.key || !Array.isArray(item.models)) continue;
    for (const model of item.models) {
      const id = cleanText(model?.id);
      if (id && isImageModel(id)) result[id] = item.key;
    }
  }
  return result;
}

function createTextToImagePayload({ model, prompt, size, count }) {
  const normalizedModel = cleanText(model);
  const normalizedPrompt = cleanText(prompt);
  const normalizedSize = cleanText(size) || "1024x1024";
  const normalizedCount = Math.max(1, Math.min(7, Number.parseInt(count, 10) || 1));
  if (!normalizedModel) throw new Error("请选择生图模型");
  if (!normalizedPrompt) throw new Error("请先输入图片描述");
  return { model: normalizedModel, prompt: normalizedPrompt, size: normalizedSize, n: normalizedCount };
}

function createLocalImagePreview(type, buffer) {
  const normalizedType = cleanText(type) || "image/png";
  return `data:${normalizedType};base64,${Buffer.from(buffer || []).toString("base64")}`;
}

function extractImageResults(response) {
  const candidates = [response?.data, response?.images, response?.result, response?.output, response?.output?.data, response?.data?.data, response?.data?.images, response?.data?.result, response?.data?.output, response?.data?.result?.data, response?.data?.result?.images, response?.result?.data, response?.result?.images]
    .find(Array.isArray) || [];
  const results = [];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) results.push({ kind: "url", value: candidate });
    else if (typeof candidate?.url === "string" && candidate.url) results.push({ kind: "url", value: candidate.url });
    else if (typeof candidate?.image_url === "string" && candidate.image_url) results.push({ kind: "url", value: candidate.image_url });
    else if (typeof candidate?.b64_json === "string" && candidate.b64_json) results.push({ kind: "base64", value: candidate.b64_json });
  }
  if (!results.length && typeof response?.url === "string" && response.url) results.push({ kind: "url", value: response.url });
  if (!results.length && typeof response?.b64_json === "string" && response.b64_json) results.push({ kind: "base64", value: response.b64_json });
  return results;
}

function readQuota(response) {
  const quota = Number(response?.data?.quota);
  if (!Number.isFinite(quota) || quota < 0) return null;
  return Number((quota / QUOTA_PER_USD).toFixed(4));
}

function calculateCost(beforeQuota, afterQuota) {
  const before = Number(beforeQuota);
  const after = Number(afterQuota);
  if (!Number.isFinite(before) || !Number.isFinite(after) || after > before) return null;
  return Number(((before - after) / QUOTA_PER_USD).toFixed(4));
}

function imageBatchResultText(successCount, failureCount) {
  const succeeded = Math.max(0, Number(successCount) || 0);
  const failed = Math.max(0, Number(failureCount) || 0);
  if (failed) return `已生成 ${succeeded} 张，另有 ${failed} 个任务失败；成功图片已保留。`;
  return "叮～图片已经做好啦，快来看看吧！";
}

function withTimeout(promise, timeoutMs = 45000, label = "图片服务请求") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时，请检查网络后重试。`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function assertImageDownloadSize(response, maxBytes = DEFAULT_IMAGE_DOWNLOAD_LIMIT) {
  const length = Number(response?.headers?.["content-length"] ?? response?.headers?.["Content-Length"] ?? response?.arrayBuffer?.byteLength);
  if (Number.isFinite(length) && length > maxBytes) throw new Error("生成图片文件过大，已停止下载以保护电脑空间。");
}

function isRetryableImageError(error) {
  const message = cleanText(error?.message || error);
  if (/\b(?:400|401|403|404)\b|unauthori|forbidden|authentication|invalid|content|moderation|审核|敏感/i.test(message)) return false;
  return /\b(?:408|429|50[0-4])\b|timeout|network|failed to fetch|enotfound|econn|socket|temporar|overload/i.test(message);
}

module.exports = { IMAGE_PROGRESS_INTERVAL_MS, accountProgressText, assertImageDownloadSize, assertLocalImageUploadSize, buildImageEditMultipart, buildImageModelKeyMap, calculateCost, createAccountBalanceRequest, createBalanceRequest, createHistoryEntry, createImageKeyPayload, createLocalImagePreview, createSessionTokenRequest, createTextToImagePayload, describeAvailableGroups, extractImageResults, extractImageTaskId, generationProgressText, imageBatchResultText, isRetryableImageError, localImageMimeType, readImageTaskProgress, readImageTaskState, readQuota, selectAvailableGroups, selectImageGroups, withTimeout };
