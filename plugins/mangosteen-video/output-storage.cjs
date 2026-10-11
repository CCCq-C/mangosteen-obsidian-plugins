function assertMp4Path(destinationPath) {
  if (!/\.mp4$/i.test(String(destinationPath || ""))) throw new Error("输出路径必须使用 .mp4 扩展名");
}

function normalizeVideoOutputTarget(target) {
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
    throw new Error("输出路径不安全：只允许 Vault 内的相对视频路径");
  }
  assertMp4Path(destinationPath);
  return { ...target, destinationPath, overwrite: target.overwrite || "replace-current" };
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

function standaloneVideoPath({ now, taskId, timezoneOffsetMinutes = 480 }) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("视频保存时间无效");
  const safeTaskId = String(taskId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "task";
  const local = new Date(instant.getTime() + Number(timezoneOffsetMinutes) * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = pad(local.getUTCMonth() + 1);
  const day = pad(local.getUTCDate());
  const hour = pad(local.getUTCHours());
  const minute = pad(local.getUTCMinutes());
  const second = pad(local.getUTCSeconds());
  return `山竹创作记录/视频/${year}-${month}/${year}${month}${day}-${hour}${minute}${second}-${safeTaskId}.mp4`;
}

module.exports = { normalizeVideoOutputTarget, standaloneVideoPath };
