ObjC.import("Foundation");

const fileManager = $.NSFileManager.defaultManager;

function readText(path) {
  const value = $.NSString.stringWithContentsOfFileEncodingError(
    $(path),
    $.NSUTF8StringEncoding,
    null,
  );
  if (!value) throw new Error(`无法读取文件：${path}`);
  return ObjC.unwrap(value).replace(/^\uFEFF/, "");
}

function writeText(path, text) {
  const written = $(text).writeToFileAtomicallyEncodingError(
    $(path),
    true,
    $.NSUTF8StringEncoding,
    null,
  );
  if (!written) throw new Error(`无法写入文件：${path}`);
}

function fileExists(path) {
  return Boolean(fileManager.fileExistsAtPath($(path)));
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function validate(argv) {
  const [pendingPath, extractedPath, componentsPath, versionPath] = argv;
  const pending = readJson(pendingPath);
  const allowed = [
    "mangosteen-claudian",
    "mangosteen-image",
    "mangosteen-media-core",
    "mangosteen-updater",
    "mangosteen-video",
    "mangosteen-workbench",
  ];
  const components = pending.components;
  if (pending.schemaVersion !== 2 || !components || typeof components !== "object" || Array.isArray(components)) {
    throw new Error("更新组件清单无效");
  }
  const componentIds = Object.keys(components).sort();
  if (JSON.stringify(componentIds) !== JSON.stringify(allowed)) throw new Error("更新组件清单无效");
  if (JSON.stringify(pending.removeAfterVerify) !== JSON.stringify(["mangosteen-agent"])) {
    throw new Error("旧插件迁移清单无效");
  }
  const lines = [];
  for (const pluginId of componentIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginId)) throw new Error("插件 ID 无效");
    const pluginRoot = `${extractedPath}/${pluginId}`;
    const manifest = readJson(`${pluginRoot}/manifest.json`);
    if (manifest.id !== pluginId || String(manifest.version) !== String(components[pluginId])) {
      throw new Error(`更新插件版本无效：${pluginId}`);
    }
    if (!fileExists(`${pluginRoot}/main.js`)) throw new Error(`更新插件文件不完整：${pluginId}`);
    lines.push(`${pluginId}\t${components[pluginId]}`);
  }
  writeText(componentsPath, `${lines.join("\n")}\n`);
  writeText(versionPath, String(pending.version || ""));
}

function updateEnabled(argv) {
  const [path, ...targets] = argv;
  let enabled = [];
  try {
    const value = readJson(path);
    if (Array.isArray(value)) enabled = value.map(String);
  } catch (_) {}
  const targetSet = new Set(targets);
  enabled = enabled.filter((id) => id !== "mangosteen-agent" && !targetSet.has(id));
  writeJson(path, [...targets, ...enabled]);
}

function writeResult(argv) {
  const [path, status, version, diagnostic] = argv;
  writeJson(path, { status, version, diagnostic });
}

function run(argv) {
  const [command, ...rest] = argv;
  if (command === "validate") return validate(rest);
  if (command === "update-enabled") return updateEnabled(rest);
  if (command === "write-result") return writeResult(rest);
  throw new Error(`未知 JSON 操作：${command}`);
}
