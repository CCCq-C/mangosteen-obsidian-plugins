"use strict";

const path = require("path");

function buildActivationExpression(requiredPlugins) {
  const required = JSON.stringify(requiredPlugins.map(String));
  return `(async()=>{
    if(!globalThis.app?.plugins)return JSON.stringify({status:"not-ready"});
    const required=${required};
    const errors=[];
    try{await app.plugins.setEnable(true);}catch(error){errors.push("master:"+String(error?.message||error));}
    for(const id of required){
      if(app.plugins.getPlugin(id))continue;
      try{
        if(typeof app.plugins.enablePluginAndSave==="function")await app.plugins.enablePluginAndSave(id);
        else{
          await app.plugins.enablePlugin(id);
          app.plugins.enabledPlugins?.add?.(id);
          await app.plugins.saveEnabledPlugins?.();
        }
      }catch(error){errors.push(id+":"+String(error?.message||error));}
    }
    await new Promise(resolve=>setTimeout(resolve,1200));
    const missingPlugins=required.filter(id=>!app.plugins.getPlugin(id));
    return JSON.stringify({
      status:missingPlugins.length||errors.length?"plugin-load-failed":"ok",
      enabled:app.plugins.isEnabled?.()!==false,
      missingPlugins,
      errors,
      vaultPath:app.vault?.adapter?.basePath||app.vault?.adapter?.getBasePath?.()||""
    });
  })()`;
}

async function evaluateTarget(WebSocketImpl, target, expression) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => reject(new Error("CDP_EVALUATION_TIMEOUT")), 12000);
    socket.onopen = () => socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || "CDP_EVALUATION_FAILED"));
        return;
      }
      resolve(message.result?.result?.value || "");
    };
    socket.onerror = () => reject(new Error("CDP_SOCKET_FAILED"));
  });
}

async function activate(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  if (typeof fetchImpl !== "function" || typeof WebSocketImpl !== "function") throw new Error("NODE_WEB_API_UNAVAILABLE");
  const expectedVault = path.resolve(options.vaultPath).toLowerCase();
  const expression = buildActivationExpression(options.requiredPlugins);
  const deadline = Date.now() + options.timeoutMs;
  let last = "OBSIDIAN_RENDERER_NOT_READY";
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetchImpl(`http://127.0.0.1:${options.port}/json/list`)).json();
      for (const target of targets.filter((item) => item.type === "page")) {
        try {
          const value = JSON.parse(await evaluateTarget(WebSocketImpl, target, expression) || "{}");
          const actualVault = path.resolve(String(value.vaultPath || "")).toLowerCase();
          if (value.status === "ok" && value.enabled === true && actualVault === expectedVault) return value;
          last = JSON.stringify(value);
        } catch (error) { last = String(error?.message || error); }
      }
    } catch (error) { last = String(error?.message || error); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(last);
}

async function main(argv = process.argv.slice(2)) {
  const [portText, vaultPath, timeoutText, pluginText] = argv;
  const result = await activate({
    port: Number(portText),
    vaultPath,
    timeoutMs: Number(timeoutText) * 1000,
    requiredPlugins: String(pluginText || "").split(",").filter(Boolean),
  });
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
}

module.exports = { activate, buildActivationExpression };
