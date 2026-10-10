const assert = require("assert");
const { patchMangosteenAgentMain } = require("../patch-mangosteen-agent-structured-analysis.cjs");

const fixture = `
function failure(code) {
  return { ok: false, code };
}
function failureFor(response) {
  const status = Number(response?.status || 0);
  const message = String(response?.json?.message || response?.json?.error?.message || "");
  if (status === 401 || status === 403) return failure("AUTH_REQUIRED");
  if (/quota|balance|credit|余额|额度/i.test(message)) return failure("INSUFFICIENT_QUOTA");
  return failure(status >= 400 ? "REMOTE_REJECTED" : "INVALID_RESPONSE");
}
function responseText(value) {
  const direct = String(value?.output_text || "").trim();
  if (direct) return direct;
  for (const item of Array.isArray(value?.output) ? value.output : []) {
    if (item?.type !== "message") continue;
    const text = (Array.isArray(item.content) ? item.content : [])
      .filter((part) => part?.type === "output_text" || part?.type === "text")
      .map((part) => String(part?.text || ""))
      .join("")
      .trim();
    if (text) return text;
  }
  const compatible = value?.choices?.[0]?.message?.content;
  return typeof compatible === "string" ? compatible.trim() : "";
}
async function call(options) {
  try {
    return await request(options);
    } catch (_) {
      return failure("NETWORK_UNAVAILABLE");
    }
}
    async createLanguageResponse(apiKey, model, input) {
      if (!apiKey || !model || !Array.isArray(input) || !input.length) return failure("INVALID_INPUT");
      const result = await call({
        url: API_BASE + "/v1/responses", method: "POST",
        headers: { Authorization: "Bearer " + String(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({ model: String(model), input, store: false, stream: false }),
      });
      if (!result.ok) return result;
      const text = responseText(result.response.json);
      return text ? { ok: true, text } : failure("INVALID_RESPONSE");
    },
  function activeKey() {
    if (!catalogReady) return "";
    const group = activeGroup();
    return String(state.groupKeys?.[group] || "");
  }
    plugin.getAihubkitVideoBridge = () => getVideoBridge();
`;

const patched = patchMangosteenAgentMain(fixture);
assert.match(patched, /async createLanguageResponse\(apiKey, model, input, options = \{\}\)/);
assert.match(patched, /type: "json_schema"/);
assert.match(patched, /method: "POST", throw: false/);
assert.match(patched, /safeLogDetail\(error\?\.message \|\| error\)/);
assert.match(patched, /async function analyzeStructured/);
assert.match(patched, /attempt <= 3/);
assert.match(patched, /attempt <= 2/);
assert.match(patched, /images\.length > 10/);
assert.match(patched, /const candidates = \[cleaned\]/);
assert.match(patched, /item\?\.type === "function_call"/);
assert.match(patched, /const text = responseText\(result\.response\.json\)/);
assert.doesNotMatch(patched, /function structuredResponseText/);
assert.match(patched, /plugin\.analyzeStructured = analyzeStructured/);
assert.match(patched, /function getLanguageModelCatalog/);
assert.match(patched, /const requestedGroup = String\(options\.group/);
assert.match(patched, /function structuredAnalysisError/);
assert.match(patched, /plugin\.getLanguageModelCatalog = getLanguageModelCatalog/);
assert.strictEqual(patchMangosteenAgentMain(patched), patched, "patch must be idempotent");
assert.throws(() => patchMangosteenAgentMain("unrelated bundle"), /无法定位山竹智能体/);

const retryUpload = `    for (let index = 0; index < images.length; index += 1) {
      let uploaded;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        uploaded = await api.uploadTemporaryImage(state.account, images[index]);
        if (uploaded.ok || uploaded.code !== "NETWORK_UNAVAILABLE" || attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 350));
      }
      if (!uploaded?.ok) {
        const uploadError = structuredAnalysisError(uploaded, false);
        uploadError.message = "第 " + (index + 1) + " 张参考图上传失败：" + uploadError.message;
        throw uploadError;
      }
      content.push({ type: "input_image", image_url: uploaded.url });
    }`;
const simpleUpload = `    for (const image of images) {
      const uploaded = await api.uploadTemporaryImage(state.account, image);
      if (!uploaded.ok) throw new Error(structuredAnalysisFailureMessage(uploaded));
      content.push({ type: "input_image", image_url: uploaded.url });
    }`;
const retryModel = `    let result;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      result = await api.createLanguageResponse(
        key,
        model,
        [{ role: "user", content }],
        { schema, schemaName: options.schemaName },
      );
      if (result.ok || result.code !== "NETWORK_UNAVAILABLE" || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!result?.ok) throw structuredAnalysisError(result);`;
const simpleModel = `    const result = await api.createLanguageResponse(
      key,
      model,
      [{ role: "user", content }],
      { schema, schemaName: options.schemaName },
    );
    if (!result.ok) throw new Error(structuredAnalysisFailureMessage(result));`;
const tolerantParser = `  function parseStructuredAnalysis(text) {
    const fence = String.fromCharCode(96).repeat(3);
    let cleaned = String(text || "").trim();
    if (cleaned.startsWith(fence)) cleaned = cleaned.slice(3).replace(/^json\\s*/i, "");
    if (cleaned.endsWith(fence)) cleaned = cleaned.slice(0, -3).trim();
    const candidates = [cleaned];
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
    for (const candidate of candidates) {
      try {
        const value = JSON.parse(candidate);
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      } catch (_) {}
    }
    throw structuredAnalysisError({ code: "INVALID_RESPONSE", detail: "结构化结果无法读取" }, true);
  }`;
const strictParser = `  function parseStructuredAnalysis(text) {
    const fence = String.fromCharCode(96).repeat(3);
    let cleaned = String(text || "").trim();
    if (cleaned.startsWith(fence)) cleaned = cleaned.slice(3).replace(/^json\\s*/i, "");
    if (cleaned.endsWith(fence)) cleaned = cleaned.slice(0, -3).trim();
    try {
      const value = JSON.parse(cleaned);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid root");
      return value;
    } catch (_) {
      throw new Error("山竹模型已返回内容，但结构化结果无法读取，请重新分析。");
    }
  }`;
const regularResponseReader = `function responseText(value) {
  const direct = String(value?.output_text || "").trim();
  if (direct) return direct;
  for (const item of Array.isArray(value?.output) ? value.output : []) {
    if (item?.type !== "message") continue;
    const text = (Array.isArray(item.content) ? item.content : [])
      .filter((part) => part?.type === "output_text" || part?.type === "text")
      .map((part) => String(part?.text || ""))
      .join("")
      .trim();
    if (text) return text;
  }
  const compatible = value?.choices?.[0]?.message?.content;
  return typeof compatible === "string" ? compatible.trim() : "";
}`;
const functionCallResponseReader = `function responseText(value) {
  const direct = String(value?.output_text || "").trim();
  if (direct) return direct;
  for (const item of Array.isArray(value?.output) ? value.output : []) {
    if (item?.type === "function_call") {
      const argumentText = typeof item.arguments === "string" ? item.arguments.trim() : "";
      if (argumentText) return argumentText;
    }
    if (item?.type !== "message") continue;
    const text = (Array.isArray(item.content) ? item.content : [])
      .filter((part) => part?.type === "output_text" || part?.type === "text")
      .map((part) => String(part?.text || ""))
      .join("")
      .trim();
    if (text) return text;
  }
  const compatible = value?.choices?.[0]?.message?.content;
  return typeof compatible === "string" ? compatible.trim() : "";
}`;
const legacyStructuredHelper = `  function structuredResponseText(value) {
    const regularText = responseText(value);
    if (regularText) return regularText;
    for (const item of Array.isArray(value?.output) ? value.output : []) {
      if (item?.type !== "function_call") continue;
      const argumentText = typeof item.arguments === "string" ? item.arguments.trim() : "";
      if (argumentText) return argumentText;
    }
    return "";
  }

`;
const legacyV6 = patched
  .replace("/* mangosteen-structured-analysis-v8 */", `/* mangosteen-structured-analysis-v6 */\n${legacyStructuredHelper.trimEnd()}`)
  .replace(functionCallResponseReader, regularResponseReader)
  .replace("const text = responseText(result.response.json);", "const text = structuredResponseText(result.response.json);");
const upgradedV6 = patchMangosteenAgentMain(legacyV6);
assert.match(upgradedV6, /mangosteen-structured-analysis-v8/);
assert.match(upgradedV6, /item\?\.type === "function_call"/);
assert.doesNotMatch(upgradedV6, /function structuredResponseText/);

const legacyV5 = patched
  .replace("/* mangosteen-structured-analysis-v8 */", "/* mangosteen-structured-analysis-v5 */")
  .replace(functionCallResponseReader, regularResponseReader);
const upgradedV5 = patchMangosteenAgentMain(legacyV5);
assert.match(upgradedV5, /mangosteen-structured-analysis-v8/);
assert.match(upgradedV5, /item\?\.type === "function_call"/);

const legacyV4 = legacyV5
  .replace("/* mangosteen-structured-analysis-v5 */", "/* mangosteen-structured-analysis-v4 */")
  .replace(tolerantParser, strictParser);
const upgradedV4 = patchMangosteenAgentMain(legacyV4);
assert.match(upgradedV4, /mangosteen-structured-analysis-v8/);
assert.match(upgradedV4, /const candidates = \[cleaned\]/);

const legacyV3 = legacyV4
  .replace("/* mangosteen-structured-analysis-v4 */", "/* mangosteen-structured-analysis-v3 */")
  .replace('images.length > 10', 'images.length > 12')
  .replace('最多支持 10 张参考图', '最多支持 12 张参考图');
const upgradedV3 = patchMangosteenAgentMain(legacyV3);
assert.match(upgradedV3, /mangosteen-structured-analysis-v8/);
assert.match(upgradedV3, /images\.length > 10/);

const legacyV2 = legacyV3
  .replace("/* mangosteen-structured-analysis-v3 */", "/* mangosteen-structured-analysis-v2 */")
  .replace(retryUpload, simpleUpload)
  .replace(retryModel, simpleModel);
const upgradedV2 = patchMangosteenAgentMain(legacyV2);
assert.match(upgradedV2, /mangosteen-structured-analysis-v8/);
assert.match(upgradedV2, /attempt <= 3/);

const legacyV1 = legacyV2.replace("/* mangosteen-structured-analysis-v2 */", "/* mangosteen-structured-analysis-v1 */")
  .replace('function failure(code, details = {}) {\n  return { ok: false, code, ...details };\n}', 'function failure(code) {\n  return { ok: false, code };\n}')
  .replace('function failureFor(response) {\n  const status = Number(response?.status || 0);\n  const message = safeLogDetail(response?.json?.message || response?.json?.error?.message || "");\n  const details = { status, ...(message ? { detail: message } : {}) };\n  if (status === 401 || status === 403) return failure("AUTH_REQUIRED", details);\n  if (/quota|balance|credit|余额|额度/i.test(message)) return failure("INSUFFICIENT_QUOTA", details);\n  return failure(status >= 400 ? "REMOTE_REJECTED" : "INVALID_RESPONSE", details);\n}', 'function failureFor(response) {\n  const status = Number(response?.status || 0);\n  const message = String(response?.json?.message || response?.json?.error?.message || "");\n  if (status === 401 || status === 403) return failure("AUTH_REQUIRED");\n  if (/quota|balance|credit|余额|额度/i.test(message)) return failure("INSUFFICIENT_QUOTA");\n  return failure(status >= 400 ? "REMOTE_REJECTED" : "INVALID_RESPONSE");\n}')
  .replace('    } catch (error) {\n      return failure("NETWORK_UNAVAILABLE", { detail: safeLogDetail(error?.message || error) });\n    }', '    } catch (_) {\n      return failure("NETWORK_UNAVAILABLE");\n    }')
  .replace('method: "POST", throw: false,', 'method: "POST",')
  .replace('structuredAnalysisFailureMessage(result) {', 'structuredAnalysisFailureMessage(code) {')
  .replace('    const code = typeof result === "string" ? result : String(result?.code || "");\n    const detail = typeof result === "object" ? String(result?.detail || "").trim() : "";\n    const suffix = detail ? "：" + detail : "。";\n', '')
  .replace('    if (code === "AUTH_REQUIRED") return "山竹账号未登录或登录已失效，请重新登录。";', '    if (code === "AUTH_REQUIRED") return "山竹账号未登录，请先打开山竹账号中心登录。";')
  .replace('    if (code === "NETWORK_UNAVAILABLE") return "暂时无法连接山竹模型服务" + suffix;', '    if (code === "NETWORK_UNAVAILABLE") return "暂时无法连接山竹模型服务，请检查网络后重试。";')
  .replace('    if (code === "REMOTE_REJECTED") return "山竹模型不接受本次分析请求" + suffix;\n', '')
  .replace('    if (code === "INVALID_RESPONSE") return "山竹模型返回了无法读取的结果" + suffix;\n', '')
  .replace('    return "山竹大语言模型分析失败" + suffix;', '    return "山竹大语言模型分析失败，请稍后重试。";')
  .replaceAll('structuredAnalysisFailureMessage(catalog)', 'structuredAnalysisFailureMessage(catalog.code)')
  .replaceAll('structuredAnalysisFailureMessage(uploaded)', 'structuredAnalysisFailureMessage(uploaded.code)')
  .replaceAll('structuredAnalysisFailureMessage(result)', 'structuredAnalysisFailureMessage(result.code)');
const upgradedV1 = patchMangosteenAgentMain(legacyV1);
assert.match(upgradedV1, /mangosteen-structured-analysis-v8/);
assert.match(upgradedV1, /method: "POST", throw: false/);
assert.match(upgradedV1, /structuredAnalysisFailureMessage\(result\)/);

console.log("patch-mangosteen-agent-structured-analysis: ok");
