#!/usr/bin/env node

const fs = require("fs");

const MARKER = "/* mangosteen-structured-analysis-v8 */";
const LEGACY_MARKER_V7 = "/* mangosteen-structured-analysis-v7 */";
const LEGACY_MARKER_V6 = "/* mangosteen-structured-analysis-v6 */";
const LEGACY_MARKER_V5 = "/* mangosteen-structured-analysis-v5 */";
const LEGACY_MARKER_V4 = "/* mangosteen-structured-analysis-v4 */";
const LEGACY_MARKER_V3 = "/* mangosteen-structured-analysis-v3 */";
const LEGACY_MARKER_V2 = "/* mangosteen-structured-analysis-v2 */";
const LEGACY_MARKER_V1 = "/* mangosteen-structured-analysis-v1 */";

function replaceOnce(source, search, replacement, errorMessage) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(errorMessage);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function patchMangosteenAgentMain(contents) {
  let output = String(contents || "").replace(/\r\n/g, "\n");
  if (output.includes(MARKER)) return output;

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
  const structuredResponseReader = `function responseText(value) {
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

  if (output.includes(LEGACY_MARKER_V7)) {
    output = replaceOnce(output, LEGACY_MARKER_V7, MARKER, "无法升级山竹智能体模型选择接口。");
    if (!output.includes("  function getLanguageModelCatalog() {")) {
      output = replaceOnce(
        output,
        "  function parseStructuredAnalysis(text) {",
        `  function getLanguageModelCatalog() {
    return {
      ready: catalogReady,
      activeGroup: activeGroup(),
      activeModel: String(state.activeModel || ""),
      groups: languageGroups().map((group) => {
        const info = state.groupRatios?.[group] || {};
        return {
          id: group,
          label: String(info.label || group),
          ratio: Number(info.ratio) || 1,
          models: Array.from(state.modelsByGroup?.[group] || []),
        };
      }),
    };
  }

  function structuredAnalysisError(result, changeModel) {
    const code = typeof result === "string" ? result : String(result?.code || "");
    const status = typeof result === "object" ? Number(result?.status || 0) : 0;
    const error = new Error(structuredAnalysisFailureMessage(result));
    error.code = code || "STRUCTURED_ANALYSIS_FAILED";
    if (status) error.status = status;
    error.changeModel = typeof changeModel === "boolean" ? changeModel
      : status === 404 || ["MODELS_UNAVAILABLE", "REMOTE_REJECTED", "INVALID_RESPONSE"].includes(code);
    return error;
  }

  function parseStructuredAnalysis(text) {`,
        "无法定位山竹智能体结构化结果解析入口。",
      );
    }
    if (output.includes(`    throw new Error("山竹模型已返回内容，但结构化结果无法读取，请重新分析。");`)) {
      output = replaceOnce(
        output,
        `    throw new Error("山竹模型已返回内容，但结构化结果无法读取，请重新分析。");`,
        `    throw structuredAnalysisError({ code: "INVALID_RESPONSE", detail: "结构化结果无法读取" }, true);`,
        "无法升级山竹智能体结构化解析错误。",
      );
    }
    const legacyModelSelection = `      if (!catalog.ok) throw new Error(structuredAnalysisFailureMessage(catalog));
    }
    const key = activeKey();
    const model = String(state.activeModel || "").trim();
    if (!key || !model) throw new Error(structuredAnalysisFailureMessage("MODELS_UNAVAILABLE"));`;
    if (output.includes(legacyModelSelection)) {
      output = replaceOnce(
        output,
        legacyModelSelection,
        `      if (!catalog.ok) throw structuredAnalysisError(catalog);
    }
    const requestedGroup = String(options.group || "").trim();
    const requestedModel = String(options.model || "").trim();
    const group = requestedGroup || activeGroup();
    const models = state.modelsByGroup?.[group] || [];
    const model = requestedModel || (group === activeGroup() ? String(state.activeModel || "").trim() : String(models[0] || ""));
    const key = String(state.groupKeys?.[group] || "");
    if (!languageGroups().includes(group) || !models.includes(model) || !key) {
      throw structuredAnalysisError({ code: "MODELS_UNAVAILABLE", status: 404, detail: "所选模型已下架或当前账号不可用" }, true);
    }`,
        "无法升级山竹智能体模型选择流程。",
      );
    }
    const legacyUploadError = `      if (!uploaded?.ok) throw new Error("第 " + (index + 1) + " 张参考图上传失败：" + structuredAnalysisFailureMessage(uploaded));`;
    if (output.includes(legacyUploadError)) {
      output = replaceOnce(
        output,
        legacyUploadError,
        `      if (!uploaded?.ok) {
        const uploadError = structuredAnalysisError(uploaded, false);
        uploadError.message = "第 " + (index + 1) + " 张参考图上传失败：" + uploadError.message;
        throw uploadError;
      }`,
        "无法升级山竹智能体参考图错误类型。",
      );
    }
    if (output.includes(`    if (!result?.ok) throw new Error(structuredAnalysisFailureMessage(result));`)) {
      output = replaceOnce(output, `    if (!result?.ok) throw new Error(structuredAnalysisFailureMessage(result));`, `    if (!result?.ok) throw structuredAnalysisError(result);`, "无法升级山竹智能体模型错误类型。");
    }
    if (output.includes(`    return { data, model, provider: "mangosteen-agent" };`)) {
      output = replaceOnce(output, `    return { data, model, provider: "mangosteen-agent" };`, `    return { data, group, model, provider: "mangosteen-agent" };`, "无法升级山竹智能体结构化分析返回值。");
    }
    if (!output.includes("    plugin.getLanguageModelCatalog = getLanguageModelCatalog;")) {
      output = replaceOnce(output, "    plugin.analyzeStructured = analyzeStructured;", "    plugin.getLanguageModelCatalog = getLanguageModelCatalog;\n    plugin.analyzeStructured = analyzeStructured;", "无法公开山竹智能体模型目录接口。");
    }
    return output;
  }

  if (output.includes(LEGACY_MARKER_V6)) {
    output = replaceOnce(output, LEGACY_MARKER_V6, LEGACY_MARKER_V7, "无法升级山竹智能体结构化响应兼容层。");
    output = replaceOnce(
      output,
      `  function structuredResponseText(value) {
    const regularText = responseText(value);
    if (regularText) return regularText;
    for (const item of Array.isArray(value?.output) ? value.output : []) {
      if (item?.type !== "function_call") continue;
      const argumentText = typeof item.arguments === "string" ? item.arguments.trim() : "";
      if (argumentText) return argumentText;
    }
    return "";
  }
`,
      "",
      "无法移除旧的山竹结构化响应读取器。",
    );
    output = replaceOnce(output, regularResponseReader, structuredResponseReader, "无法定位山竹智能体响应读取器。");
    output = replaceOnce(
      output,
      "      const text = structuredResponseText(result.response.json);",
      "      const text = responseText(result.response.json);",
      "无法修正山竹智能体响应读取调用。",
    );
    return patchMangosteenAgentMain(output);
  }

  if (output.includes(LEGACY_MARKER_V5)) {
    output = replaceOnce(
      output,
      LEGACY_MARKER_V5,
      `${LEGACY_MARKER_V6}
  function structuredResponseText(value) {
    const regularText = responseText(value);
    if (regularText) return regularText;
    for (const item of Array.isArray(value?.output) ? value.output : []) {
      if (item?.type !== "function_call") continue;
      const argumentText = typeof item.arguments === "string" ? item.arguments.trim() : "";
      if (argumentText) return argumentText;
    }
    return "";
  }`,
      "无法升级山竹智能体结构化响应兼容层。",
    );
    output = replaceOnce(
      output,
      "      const text = responseText(result.response.json);",
      "      const text = structuredResponseText(result.response.json);",
      "无法定位山竹智能体结构化响应读取流程。",
    );
    return patchMangosteenAgentMain(output);
  }

  if (output.includes(LEGACY_MARKER_V4)) {
    output = replaceOnce(output, LEGACY_MARKER_V4, LEGACY_MARKER_V5, "无法升级山竹智能体结构化分析接口。");
    output = replaceOnce(
      output,
      `  function parseStructuredAnalysis(text) {
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
  }`,
      `  function parseStructuredAnalysis(text) {
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
    throw new Error("山竹模型已返回内容，但结构化结果无法读取，请重新分析。");
  }`,
      "无法定位山竹智能体结构化结果解析。",
    );
    return patchMangosteenAgentMain(output);
  }

  if (output.includes(LEGACY_MARKER_V3)) {
    output = replaceOnce(output, LEGACY_MARKER_V3, LEGACY_MARKER_V4, "无法升级山竹智能体结构化分析接口。");
    output = replaceOnce(
      output,
      `    if (images.length > 12) throw new Error("结构化分析最多支持 12 张参考图。");`,
      `    if (images.length > 10) throw new Error("结构化分析最多支持 10 张参考图。");`,
      "无法定位山竹智能体参考图数量限制。",
    );
    return patchMangosteenAgentMain(output);
  }

  if (output.includes(LEGACY_MARKER_V2)) {
    output = replaceOnce(output, LEGACY_MARKER_V2, LEGACY_MARKER_V3, "无法升级山竹智能体结构化分析接口。");
    output = replaceOnce(
      output,
      `    for (const image of images) {
      const uploaded = await api.uploadTemporaryImage(state.account, image);
      if (!uploaded.ok) throw new Error(structuredAnalysisFailureMessage(uploaded));
      content.push({ type: "input_image", image_url: uploaded.url });
    }`,
      `    for (let index = 0; index < images.length; index += 1) {
      let uploaded;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        uploaded = await api.uploadTemporaryImage(state.account, images[index]);
        if (uploaded.ok || uploaded.code !== "NETWORK_UNAVAILABLE" || attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 350));
      }
      if (!uploaded?.ok) throw new Error("第 " + (index + 1) + " 张参考图上传失败：" + structuredAnalysisFailureMessage(uploaded));
      content.push({ type: "input_image", image_url: uploaded.url });
    }`,
      "无法定位山竹智能体参考图上传流程。",
    );
    output = replaceOnce(
      output,
      `    const result = await api.createLanguageResponse(
      key,
      model,
      [{ role: "user", content }],
      { schema, schemaName: options.schemaName },
    );
    if (!result.ok) throw new Error(structuredAnalysisFailureMessage(result));`,
      `    let result;
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
    if (!result?.ok) throw new Error(structuredAnalysisFailureMessage(result));`,
      "无法定位山竹智能体结构化模型请求流程。",
    );
    return patchMangosteenAgentMain(output);
  }

  if (output.includes(LEGACY_MARKER_V1)) {
    output = replaceOnce(output, LEGACY_MARKER_V1, LEGACY_MARKER_V2, "无法升级山竹智能体结构化分析接口。");
    output = replaceOnce(
      output,
      `function failure(code) {
  return { ok: false, code };
}`,
      `function failure(code, details = {}) {
  return { ok: false, code, ...details };
}`,
      "无法定位山竹智能体错误返回格式。",
    );
    output = replaceOnce(
      output,
      `function failureFor(response) {
  const status = Number(response?.status || 0);
  const message = String(response?.json?.message || response?.json?.error?.message || "");
  if (status === 401 || status === 403) return failure("AUTH_REQUIRED");
  if (/quota|balance|credit|余额|额度/i.test(message)) return failure("INSUFFICIENT_QUOTA");
  return failure(status >= 400 ? "REMOTE_REJECTED" : "INVALID_RESPONSE");
}`,
      `function failureFor(response) {
  const status = Number(response?.status || 0);
  const message = safeLogDetail(response?.json?.message || response?.json?.error?.message || "");
  const details = { status, ...(message ? { detail: message } : {}) };
  if (status === 401 || status === 403) return failure("AUTH_REQUIRED", details);
  if (/quota|balance|credit|余额|额度/i.test(message)) return failure("INSUFFICIENT_QUOTA", details);
  return failure(status >= 400 ? "REMOTE_REJECTED" : "INVALID_RESPONSE", details);
}`,
      "无法定位山竹智能体服务端错误解析。",
    );
    output = replaceOnce(
      output,
      `    } catch (_) {
      return failure("NETWORK_UNAVAILABLE");
    }`,
      `    } catch (error) {
      return failure("NETWORK_UNAVAILABLE", { detail: safeLogDetail(error?.message || error) });
    }`,
      "无法定位山竹智能体网络错误处理。",
    );
    output = replaceOnce(
      output,
      `        url: API_BASE + "/v1/responses", method: "POST",
        headers:`,
      `        url: API_BASE + "/v1/responses", method: "POST", throw: false,
        headers:`,
      "无法定位山竹智能体结构化模型请求。",
    );
    output = replaceOnce(
      output,
      `  function structuredAnalysisFailureMessage(code) {
    if (code === "AUTH_REQUIRED") return "山竹账号未登录，请先打开山竹账号中心登录。";
    if (code === "INSUFFICIENT_QUOTA") return "山竹账号余额不足，无法分析视频。";
    if (code === "NETWORK_UNAVAILABLE") return "暂时无法连接山竹模型服务，请检查网络后重试。";
    if (code === "MODELS_UNAVAILABLE") return "山竹账号当前没有可用的大语言模型。";
    return "山竹大语言模型分析失败，请稍后重试。";
  }`,
      `  function structuredAnalysisFailureMessage(result) {
    const code = typeof result === "string" ? result : String(result?.code || "");
    const detail = typeof result === "object" ? String(result?.detail || "").trim() : "";
    const suffix = detail ? "：" + detail : "。";
    if (code === "AUTH_REQUIRED") return "山竹账号未登录或登录已失效，请重新登录。";
    if (code === "INSUFFICIENT_QUOTA") return "山竹账号余额不足，无法分析视频。";
    if (code === "NETWORK_UNAVAILABLE") return "暂时无法连接山竹模型服务" + suffix;
    if (code === "MODELS_UNAVAILABLE") return "山竹账号当前没有可用的大语言模型。";
    if (code === "REMOTE_REJECTED") return "山竹模型不接受本次分析请求" + suffix;
    if (code === "INVALID_RESPONSE") return "山竹模型返回了无法读取的结果" + suffix;
    return "山竹大语言模型分析失败" + suffix;
  }`,
      "无法定位山竹智能体结构化错误提示。",
    );
    output = output
      .replaceAll("structuredAnalysisFailureMessage(catalog.code)", "structuredAnalysisFailureMessage(catalog)")
      .replaceAll("structuredAnalysisFailureMessage(uploaded.code)", "structuredAnalysisFailureMessage(uploaded)")
      .replaceAll("structuredAnalysisFailureMessage(result.code)", "structuredAnalysisFailureMessage(result)");
    return patchMangosteenAgentMain(output);
  }

  output = replaceOnce(
    output,
    `function failure(code) {
  return { ok: false, code };
}`,
    `function failure(code, details = {}) {
  return { ok: false, code, ...details };
}`,
    "无法定位山竹智能体错误返回格式。",
  );
  output = replaceOnce(output, regularResponseReader, structuredResponseReader, "无法定位山竹智能体响应读取器。");
  output = replaceOnce(
    output,
    `function failureFor(response) {
  const status = Number(response?.status || 0);
  const message = String(response?.json?.message || response?.json?.error?.message || "");
  if (status === 401 || status === 403) return failure("AUTH_REQUIRED");
  if (/quota|balance|credit|余额|额度/i.test(message)) return failure("INSUFFICIENT_QUOTA");
  return failure(status >= 400 ? "REMOTE_REJECTED" : "INVALID_RESPONSE");
}`,
    `function failureFor(response) {
  const status = Number(response?.status || 0);
  const message = safeLogDetail(response?.json?.message || response?.json?.error?.message || "");
  const details = { status, ...(message ? { detail: message } : {}) };
  if (status === 401 || status === 403) return failure("AUTH_REQUIRED", details);
  if (/quota|balance|credit|余额|额度/i.test(message)) return failure("INSUFFICIENT_QUOTA", details);
  return failure(status >= 400 ? "REMOTE_REJECTED" : "INVALID_RESPONSE", details);
}`,
    "无法定位山竹智能体服务端错误解析。",
  );
  output = replaceOnce(
    output,
    `    } catch (_) {
      return failure("NETWORK_UNAVAILABLE");
    }`,
    `    } catch (error) {
      return failure("NETWORK_UNAVAILABLE", { detail: safeLogDetail(error?.message || error) });
    }`,
    "无法定位山竹智能体网络错误处理。",
  );

  output = replaceOnce(
    output,
    "    async createLanguageResponse(apiKey, model, input) {",
    "    async createLanguageResponse(apiKey, model, input, options = {}) {",
    "无法定位山竹智能体语言接口，请先同步当前插件版本。",
  );
  output = replaceOnce(
    output,
    "      const result = await call({\n        url: API_BASE + \"/v1/responses\", method: \"POST\",",
    `      const body = { model: String(model), input, store: false, stream: false };
      if (options.schema && typeof options.schema === "object" && !Array.isArray(options.schema)) {
        body.text = { format: {
          type: "json_schema",
          name: String(options.schemaName || "structured_analysis").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
          schema: options.schema,
          strict: true,
        } };
      }
      const result = await call({
        url: API_BASE + "/v1/responses", method: "POST", throw: false,`,
    "无法定位山竹智能体 Responses 请求。",
  );
  output = replaceOnce(
    output,
    "        body: JSON.stringify({ model: String(model), input, store: false, stream: false }),",
    "        body: JSON.stringify(body),",
    "无法定位山竹智能体 Responses 请求体。",
  );
  output = replaceOnce(
    output,
    "      const text = responseText(result.response.json);",
    "      const text = responseText(result.response.json);",
    "无法定位山竹智能体结构化响应读取流程。",
  );

  const activeKeyBlock = `  function activeKey() {
    if (!catalogReady) return "";
    const group = activeGroup();
    return String(state.groupKeys?.[group] || "");
  }`;
  const structuredAnalysis = `${activeKeyBlock}

  ${MARKER}
  function structuredAnalysisFailureMessage(result) {
    const code = typeof result === "string" ? result : String(result?.code || "");
    const detail = typeof result === "object" ? String(result?.detail || "").trim() : "";
    const suffix = detail ? "：" + detail : "。";
    if (code === "AUTH_REQUIRED") return "山竹账号未登录或登录已失效，请重新登录。";
    if (code === "INSUFFICIENT_QUOTA") return "山竹账号余额不足，无法分析视频。";
    if (code === "NETWORK_UNAVAILABLE") return "暂时无法连接山竹模型服务" + suffix;
    if (code === "MODELS_UNAVAILABLE") return "山竹账号当前没有可用的大语言模型。";
    if (code === "REMOTE_REJECTED") return "山竹模型不接受本次分析请求" + suffix;
    if (code === "INVALID_RESPONSE") return "山竹模型返回了无法读取的结果" + suffix;
    return "山竹大语言模型分析失败" + suffix;
  }

  function getLanguageModelCatalog() {
    return {
      ready: catalogReady,
      activeGroup: activeGroup(),
      activeModel: String(state.activeModel || ""),
      groups: languageGroups().map((group) => {
        const info = state.groupRatios?.[group] || {};
        return {
          id: group,
          label: String(info.label || group),
          ratio: Number(info.ratio) || 1,
          models: Array.from(state.modelsByGroup?.[group] || []),
        };
      }),
    };
  }

  function structuredAnalysisError(result, changeModel) {
    const code = typeof result === "string" ? result : String(result?.code || "");
    const status = typeof result === "object" ? Number(result?.status || 0) : 0;
    const error = new Error(structuredAnalysisFailureMessage(result));
    error.code = code || "STRUCTURED_ANALYSIS_FAILED";
    if (status) error.status = status;
    error.changeModel = typeof changeModel === "boolean" ? changeModel
      : status === 404 || ["MODELS_UNAVAILABLE", "REMOTE_REJECTED", "INVALID_RESPONSE"].includes(code);
    return error;
  }

  function parseStructuredAnalysis(text) {
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
  }

  async function analyzeStructured(options = {}) {
    const prompt = String(options.prompt || "").trim();
    const images = Array.isArray(options.images) ? options.images : [];
    const schema = options.schema;
    if (!prompt || !schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("结构化分析参数不完整。");
    if (images.length > 10) throw new Error("结构化分析最多支持 10 张参考图。");
    if (!state.account?.userId) throw new Error(structuredAnalysisFailureMessage("AUTH_REQUIRED"));
    if (!catalogReady) {
      const catalog = await refreshAvailableGroups();
      if (!catalog.ok) throw structuredAnalysisError(catalog);
    }
    const requestedGroup = String(options.group || "").trim();
    const requestedModel = String(options.model || "").trim();
    const group = requestedGroup || activeGroup();
    const models = state.modelsByGroup?.[group] || [];
    const model = requestedModel || (group === activeGroup() ? String(state.activeModel || "").trim() : String(models[0] || ""));
    const key = String(state.groupKeys?.[group] || "");
    if (!languageGroups().includes(group) || !models.includes(model) || !key) {
      throw structuredAnalysisError({ code: "MODELS_UNAVAILABLE", status: 404, detail: "所选模型已下架或当前账号不可用" }, true);
    }
    const content = [{ type: "input_text", text: prompt }];
    for (let index = 0; index < images.length; index += 1) {
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
    }
    let result;
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
    if (!result?.ok) throw structuredAnalysisError(result);
    const data = parseStructuredAnalysis(result.text);
    writeOperation("结构化分析", "山竹模型已完成视频分镜分析");
    return { data, group, model, provider: "mangosteen-agent" };
  }`;
  output = replaceOnce(output, activeKeyBlock, structuredAnalysis, "无法定位山竹智能体账号模型状态。");
  output = replaceOnce(
    output,
    "    plugin.getAihubkitVideoBridge = () => getVideoBridge();",
    "    plugin.getAihubkitVideoBridge = () => getVideoBridge();\n    plugin.getLanguageModelCatalog = getLanguageModelCatalog;\n    plugin.analyzeStructured = analyzeStructured;",
    "无法定位山竹智能体插件初始化入口。",
  );
  return output;
}

function patchFile(filePath) {
  const before = fs.readFileSync(filePath, "utf8");
  const after = patchMangosteenAgentMain(before);
  if (after === before) return false;
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, after);
  fs.renameSync(temporary, filePath);
  return true;
}

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("用法：node patch-mangosteen-agent-structured-analysis.cjs /path/to/mangosteen-agent/main.js");
  const changed = patchFile(filePath);
  process.stdout.write(changed ? "山竹智能体结构化分析接口已接入。\n" : "山竹智能体结构化分析接口已存在。\n");
}

module.exports = { MARKER, patchFile, patchMangosteenAgentMain };
