const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIGRATION_SAFE_FS_UNAVAILABLE = "MIGRATION_SAFE_FS_UNAVAILABLE";
const UNAVAILABLE_REASON = "当前 Obsidian Node 运行时没有经过验证的 descriptor-relative openat/*at 文件系统能力；迁移仅可预览，不能执行。";
const REQUIRED_METHODS = [
  "appendJournalRecord",
  "closeOwned",
  "copyVerified",
  "createOwnedExclusive",
  "hashVerified",
  "manifest",
  "readLastJournalRecord",
  "readOwnedJson",
  "writeOwnedJson",
  "writeExclusive",
];

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function relativePath(value) {
  const raw = String(value || "").trim();
  const parts = raw.split("/");
  if (!raw || raw.includes("\\") || raw.includes("\0") || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)
      || parts.some((part) => !part || part === "." || part === "..")) throw new Error(`迁移路径不安全：${raw}`);
  return raw;
}

function parseLastJournal(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch (_) {}
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch (_) {}
  }
  throw new Error("迁移 journal 内容不可读。");
}

function createPreviewReader(root) {
  function resolveChecked(relative, { allowMissing = false } = {}) {
    const safe = relativePath(relative);
    let current = root;
    for (const part of safe.split("/")) {
      const candidate = path.join(current, part);
      const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat) {
        if (allowMissing) return { safe, target: candidate, stat: null };
        throw Object.assign(new Error(`迁移预览路径不存在：${safe}`), { code: "ENOENT" });
      }
      if (stat.isSymbolicLink()) throw new Error(`迁移预览路径包含符号链接：${safe}`);
      const real = fs.realpathSync(candidate);
      if (!inside(root, real)) throw new Error(`迁移预览路径超出 Vault：${safe}`);
      current = real;
    }
    return { safe, target: current, stat: fs.lstatSync(current) };
  }

  function previewManifest(relative) {
    const initial = resolveChecked(relative, { allowMissing: true });
    if (!initial.stat) return null;
    if (!initial.stat.isDirectory()) throw new Error(`迁移预览清单不是目录：${initial.safe}`);
    const output = [];
    const walk = (folderRelative, prefix = "") => {
      const folder = resolveChecked(folderRelative);
      if (!folder.stat.isDirectory()) throw new Error(`迁移预览清单目录已变化：${folder.safe}`);
      for (const entry of fs.readdirSync(folder.target, { withFileTypes: true })) {
        const itemPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        const itemRelative = `${initial.safe}/${itemPrefix}`;
        const item = resolveChecked(itemRelative);
        if (item.stat.isDirectory()) walk(itemRelative, itemPrefix);
        else if (item.stat.isFile()) {
          const bytes = fs.readFileSync(item.target);
          const after = resolveChecked(itemRelative);
          if (!after.stat.isFile() || after.stat.dev !== item.stat.dev || after.stat.ino !== item.stat.ino
              || after.stat.size !== item.stat.size) throw new Error(`迁移预览文件读取期间发生变化：${item.safe}`);
          output.push({
            relativePath: itemPrefix,
            size: bytes.length,
            sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
            type: "file",
          });
        } else throw new Error(`迁移预览清单包含非普通文件：${item.safe}`);
      }
    };
    walk(initial.safe);
    return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  function previewReadLastJournalRecord(relative) {
    const item = resolveChecked(relative, { allowMissing: true });
    if (!item.stat) return null;
    if (!item.stat.isFile()) throw new Error(`迁移预览 journal 不是普通文件：${item.safe}`);
    const bytes = fs.readFileSync(item.target, "utf8");
    const after = resolveChecked(relative);
    if (!after.stat.isFile() || after.stat.dev !== item.stat.dev || after.stat.ino !== item.stat.ino
        || after.stat.size !== item.stat.size) throw new Error(`迁移预览 journal 读取期间发生变化：${item.safe}`);
    return parseLastJournal(bytes);
  }

  return { previewManifest, previewReadLastJournalRecord };
}

function createSafeMigrationFs({ vaultRoot, descriptorRelativeFs = null } = {}) {
  const configuredRoot = path.resolve(String(vaultRoot || ""));
  const rootStat = fs.lstatSync(configuredRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error("迁移根目录不可用或包含符号链接。");
  const root = fs.realpathSync(configuredRoot);
  const preview = createPreviewReader(root);
  let session = null;
  let capability = {
    available: false,
    code: MIGRATION_SAFE_FS_UNAVAILABLE,
    reason: UNAVAILABLE_REASON,
  };

  if (descriptorRelativeFs !== null && descriptorRelativeFs !== undefined) {
    if (descriptorRelativeFs.vetted !== true || descriptorRelativeFs.apiVersion !== 1
        || typeof descriptorRelativeFs.name !== "string" || typeof descriptorRelativeFs.createSession !== "function") {
      throw new Error("迁移 descriptor-relative 文件系统能力未通过验证。");
    }
    session = descriptorRelativeFs.createSession({ vaultRoot: root });
    if (!session || REQUIRED_METHODS.some((name) => typeof session[name] !== "function")) {
      throw new Error("迁移 descriptor-relative 文件系统能力不完整。");
    }
    capability = { available: true, apiVersion: 1, name: descriptorRelativeFs.name };
  }

  function assertExecutionAvailable() {
    if (session) return true;
    const error = new Error(`${MIGRATION_SAFE_FS_UNAVAILABLE}: ${UNAVAILABLE_REASON}`);
    error.code = MIGRATION_SAFE_FS_UNAVAILABLE;
    throw error;
  }

  const api = {
    capability: Object.freeze(capability),
    assertExecutionAvailable,
    previewManifest: preview.previewManifest,
    previewReadLastJournalRecord: preview.previewReadLastJournalRecord,
  };
  for (const name of REQUIRED_METHODS) {
    api[name] = (...args) => {
      assertExecutionAvailable();
      return session[name](...args);
    };
  }
  return Object.freeze(api);
}

module.exports = {
  MIGRATION_SAFE_FS_UNAVAILABLE,
  createSafeMigrationFs,
};
