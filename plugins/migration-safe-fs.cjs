const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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

function digestBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function descriptorDigest(fd, size) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) break;
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== size) throw new Error("迁移文件读取不完整。");
  return digest.digest("hex");
}

function createSafeMigrationFs({ vaultRoot, beforeFileOp } = {}) {
  const configuredRoot = path.resolve(String(vaultRoot || ""));
  const rootStat = fs.lstatSync(configuredRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error("迁移根目录不可用或包含符号链接。");
  const root = fs.realpathSync(configuredRoot);
  const hook = typeof beforeFileOp === "function" ? beforeFileOp : () => {};
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  const closeOnExec = Number(fs.constants.O_CLOEXEC || 0);

  function assertDirectoryChain(relative, { create = false, includeLast = false } = {}) {
    const safe = relativePath(relative);
    const parts = safe.split("/");
    const limit = includeLast ? parts.length : parts.length - 1;
    let current = root;
    for (let index = 0; index < limit; index += 1) {
      const candidate = path.join(current, parts[index]);
      let stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat && create) {
        hook({ type: "mkdir", path: parts.slice(0, index + 1).join("/") });
        const parentStat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || !inside(root, fs.realpathSync(current))) {
          throw new Error(`迁移父目录在创建前被替换：${safe}`);
        }
        try { fs.mkdirSync(candidate); } catch (error) { if (error?.code !== "EEXIST") throw error; }
        stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      }
      if (!stat) throw Object.assign(new Error(`迁移父目录不存在：${safe}`), { code: "ENOENT" });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`迁移路径包含符号链接或非目录父级：${safe}`);
      const real = fs.realpathSync(candidate);
      if (!inside(root, real)) throw new Error(`迁移路径超出 Vault：${safe}`);
      current = real;
    }
    return path.join(current, ...parts.slice(limit));
  }

  function prepare(relative, type, { createParents = false, mustExist = false, mustNotExist = false } = {}) {
    const safe = relativePath(relative);
    let target = assertDirectoryChain(safe, { create: createParents });
    hook({ type, path: safe });
    target = assertDirectoryChain(safe, { create: false });
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`迁移目标是符号链接：${safe}`);
    if (mustExist && !stat) throw Object.assign(new Error(`迁移文件不存在：${safe}`), { code: "ENOENT" });
    if (mustNotExist && stat) throw Object.assign(new Error(`迁移目标已存在：${safe}`), { code: "EEXIST" });
    return { safe, target, stat };
  }

  function assertDescriptorPath(fd, relative, { file = true } = {}) {
    const safe = relativePath(relative);
    const target = assertDirectoryChain(safe, { create: false });
    const pathStat = fs.lstatSync(target, { throwIfNoEntry: false });
    const fdStat = fs.fstatSync(fd);
    if (!pathStat || pathStat.isSymbolicLink() || (file && (!pathStat.isFile() || !fdStat.isFile()))
        || pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
      throw new Error(`迁移文件在打开期间被替换：${safe}`);
    }
    return fdStat;
  }

  function openRead(relative) {
    const { safe, target, stat } = prepare(relative, "open-read", { mustExist: true });
    if (!stat.isFile()) throw new Error(`迁移源不是普通文件：${safe}`);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow | closeOnExec);
    try { assertDescriptorPath(fd, safe); }
    catch (error) { fs.closeSync(fd); throw error; }
    return { fd, safe };
  }

  function openExclusiveWrite(relative) {
    const { safe, target } = prepare(relative, "open-write", { createParents: true, mustNotExist: true });
    const fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow | closeOnExec, 0o600);
    try { assertDescriptorPath(fd, safe); }
    catch (error) { fs.closeSync(fd); throw error; }
    return { fd, safe };
  }

  function verifyExpected(fd, safe, expected = {}) {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`迁移文件不是普通文件：${safe}`);
    const hash = descriptorDigest(fd, stat.size);
    if (expected.size !== undefined && Number(expected.size) !== stat.size) throw new Error(`迁移文件大小不一致：${safe}`);
    if (expected.sha256 && String(expected.sha256).toLowerCase() !== hash) throw new Error(`迁移文件 SHA-256 不一致：${safe}`);
    return { size: stat.size, sha256: hash };
  }

  function hashVerified(relative, expected = {}) {
    const opened = openRead(relative);
    try { return verifyExpected(opened.fd, opened.safe, expected).sha256; }
    finally { fs.closeSync(opened.fd); }
  }

  function writeExclusive(relative, value, expected = {}) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (expected.size !== undefined && Number(expected.size) !== bytes.length) throw new Error(`迁移写入大小不一致：${relative}`);
    if (expected.sha256 && String(expected.sha256).toLowerCase() !== digestBuffer(bytes)) throw new Error(`迁移写入 SHA-256 不一致：${relative}`);
    const opened = openExclusiveWrite(relative);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(opened.fd, bytes, offset, bytes.length - offset, offset);
      fs.fsyncSync(opened.fd);
      assertDescriptorPath(opened.fd, opened.safe);
      verifyExpected(opened.fd, opened.safe, { size: bytes.length, sha256: expected.sha256 || digestBuffer(bytes) });
    } finally { fs.closeSync(opened.fd); }
  }

  function copyVerified(from, to, expected = {}) {
    const source = openRead(from);
    let target = null;
    try {
      const sourceInfo = verifyExpected(source.fd, source.safe, expected);
      target = openExclusiveWrite(to);
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, sourceInfo.size)));
      let offset = 0;
      while (offset < sourceInfo.size) {
        const bytesRead = fs.readSync(source.fd, buffer, 0, Math.min(buffer.length, sourceInfo.size - offset), offset);
        if (!bytesRead) throw new Error(`迁移复制读取不完整：${from}`);
        let written = 0;
        while (written < bytesRead) written += fs.writeSync(target.fd, buffer, written, bytesRead - written, offset + written);
        offset += bytesRead;
      }
      fs.fsyncSync(target.fd);
      assertDescriptorPath(source.fd, source.safe);
      assertDescriptorPath(target.fd, target.safe);
      verifyExpected(target.fd, target.safe, sourceInfo);
      return sourceInfo;
    } finally {
      if (target) fs.closeSync(target.fd);
      fs.closeSync(source.fd);
    }
  }

  function readDescriptorJson(fd, safe) {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`迁移 journal 不是普通文件：${safe}`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return bytes.subarray(0, offset).toString("utf8");
  }

  function createOwnedExclusive(relative, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const opened = openExclusiveWrite(relative);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(opened.fd, bytes, offset, bytes.length - offset, offset);
      fs.fsyncSync(opened.fd);
      assertDescriptorPath(opened.fd, opened.safe);
      return { fd: opened.fd, relativePath: opened.safe, absolutePath: assertDirectoryChain(opened.safe) };
    } catch (error) {
      fs.closeSync(opened.fd);
      throw error;
    }
  }

  function readOwnedJson(handle) {
    if (!handle || !Number.isInteger(handle.fd)) throw new Error("迁移所有权文件句柄无效。");
    assertDescriptorPath(handle.fd, handle.relativePath);
    let value;
    try { value = JSON.parse(readDescriptorJson(handle.fd, handle.relativePath)); }
    catch (_) { throw new Error(`迁移所有权文件不可读：${handle.relativePath}`); }
    assertDescriptorPath(handle.fd, handle.relativePath);
    return value;
  }

  function writeOwnedJson(handle, value) {
    if (!handle || !Number.isInteger(handle.fd)) throw new Error("迁移所有权文件句柄无效。");
    assertDescriptorPath(handle.fd, handle.relativePath);
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    fs.ftruncateSync(handle.fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(handle.fd, bytes, offset, bytes.length - offset, offset);
    fs.fsyncSync(handle.fd);
    assertDescriptorPath(handle.fd, handle.relativePath);
  }

  function closeOwned(handle) {
    if (!handle || !Number.isInteger(handle.fd)) return;
    fs.closeSync(handle.fd);
    handle.fd = null;
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

  function readLastJournalRecord(relative) {
    const opened = openRead(relative);
    try {
      const value = parseLastJournal(readDescriptorJson(opened.fd, opened.safe));
      assertDescriptorPath(opened.fd, opened.safe);
      return value;
    } finally { fs.closeSync(opened.fd); }
  }

  function appendJournalRecord(relative, value, validateExisting) {
    const safe = relativePath(relative);
    let target = assertDirectoryChain(safe, { create: true });
    hook({ type: "open-append", path: safe });
    target = assertDirectoryChain(safe, { create: false });
    const currentStat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (currentStat?.isSymbolicLink() || (currentStat && !currentStat.isFile())) throw new Error(`迁移 journal 路径不安全：${safe}`);
    const flags = currentStat
      ? fs.constants.O_RDWR | fs.constants.O_APPEND | noFollow | closeOnExec
      : fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow | closeOnExec;
    const fd = fs.openSync(target, flags, 0o600);
    try {
      assertDescriptorPath(fd, safe);
      const existing = parseLastJournal(readDescriptorJson(fd, safe));
      if (existing && typeof validateExisting === "function" && !validateExisting(existing)) throw new Error("迁移 journal 路径被无关文件占用。");
      const line = Buffer.from(`${JSON.stringify(value)}\n`);
      fs.writeSync(fd, line, 0, line.length, null);
      fs.fsyncSync(fd);
      assertDescriptorPath(fd, safe);
    } finally { fs.closeSync(fd); }
  }

  function manifest(relative) {
    const safe = relativePath(relative);
    let candidate;
    try { candidate = assertDirectoryChain(safe, { includeLast: false }); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    const candidateStat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!candidateStat) return null;
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) throw new Error(`迁移清单目录不安全：${safe}`);
    let directory;
    try { directory = assertDirectoryChain(safe, { includeLast: true }); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`迁移清单目录不安全：${safe}`);
    const output = [];
    const walk = (folder, prefix = "") => {
      const folderRelative = prefix ? `${safe}/${prefix}` : safe;
      const checked = assertDirectoryChain(folderRelative, { includeLast: true });
      hook({ type: "readdir", path: folderRelative });
      const checkedAgain = assertDirectoryChain(folderRelative, { includeLast: true });
      if (checked !== checkedAgain) throw new Error(`迁移清单目录在读取前被替换：${folderRelative}`);
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const itemRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullRelative = `${safe}/${itemRelative}`;
        const itemPath = assertDirectoryChain(fullRelative);
        const itemStat = fs.lstatSync(itemPath, { throwIfNoEntry: false });
        if (!itemStat || itemStat.isSymbolicLink()) throw new Error(`迁移清单包含符号链接或变化文件：${fullRelative}`);
        if (itemStat.isDirectory()) walk(itemPath, itemRelative);
        else if (itemStat.isFile()) {
          const opened = openRead(fullRelative);
          try {
            const verified = verifyExpected(opened.fd, opened.safe);
            output.push({ relativePath: itemRelative, size: verified.size, sha256: verified.sha256, type: "file" });
          } finally { fs.closeSync(opened.fd); }
        }
      }
    };
    walk(directory);
    return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  return {
    appendJournalRecord,
    closeOwned,
    copyVerified,
    createOwnedExclusive,
    hashVerified,
    manifest,
    readLastJournalRecord,
    readOwnedJson,
    writeOwnedJson,
    writeExclusive,
  };
}

module.exports = { createSafeMigrationFs };
