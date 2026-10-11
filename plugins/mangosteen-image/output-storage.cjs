const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

function imageExtension(destinationPath) {
  const match = String(destinationPath || "").match(/\.([^.\/]+)$/);
  const extension = String(match?.[1] || "").toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error("输出路径必须使用图片扩展名：.png、.jpg、.jpeg 或 .webp");
  return extension;
}

function normalizeImageOutputTarget(target) {
  if (!target) return null;
  const destinationPath = String(target.destinationPath || "");
  const segments = destinationPath.split("/");
  if (
    !destinationPath
    || destinationPath.includes("\\")
    || destinationPath.includes("\0")
    || destinationPath.startsWith("/")
    || /^[A-Za-z]:\//.test(destinationPath)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("输出路径不安全：只允许 Vault 内的相对图片路径");
  }
  imageExtension(destinationPath);
  return { ...target, destinationPath, overwrite: target.overwrite || "replace-current" };
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

function standaloneImagePath({ now, taskId, index, extension, timezoneOffsetMinutes = 480 }) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("图片保存时间无效");
  const normalizedExtension = imageExtension(`image.${String(extension || "").replace(/^\./, "")}`);
  const safeTaskId = String(taskId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "task";
  const local = new Date(instant.getTime() + Number(timezoneOffsetMinutes) * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = pad(local.getUTCMonth() + 1);
  const day = pad(local.getUTCDate());
  const hour = pad(local.getUTCHours());
  const minute = pad(local.getUTCMinutes());
  const second = pad(local.getUTCSeconds());
  const sequence = pad(Math.max(1, Number.parseInt(index, 10) || 1));
  return `山竹创作记录/图片/${year}-${month}/${year}${month}${day}-${hour}${minute}${second}-${safeTaskId}-${sequence}.${normalizedExtension}`;
}

module.exports = { normalizeImageOutputTarget, standaloneImagePath };
