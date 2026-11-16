"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const UPDATE_FEEDS = Object.freeze({
  suite: "https://gitee.com/Chance-Ccc/mangosteen-obsidian-plugins/raw/master/latest-v2.json",
  claudian: "https://gitee.com/Chance-Ccc/mangosteen-claudian/raw/mangosteen/latest.json",
});
const SUITE_PLUGIN_IDS = ["mangosteen-media-core", "mangosteen-image", "mangosteen-video", "mangosteen-workbench", "mangosteen-updater"];
// Obsidian follows community-plugins.json order during startup. Keep providers
// before their consumers so image/video/workbench do not fail on first load.
const TARGET_PLUGIN_IDS = ["mangosteen-media-core", "mangosteen-claudian", "mangosteen-image", "mangosteen-video", "mangosteen-workbench", "mangosteen-updater"];
const LEGACY_PLUGIN_IDS = ["mangosteen-agent"];

function codedError(code, cause) {
  const error = new Error(cause?.message || String(cause || code));
  error.code = code;
  return error;
}

function compareVersions(left, right) {
  const a = String(left || "0").split(/[.-]/).map((part) => Number(part) || 0);
  const b = String(right || "0").split(/[.-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

function validArchive(value) {
  return /^[A-Za-z0-9._-]+\.zip$/.test(String(value?.package || ""))
    && /^[a-f0-9]{64}$/i.test(String(value?.sha256 || ""));
}

function validateSuiteManifest(value) {
  if (!value || Number(value.schemaVersion) !== 2 || !/^\d+\.\d+\.\d+$/.test(String(value.version || "")) || !validArchive(value)) {
    throw codedError("MANIFEST_INVALID");
  }
  if (SUITE_PLUGIN_IDS.some((id) => !/^\d+\.\d+\.\d+$/.test(String(value.components?.[id] || "")))) throw codedError("MANIFEST_INVALID");
  if (!/^\d+\.\d+\.\d+$/.test(String(value.claudianVersion || ""))) throw codedError("MANIFEST_INVALID");
  return value;
}

function compatibleWithSuite(range, suiteVersion) {
  const majorMinor = String(suiteVersion || "").split(".").slice(0, 2).join(".");
  return String(range || "") === `${majorMinor}.x`;
}

function validateClaudianManifest(value, suiteVersion = "") {
  if (!value || Number(value.schemaVersion) !== 1 || value.pluginId !== "mangosteen-claudian"
    || !/^\d+\.\d+\.\d+$/.test(String(value.version || "")) || !validArchive(value)
    || !compatibleWithSuite(value.compatibleMangosteen, suiteVersion)) {
    throw codedError("CLAUDIAN_MANIFEST_INVALID");
  }
  return value;
}

function bytesFrom(response) {
  const value = response?.arrayBuffer;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw codedError("DOWNLOAD_INVALID");
}

function extractWithSystemTool(zipPath, destination) {
  if (process.platform === "win32") {
    const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const command = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${literal(zipPath)} -DestinationPath ${literal(destination)} -Force`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true });
    return;
  }
  execFileSync(process.platform === "darwin" ? "ditto" : "unzip", process.platform === "darwin" ? ["-x", "-k", zipPath, destination] : ["-q", "-o", zipPath, "-d", destination]);
}

function verifyPlugin(extracted, id, version) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(extracted, id, "manifest.json"), "utf8")); } catch (_) { throw codedError("PACKAGE_INVALID"); }
  if (manifest.id !== id || String(manifest.version) !== String(version) || !fs.existsSync(path.join(extracted, id, "main.js"))) throw codedError("PACKAGE_INVALID");
}

function verifyExtracted(extracted, manifest) {
  for (const [id, version] of Object.entries(manifest.components || {})) verifyPlugin(extracted, id, version);
}

function classifyPluginHealth(value = {}) {
  if (!value.folderExists || !value.manifestValid || !value.mainExists) return "PLUGIN_FILES_MISSING";
  if (!value.enabled) return "PLUGIN_DISABLED";
  if (!value.loaded) return "PLUGIN_LOAD_FAILED";
  return "OK";
}

function createUpdaterCore(options = {}) {
  const request = options.request;
  const feeds = options.feeds || UPDATE_FEEDS;
  const extractArchive = options.extractArchive || extractWithSystemTool;
  const roots = (vaultPath) => {
    const root = path.join(vaultPath, ".mangosteen-updater");
    return {
      root,
      staging: path.join(root, "staging"),
      extracted: path.join(root, "staging", "extracted"),
      backup: path.join(root, "backup"),
      plugins: path.join(vaultPath, ".obsidian", "plugins"),
      enabled: path.join(vaultPath, ".obsidian", "community-plugins.json"),
    };
  };

  async function fetchJson(url, code) {
    try {
      const response = await request({ url, method: "GET", headers: { "Cache-Control": "no-cache" } });
      if (Number(response?.status || 0) >= 400) throw new Error(`HTTP ${response.status}`);
      return response?.json;
    } catch (error) { throw codedError(code, error); }
  }

  async function check(installedVersions = {}, currentClaudianVersion = "0.0.0") {
    if (typeof request !== "function") throw codedError("UPDATE_CHECK_FAILED");
    const suite = validateSuiteManifest(await fetchJson(feeds.suite, "UPDATE_CHECK_FAILED"));
    const claudian = validateClaudianManifest(await fetchJson(feeds.claudian, "CLAUDIAN_UPDATE_CHECK_FAILED"), suite.version);
    if (String(claudian.version) !== String(suite.claudianVersion)) throw codedError("CLAUDIAN_VERSION_MISMATCH");
    const installed = installedVersions && typeof installedVersions === "object"
      ? installedVersions
      : { "mangosteen-updater": installedVersions, "mangosteen-claudian": currentClaudianVersion };
    const expected = { ...suite.components, "mangosteen-claudian": claudian.version };
    return {
      ok: true,
      updateAvailable: Object.entries(expected).some(([id, version]) => compareVersions(version, installed[id]) > 0),
      manifest: { ...suite, claudian },
      manifestUrl: feeds.suite,
      feedUrls: [feeds.suite, feeds.claudian],
    };
  }

  async function download(manifest, manifestUrl, target, statusText, onStatus) {
    const packageUrl = new URL(manifest.package, manifestUrl).href;
    onStatus(statusText);
    let response;
    try { response = await request({ url: packageUrl, method: "GET", headers: { "Cache-Control": "no-cache" } }); }
    catch (error) { throw codedError("DOWNLOAD_FAILED", error); }
    if (Number(response?.status || 0) >= 400) throw codedError("DOWNLOAD_FAILED");
    const archive = bytesFrom(response);
    const digest = crypto.createHash("sha256").update(archive).digest("hex").toLowerCase();
    if (digest !== String(manifest.sha256).toLowerCase()) throw codedError("HASH_MISMATCH");
    fs.writeFileSync(target, archive);
    return target;
  }

  async function prepare({ vaultPath, currentVersion, currentClaudianVersion = "0.0.0", installedVersions, onStatus = () => {} }) {
    onStatus("正在检查山竹插件和 Claudian 兼容版本…");
    const checked = await check(installedVersions || currentVersion, currentClaudianVersion);
    if (!checked.updateAvailable) return { ok: true, prepared: false, version: checked.manifest.version };
    const target = roots(vaultPath);
    fs.rmSync(target.staging, { recursive: true, force: true });
    fs.mkdirSync(target.extracted, { recursive: true });
    const suiteZip = path.join(target.staging, checked.manifest.package);
    const claudianZip = path.join(target.staging, checked.manifest.claudian.package);
    try {
      await download(checked.manifest, feeds.suite, suiteZip, `正在下载山竹插件 ${checked.manifest.version}…`, onStatus);
      await download(checked.manifest.claudian, feeds.claudian, claudianZip, `正在下载 Claudian ${checked.manifest.claudian.version}…`, onStatus);
      extractArchive(suiteZip, target.extracted);
      extractArchive(claudianZip, target.extracted);
      const combined = {
        schemaVersion: 2,
        version: checked.manifest.version,
        notes: checked.manifest.notes || [],
        components: {
          ...checked.manifest.components,
          "mangosteen-claudian": checked.manifest.claudian.version,
        },
        removeAfterVerify: LEGACY_PLUGIN_IDS,
      };
      verifyExtracted(target.extracted, combined);
      fs.writeFileSync(path.join(target.staging, "pending.json"), JSON.stringify(combined), "utf8");
      return { ok: true, prepared: true, version: combined.version, components: Object.keys(combined.components) };
    } catch (error) {
      fs.rmSync(target.staging, { recursive: true, force: true });
      throw error?.code ? error : codedError("PACKAGE_INVALID", error);
    }
  }

  function readPending(target) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(target.staging, "pending.json"), "utf8")); }
    catch (_) { throw codedError("PACKAGE_INVALID"); }
    if (Number(manifest.schemaVersion) !== 2 || !/^\d+\.\d+\.\d+$/.test(String(manifest.version || ""))) throw codedError("PACKAGE_INVALID");
    if (TARGET_PLUGIN_IDS.some((id) => !/^\d+\.\d+\.\d+$/.test(String(manifest.components?.[id] || "")))) throw codedError("PACKAGE_INVALID");
    verifyExtracted(target.extracted, manifest);
    return manifest;
  }

  function readEnabled(target) {
    try {
      const value = JSON.parse(fs.readFileSync(target.enabled, "utf8"));
      return Array.isArray(value) ? value.map(String) : [];
    } catch (_) { return []; }
  }

  function restoreFromBackup(target, journal) {
    for (const item of [...journal.plugins].reverse()) {
      const destination = path.join(target.plugins, item.id);
      fs.rmSync(destination, { recursive: true, force: true });
      if (item.hadOriginal) fs.cpSync(path.join(target.backup, "plugins", item.id), destination, { recursive: true, force: true });
    }
    if (journal.enabledExisted) fs.copyFileSync(path.join(target.backup, "community-plugins.json"), target.enabled);
    else fs.rmSync(target.enabled, { force: true });
  }

  function apply({ vaultPath }) {
    const target = roots(vaultPath);
    const manifest = readPending(target);
    fs.rmSync(target.backup, { recursive: true, force: true });
    fs.mkdirSync(path.join(target.backup, "plugins"), { recursive: true });
    const journal = { plugins: [], enabledExisted: fs.existsSync(target.enabled) };
    try {
      fs.mkdirSync(target.plugins, { recursive: true });
      for (const id of [...TARGET_PLUGIN_IDS, ...LEGACY_PLUGIN_IDS]) {
        const destination = path.join(target.plugins, id);
        const hadOriginal = fs.existsSync(destination);
        if (hadOriginal) fs.cpSync(destination, path.join(target.backup, "plugins", id), { recursive: true, force: true });
        journal.plugins.push({ id, hadOriginal });
      }
      if (journal.enabledExisted) fs.copyFileSync(target.enabled, path.join(target.backup, "community-plugins.json"));
      for (const id of TARGET_PLUGIN_IDS) {
        const destination = path.join(target.plugins, id);
        const oldData = path.join(target.backup, "plugins", id, "data.json");
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(path.join(target.extracted, id), destination, { recursive: true, force: true });
        if (fs.existsSync(oldData)) fs.copyFileSync(oldData, path.join(destination, "data.json"));
        verifyPlugin(target.plugins, id, manifest.components[id]);
      }
      const unmanaged = readEnabled(target).filter((id) => !LEGACY_PLUGIN_IDS.includes(id) && !TARGET_PLUGIN_IDS.includes(id));
      const enabled = [...TARGET_PLUGIN_IDS, ...unmanaged];
      fs.mkdirSync(path.dirname(target.enabled), { recursive: true });
      fs.writeFileSync(target.enabled, JSON.stringify(enabled, null, 2), "utf8");
      for (const id of LEGACY_PLUGIN_IDS) fs.rmSync(path.join(target.plugins, id), { recursive: true, force: true });
      fs.writeFileSync(path.join(target.backup, "journal.json"), JSON.stringify(journal), "utf8");
      return { ok: true, updated: true, version: manifest.version, backupReady: true, removed: LEGACY_PLUGIN_IDS };
    } catch (cause) {
      try { restoreFromBackup(target, journal); } catch (_) {}
      throw codedError("INSTALL_FAILED", cause);
    }
  }

  function rollback({ vaultPath }) {
    const target = roots(vaultPath);
    let journal;
    try { journal = JSON.parse(fs.readFileSync(path.join(target.backup, "journal.json"), "utf8")); }
    catch (_) { throw codedError("ROLLBACK_UNAVAILABLE"); }
    restoreFromBackup(target, journal);
    return { ok: true, restored: journal.plugins.map((item) => item.id) };
  }

  function complete({ vaultPath }) {
    const target = roots(vaultPath);
    fs.rmSync(target.staging, { recursive: true, force: true });
    fs.rmSync(target.backup, { recursive: true, force: true });
  }

  return { check, prepare, apply, rollback, complete };
}

module.exports = {
  UPDATE_FEEDS,
  SUITE_PLUGIN_IDS,
  TARGET_PLUGIN_IDS,
  LEGACY_PLUGIN_IDS,
  classifyPluginHealth,
  compareVersions,
  createUpdaterCore,
  validateSuiteManifest,
  validateClaudianManifest,
};
