const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Modal: class Modal {},
      Notice: class Notice {},
      Plugin: class Plugin {},
      requestUrl: async () => ({ status: 200 }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ImagePlugin = require("../main.js");
Module._load = originalLoad;

(async () => {
  const plugin = new ImagePlugin();
  let polls = 0;
  plugin.api = {
    readImageTaskProgress: () => null,
    readImageTaskState: () => "processing",
  };
  plugin.extractResults = () => (++polls >= 91 ? [{ kind: "url", value: "https://example.test/image.png" }] : []);
  plugin.fetchImageTask = async () => ({ data: { status: "processing" } });
  plugin.saveSettings = async () => {};
  plugin.refreshImageTaskViews = () => {};

  const originalWindow = global.window;
  global.window = { setTimeout: (callback) => { callback(); return 1; } };
  try {
    const task = { id: "slow-image-task", status: "processing" };
    const response = await plugin.waitForImageTask(task);
    assert.strictEqual(response.__mangosteenTaskId, task.id);
    assert.strictEqual(task.status, "completed");
    assert.strictEqual(polls, 91, "a valid image task taking just over three minutes must not be abandoned");
  } finally {
    global.window = originalWindow;
  }

  console.log("image-plugin: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
