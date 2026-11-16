"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { Modal, Notice, Plugin, PluginSettingTab, requestUrl } = require("obsidian");
let TARGET_PLUGIN_IDS = ["mangosteen-media-core", "mangosteen-claudian", "mangosteen-image", "mangosteen-video", "mangosteen-workbench", "mangosteen-updater"];
let classifyPluginHealth = (value = {}) => {
  if (!value.folderExists || !value.manifestValid || !value.mainExists) return "PLUGIN_FILES_MISSING";
  if (!value.enabled) return "PLUGIN_DISABLED";
  if (!value.loaded) return "PLUGIN_LOAD_FAILED";
  return "OK";
};
let createUpdaterCore = null;

const LABELS = {
  "mangosteen-media-core": "山竹媒体账号中心",
  "mangosteen-image": "山竹出图",
  "mangosteen-video": "山竹视频",
  "mangosteen-workbench": "山竹工作台",
  "mangosteen-updater": "山竹插件更新器",
  "mangosteen-claudian": "山竹",
};
const ERROR_TEXT = {
  UPDATE_CHECK_FAILED: "暂时无法连接山竹 Gitee 更新源，请检查网络后重试。",
  CLAUDIAN_UPDATE_CHECK_FAILED: "暂时无法连接 Claudian 的 Gitee 更新源，请检查网络后重试。",
  CLAUDIAN_MANIFEST_INVALID: "Claudian 更新清单不完整，当前插件没有被修改。",
  CLAUDIAN_VERSION_MISMATCH: "Claudian 与山竹版本不兼容，当前插件没有被修改。",
  DOWNLOAD_FAILED: "更新包下载失败，请检查网络后重试。",
  HASH_MISMATCH: "更新包安全校验失败，当前插件没有被修改。",
  PACKAGE_INVALID: "更新包内容不完整，当前插件没有被修改。",
  UPDATE_LAUNCH_ACCESS_DENIED: "系统安全策略拒绝启动后台更新程序，Obsidian 没有关闭，当前版本没有被修改。",
  UPDATE_LAUNCH_FAILED: "后台更新程序启动失败，Obsidian 没有关闭，当前版本没有被修改。",
  INSTALL_FAILED: "插件文件替换失败，已恢复旧版本。",
  PLUGIN_FILES_MISSING: "插件文件不完整，请重新安装完整包。",
  PLUGIN_DISABLED: "插件当前被关闭，可以点击一键修复重新启用。",
  PLUGIN_LOAD_FAILED: "插件已启用但加载失败，可以点击一键修复重新加载。",
};

class UpdateConfirmModal extends Modal {
  constructor(app, version, notes, resolve) {
    super(app);
    this.version = version;
    this.notes = (Array.isArray(notes) ? notes : []).map((note) => String(note || "").trim().slice(0, 120)).filter(Boolean).slice(0, 5);
    this.resolve = resolve;
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "发现山竹插件新版本" });
    this.contentEl.createEl("p", { text: `新版本 ${this.version} 已发布。是否现在下载并更新？` });
    this.notes.forEach((note) => this.contentEl.createEl("p", { text: "· " + note }));
    this.contentEl.createEl("p", { text: "更新时 Obsidian 会自动关闭并重新启动，同时自动开启山竹相关插件。通常需要 1–2 分钟，请勿手动重新打开或强制关机。" });
    const actions = this.contentEl.createDiv();
    const later = actions.createEl("button", { text: "稍后" });
    const update = actions.createEl("button", { text: "立即更新", cls: "mod-cta" });
    later.onclick = () => { this.resolve(false); this.close(); };
    update.onclick = () => { this.resolve(true); this.close(); };
  }
  onClose() { if (this.resolve) { this.resolve(false); this.resolve = null; } }
}

class RecoveryModal extends Modal {
  constructor(app, plugin, id, code) { super(app); this.plugin = plugin; this.id = id; this.code = code; }
  onOpen() {
    this.contentEl.createEl("h2", { text: "山竹插件加载故障" });
    this.contentEl.createEl("p", { text: `${LABELS[this.id] || this.id}：${ERROR_TEXT[this.code] || "加载状态异常。"}` });
    this.contentEl.createEl("p", { text: "一键修复失败时，桌面会生成诊断文件，请把它发给售后老师。" });
    const repair = this.contentEl.createEl("button", { text: "一键修复", cls: "mod-cta" });
    repair.onclick = async () => { repair.disabled = true; const result = await this.plugin.repairPlugin(this.id); if (result.ok) this.close(); else repair.setText("修复失败，诊断文件已放到桌面"); };
  }
}

module.exports = class MangosteenUpdaterPlugin extends Plugin {
  async onload() {
    this.__mangosteenUpdaterRuntimeVersion = String(this.manifest?.version || "");
    const vaultBasePath = this.app.vault?.adapter?.getBasePath?.() || this.app.vault?.adapter?.basePath || process.cwd();
    const manifestDir = String(this.manifest?.dir || "").trim();
    const manifestPluginRoot = manifestDir
      ? path.resolve(vaultBasePath, ...manifestDir.split(/[\\/]/))
      : "";
    const standardPluginRoot = path.join(vaultBasePath, ".obsidian", "plugins", "mangosteen-updater");
    const pluginRoot = [manifestPluginRoot, standardPluginRoot, __dirname]
      .filter(Boolean)
      .find((candidate, index, values) => values.indexOf(candidate) === index && fs.existsSync(path.join(candidate, "updater-core.cjs")));
    if (!pluginRoot) {
      this.pluginRoot = manifestPluginRoot || standardPluginRoot;
      this.enterDegradedMode(Object.assign(new Error("updater-core.cjs missing"), { code: "PLUGIN_FILES_MISSING" }));
      return;
    }
    this.pluginRoot = pluginRoot;
    try {
      const corePath = path.join(pluginRoot, "updater-core.cjs");
      const resolvedCorePath = typeof require.resolve === "function" ? require.resolve(corePath) : corePath;
      const moduleCache = require("module")._cache || require.cache;
      if (moduleCache) delete moduleCache[resolvedCorePath];
      const loadedCore = require(corePath);
      if (!Array.isArray(loadedCore.TARGET_PLUGIN_IDS) || typeof loadedCore.classifyPluginHealth !== "function" || typeof loadedCore.createUpdaterCore !== "function") {
        throw Object.assign(new Error("updater core exports invalid"), { code: "PACKAGE_INVALID" });
      }
      ({ TARGET_PLUGIN_IDS, classifyPluginHealth, createUpdaterCore } = loadedCore);
      this.core = createUpdaterCore({ request: (options) => requestUrl({ ...options, throw: false }) });
    } catch (error) {
      this.enterDegradedMode(error);
      return;
    }
    this.running = false;
    this.startupEnableAttempts = new Set();
    this.recoveryShown = new Set();
    this.disableCommunityAutoUpdates();
    if (typeof PluginSettingTab === "function") {
      const owner = this;
      this.addSettingTab(new class extends PluginSettingTab {
        constructor(app, plugin) { super(app, plugin); this.id = "mangosteen-updater"; this.name = "山竹插件更新"; }
        display() {
          this.containerEl.empty();
          this.containerEl.createEl("h2", { text: "山竹插件更新" });
          this.containerEl.createEl("p", { text: owner.communityUpdateStatus || "已关闭 Obsidian 社区插件自动更新。" });
          this.containerEl.createEl("p", { text: "更新只会访问山竹套件和 Claudian 两个 Gitee 清单；兼容测试通过后才会推送。" });
          const button = this.containerEl.createEl("button", { text: "立即检查更新" });
          button.onclick = () => void owner.checkForUpdates({ manual: true });
        }
      }(this.app, this));
    }
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.showDeferredResult(), 800);
      window.setTimeout(() => void this.runStartupChecks(), 1200);
    });
  }

  enterDegradedMode(error) {
    this.degraded = true;
    if (this.coreFailureReported) return;
    this.coreFailureReported = true;
    let diagnostic = "";
    try { diagnostic = this.writeDiagnostic("mangosteen-updater", error?.code || "PLUGIN_FILES_MISSING", error); } catch (_) {}
    const suffix = diagnostic ? `\n诊断文件：${diagnostic}` : "";
    new Notice(`更新器核心组件加载失败，已停止自动重试；请重新安装完整包。${suffix}`, 20000);
  }

  disableCommunityAutoUpdates() {
    const key = "plugin-automatically-check-for-updates";
    try {
      this.app.saveLocalStorage?.(key, false);
      this.communityUpdateStatus = "已关闭 Obsidian 社区插件自动更新。山竹更新器会管理已验证的兼容版本。";
      return true;
    } catch (_) {
      this.communityUpdateStatus = "无法关闭 Obsidian 社区插件自动更新，请在 Obsidian 设置中手动关闭。";
      return false;
    }
  }

  getUpdaterBridge() { return { checkForUpdates: (options) => this.checkForUpdates(options), repairPlugin: (id) => this.repairPlugin(id) }; }
  vaultPath() { return this.app.vault?.adapter?.getBasePath?.() || this.app.vault?.adapter?.basePath || process.cwd(); }
  currentVersion() { return String(this.manifest.version || "0.0.0"); }
  installedVersions() {
    const pluginRoot = path.join(this.vaultPath(), ".obsidian", "plugins");
    return Object.fromEntries(TARGET_PLUGIN_IDS.map((id) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, id, "manifest.json"), "utf8"));
        return [id, String(manifest.version || "0.0.0")];
      } catch (_) { return [id, "0.0.0"]; }
    }));
  }

  legacyMigrationPending() {
    const pluginRoot = path.join(this.vaultPath(), ".obsidian", "plugins");
    return fs.existsSync(path.join(pluginRoot, "mangosteen-agent", "manifest.json"))
      && !fs.existsSync(path.join(pluginRoot, "mangosteen-media-core", "manifest.json"));
  }

  async runStartupChecks() {
    if (this.legacyMigrationPending()) return this.installConfirmedUpdate();
    const checked = await this.checkForUpdates({ manual: false });
    if (checked?.updateAvailable !== false) return checked;
    await this.ensureRequiredPluginsEnabled({ oncePerSession: true });
    return this.checkRequiredPlugins();
  }

  confirmUpdate(version, notes) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      const modal = new UpdateConfirmModal(this.app, version, notes, finish);
      modal.open();
    });
  }

  async checkForUpdates({ manual = false } = {}) {
    if (this.running) return { ok: false, code: "BUSY" };
    this.running = true;
    try {
      const checked = await this.core.check(this.installedVersions());
      if (!checked.updateAvailable) { if (manual) new Notice(`已经是最新版（${checked.manifest.version}）`); return checked; }
      if (!await this.confirmUpdate(checked.manifest.version, checked.manifest.notes)) return { ok: true, cancelled: true };
      return await this.installConfirmedUpdate();
    } catch (error) {
      if (manual) new Notice(ERROR_TEXT[error?.code] || "检查更新失败，请稍后重试。", 12000);
      return { ok: false, code: error?.code || "UPDATE_FAILED" };
    } finally { this.running = false; }
  }

  async installConfirmedUpdate() {
    const vaultPath = this.vaultPath();
    const status = new Notice("正在准备山竹插件更新…", 0);
    try {
      const prepared = await this.core.prepare({ vaultPath, installedVersions: this.installedVersions(), onStatus: (text) => status.setMessage?.(text) });
      if (!prepared.prepared) return prepared;
      try {
        await this.app.plugins?.setEnable?.(true);
        await this.ensureRequiredPluginsEnabled();
      } catch (_) { /* The external post-update activator performs the final verified recovery. */ }
      await this.launchDeferredInstall({ vaultPath, version: prepared.version });
      status.hide?.();
      new Notice("更新包校验完成，正在重启 Obsidian 完成更新…", 0);
      if (process.platform === "win32") window.setTimeout(() => window.close(), 500);
      return { ok: true, prepared: true, restarting: true, version: prepared.version };
    } catch (error) {
      status.hide?.();
      const diagnostic = this.writeDiagnostic(error?.pluginId || "update", error?.code || "UPDATE_FAILED", error);
      new Notice(`${ERROR_TEXT[error?.code] || "更新启动失败，当前插件没有被修改。"}\n诊断文件：${diagnostic}`, 20000);
      return { ok: false, code: error?.code || "UPDATE_FAILED", diagnostic };
    }
  }

  launchDeferredInstall({ vaultPath }) {
    if (process.platform === "darwin") {
      const helper = path.join(this.pluginRoot, "restart-update.sh");
      if (!fs.existsSync(helper)) throw Object.assign(new Error("缺少 Mac 重启更新程序"), { code: "PACKAGE_INVALID" });
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn("/bin/bash", [
            helper, "--vault-path", vaultPath, "--wait-process-id", String(process.pid),
            "--request-quit",
          ], { detached: true, stdio: "ignore" });
        } catch (error) {
          reject(Object.assign(error, { code: "UPDATE_LAUNCH_FAILED" }));
          return;
        }
        child.once("error", (error) => reject(Object.assign(error, { code: "UPDATE_LAUNCH_FAILED" })));
        child.once("spawn", () => { child.unref(); resolve(child.pid); });
      });
    }
    if (process.platform !== "win32") {
      throw Object.assign(new Error(`不支持的系统：${process.platform}`), { code: "UPDATE_LAUNCH_FAILED" });
    }
    const helper = path.join(this.pluginRoot, "restart-update.ps1");
    if (!fs.existsSync(helper)) throw Object.assign(new Error("缺少重启更新程序"), { code: "PACKAGE_INVALID" });
    const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const innerScript = `& ${psLiteral(helper)} -VaultPath ${psLiteral(vaultPath)} -WaitProcessId ${process.pid} -ObsidianExecutable ${psLiteral(process.execPath)}`;
    const innerEncoded = Buffer.from(innerScript, "utf16le").toString("base64");
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
    if (!windowsRoot) throw Object.assign(new Error("无法定位 Windows PowerShell"), { code: "UPDATE_LAUNCH_FAILED" });
    const powershellExe = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const outerScript = [
      "$ProgressPreference='SilentlyContinue'",
      "$ErrorActionPreference='Stop'",
      "$exe=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
      `$launchArgs=@('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand','${innerEncoded}')`,
      "$commandLine='\"'+$exe+'\" '+($launchArgs -join ' ')",
      "$created=$null",
      "$cimReturn=-1",
      "$cimError=$null",
      "function Test-AccessDenied($record){if(-not $record){return $false};$exception=$record.Exception;if($exception -is [UnauthorizedAccessException]){return $true};if($exception.HResult -eq -2147024891){return $true};$native=$exception.PSObject.Properties['NativeErrorCode'];return ($native -and [int]$native.Value -eq 5)}",
      "try{$created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine} -ErrorAction Stop;$cimReturn=[int]$created.ReturnValue}catch{$cimError=$_}",
      "if($created -and [int]$created.ReturnValue -eq 0 -and [int]$created.ProcessId -gt 0){Write-Output ('PROCESS_ID='+[string]$created.ProcessId);exit 0}",
      "try{$fallback=Start-Process -FilePath $exe -ArgumentList $launchArgs -WindowStyle Hidden -PassThru -ErrorAction Stop;if(-not $fallback -or [int]$fallback.Id -le 0){throw 'START_PROCESS_FAILED'};Write-Output ('PROCESS_ID='+[string]$fallback.Id)}catch{$fallbackError=$_;if($cimReturn -in @(2,3) -or (Test-AccessDenied $cimError) -or (Test-AccessDenied $fallbackError)){throw 'MANGOSTEEN_LAUNCH_ACCESS_DENIED'};throw}",
    ].join(";");
    const encoded = Buffer.from(outerScript, "utf16le").toString("base64");
    return new Promise((resolve, reject) => {
      execFile(powershellExe, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
      ], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
        const match = String(stdout || "").match(/PROCESS_ID=(\d+)/);
        if (error || !match) {
          const raw = String(stderr || error?.message || "后台更新程序未返回进程编号");
          const accessDenied = raw.includes("MANGOSTEEN_LAUNCH_ACCESS_DENIED");
          const detail = accessDenied ? "系统安全策略拒绝启动后台更新程序。" : raw.trim();
          reject(Object.assign(new Error(detail), { code: accessDenied ? "UPDATE_LAUNCH_ACCESS_DENIED" : "UPDATE_LAUNCH_FAILED" }));
          return;
        }
        resolve(Number(match[1]));
      });
    });
  }

  showDeferredResult(attempt = 0) {
    const file = path.join(this.vaultPath(), ".mangosteen-updater", "result.json");
    if (!fs.existsSync(file)) {
      if (attempt < 30) window.setTimeout(() => this.showDeferredResult(attempt + 1), 500);
      return;
    }
    try {
      const result = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      if (result.status === "success") new Notice(`山竹插件已更新到 ${result.version}。`, 12000);
      else if (result.status === "activation_warning") new Notice(`山竹插件已更新到 ${result.version}，但自动开启未通过校验。\n请把诊断文件发给售后老师：${result.diagnostic || "桌面警告日志"}`, 30000);
      else new Notice(`更新失败，旧版本已恢复。\n诊断文件：${result.diagnostic || "请联系售后老师"}`, 20000);
    } finally { fs.rmSync(file, { force: true }); }
  }

  isLoaded(id) { return Boolean(this.app.plugins?.plugins?.[id]); }
  isEnabled(id) { return Boolean(this.app.plugins?.enabledPlugins?.has?.(id) || this.isLoaded(id)); }

  inspectPlugin(id) {
    const folder = path.join(this.vaultPath(), ".obsidian", "plugins", id);
    const manifestPath = path.join(folder, "manifest.json");
    let manifestValid = false;
    let pluginVersion = "";
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifestValid = manifest?.id === id;
      pluginVersion = String(manifest?.version || "");
    } catch (_) {}
    return {
      folderExists: fs.existsSync(folder), manifestValid, mainExists: fs.existsSync(path.join(folder, "main.js")),
      enabled: this.isEnabled(id), loaded: this.isLoaded(id),
      pluginVersion,
      updaterRuntimeVersion: String(this.manifest?.version || ""),
      obsidianVersion: String(this.app?.version || this.app?.appVersion || ""),
    };
  }

  async checkRequiredPlugins() {
    for (const id of TARGET_PLUGIN_IDS) {
      const code = classifyPluginHealth(this.inspectPlugin(id));
      if (code !== "OK") {
        if (!this.recoveryShown.has(id)) {
          this.recoveryShown.add(id);
          new RecoveryModal(this.app, this, id, code).open();
        }
        return { ok: false, id, code };
      }
    }
    return { ok: true };
  }

  async ensureRequiredPluginsEnabled({ oncePerSession = false } = {}) {
    const failed = [];
    for (const id of TARGET_PLUGIN_IDS) {
      if (this.isLoaded(id)) continue;
      if (oncePerSession && this.startupEnableAttempts.has(id)) { failed.push(id); continue; }
      if (oncePerSession) this.startupEnableAttempts.add(id);
      const health = this.inspectPlugin(id);
      if (!health.folderExists || !health.manifestValid || !health.mainExists) { failed.push(id); continue; }
      try {
        if (typeof this.app.plugins.enablePluginAndSave === "function") {
          await this.app.plugins.enablePluginAndSave(id);
        } else {
          await this.app.plugins.enablePlugin(id);
          this.app.plugins.enabledPlugins?.add?.(id);
          await this.app.plugins.saveEnabledPlugins?.();
        }
        if (!this.isLoaded(id)) failed.push(id);
      } catch (_) { failed.push(id); }
    }
    return { ok: failed.length === 0, failed };
  }

  async repairPlugin(id) {
    const before = classifyPluginHealth(this.inspectPlugin(id));
    if (before === "PLUGIN_FILES_MISSING") return { ok: false, code: before, diagnostic: this.writeDiagnostic(id, before) };
    try {
      if (this.isLoaded(id)) await this.app.plugins.disablePlugin(id);
      if (typeof this.app.plugins.enablePluginAndSave === "function") await this.app.plugins.enablePluginAndSave(id);
      else {
        await this.app.plugins.enablePlugin(id);
        this.app.plugins.enabledPlugins?.add?.(id);
        await this.app.plugins.saveEnabledPlugins?.();
      }
      if (this.isLoaded(id)) {
        this.startupEnableAttempts.delete(id);
        this.recoveryShown.delete(id);
        new Notice(`${LABELS[id] || id} 已恢复加载。`);
        return { ok: true };
      }
    } catch (error) {
      const code = classifyPluginHealth(this.inspectPlugin(id));
      const diagnosticCode = code === "OK" ? "PLUGIN_LOAD_FAILED" : code;
      return { ok: false, code: diagnosticCode, diagnostic: this.writeDiagnostic(id, diagnosticCode, error) };
    }
    const code = classifyPluginHealth(this.inspectPlugin(id));
    const diagnosticCode = code === "OK" ? "PLUGIN_LOAD_FAILED" : code;
    return { ok: false, code: diagnosticCode, diagnostic: this.writeDiagnostic(id, diagnosticCode) };
  }

  writeDiagnostic(id, code, error) {
    const desktop = path.join(os.homedir(), "Desktop");
    const target = fs.existsSync(desktop) ? desktop : this.vaultPath();
    const file = path.join(target, `山竹插件加载故障-${Date.now()}.txt`);
    const health = id === "update" ? {} : this.inspectPlugin(id);
    fs.writeFileSync(file, [
      `时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      `插件：${LABELS[id] || id}`,
      `诊断码：${code}`,
      `状态：${JSON.stringify(health)}`,
      `错误：${String(error?.message || "未捕获到具体错误").replace(/sk-[A-Za-z0-9_-]+/g, "[已隐藏]")}`,
      "处理建议：把本文件发给售后老师。",
    ].join("\r\n"), "utf8");
    return file;
  }
};
