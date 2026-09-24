// index.ts
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

// node_modules/@vultr/model-catalog/dist/catalog.js
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// node_modules/@vultr/model-catalog/dist/price.js
var DECIMAL = /^(-?)(\d*)(?:\.(\d*))?$/;
function usdPerMillion(costUsd) {
  const match = DECIMAL.exec(costUsd.trim());
  if (!match || match[2] === "" && (match[3] ?? "") === "") {
    return Number(costUsd) * 1e6;
  }
  const sign = match[1] ?? "";
  const whole = match[2] ?? "";
  const fraction = (match[3] ?? "").padEnd(6, "0");
  return Number(`${sign}${whole}${fraction.slice(0, 6)}.${fraction.slice(6) || "0"}`);
}

// node_modules/@vultr/model-catalog/dist/model.js
function limit(value) {
  return typeof value?.value === "number" && Number.isFinite(value.value) ? value.value : null;
}
function isWindowed(entry) {
  return entry.utc_start !== void 0 || entry.utc_end !== void 0 || entry.utc_days !== void 0;
}
function price(entries, type, unit) {
  const matches = (entries ?? []).filter((entry) => entry.type === type && entry.unit === unit && typeof entry.cost_usd === "string");
  return (matches.find((entry) => !isWindowed(entry)) ?? matches[0])?.cost_usd ?? null;
}
function normalizeModel(document) {
  const textIn = document.input_modalities.find((modality) => modality.type === "text");
  const textOut = document.output_modalities.find((modality) => modality.type === "text");
  const parameters = textOut?.supported_parameters ?? {};
  const reasoning = document.reasoning ?? null;
  return {
    id: document.id,
    name: document.name || document.id,
    description: document.description ?? null,
    created: document.created ?? null,
    huggingFaceId: document.hugging_face_id ?? null,
    quantization: document.quantization ?? null,
    contextWindow: limit(textIn?.supported_inputs?.max_context_length),
    maxPromptTokens: limit(textIn?.supported_inputs?.max_prompt_length),
    maxOutputTokens: limit(textOut?.max_length),
    inputModalities: document.input_modalities.map((modality) => modality.type),
    outputModalities: document.output_modalities.map((modality) => modality.type),
    pricing: {
      prompt: price(textIn?.pricing, "prompt", "token"),
      cachedPrompt: price(textIn?.pricing, "cached_prompt", "token"),
      cacheWrite: price(textIn?.pricing, "cache_write", "token"),
      completion: price(textOut?.pricing, "completion", "token"),
      internalReasoning: price(textOut?.pricing, "internal_reasoning", "token"),
      request: price(document.pricing, "request", "request")
    },
    tools: "tools" in parameters,
    structuredOutputs: "response_format" in parameters || "structured_outputs" in parameters,
    streaming: textOut?.streaming === true,
    supportedParameters: Object.keys(parameters),
    parameters,
    reasoning: reasoning && {
      mandatory: reasoning.mandatory === true,
      defaultEffort: reasoning.default_effort ?? null,
      defaultEnabled: reasoning.default_enabled ?? null,
      supportedEfforts: reasoning.supported_efforts ?? null,
      supportsMaxTokens: reasoning.supports_max_tokens === true
    },
    isReady: document.is_ready !== false,
    deprecationDate: document.deprecation_date ?? null
  };
}
function isChatModel(model) {
  return model.outputModalities.includes("text");
}
function acceptsInput(model, modality) {
  return model.inputModalities.includes(modality);
}
function pricePerMillion(model) {
  const { prompt, cachedPrompt, cacheWrite, completion, internalReasoning } = model.pricing;
  const scale = (value) => value === null ? null : usdPerMillion(value);
  return {
    prompt: scale(prompt),
    cachedPrompt: scale(cachedPrompt),
    cacheWrite: scale(cacheWrite),
    completion: scale(completion),
    internalReasoning: scale(internalReasoning)
  };
}

// node_modules/@vultr/model-catalog/dist/document.js
var SCHEMA_VERSION = "2.4";

// node_modules/@vultr/model-catalog/dist/parse.js
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isModalityList(value) {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item["type"] === "string");
}
function parseCatalog(payload) {
  const entries = Array.isArray(payload) ? payload : isRecord(payload) ? payload["data"] : void 0;
  if (!Array.isArray(entries)) {
    throw new TypeError("catalog payload must be an array or an object with a data array");
  }
  const documents = [];
  const issues = [];
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ index, id: null, message: "entry is not an object" });
      return;
    }
    const id = typeof entry["id"] === "string" && entry["id"] !== "" ? entry["id"] : null;
    if (id === null) {
      issues.push({ index, id, message: "entry has no id" });
      return;
    }
    if (!isModalityList(entry["input_modalities"]) || !isModalityList(entry["output_modalities"])) {
      issues.push({ index, id, message: "entry has no usable input_modalities/output_modalities" });
      return;
    }
    if (entry["schema_version"] !== SCHEMA_VERSION) {
      issues.push({
        index,
        id,
        message: `schema_version is ${JSON.stringify(entry["schema_version"])}, expected "${SCHEMA_VERSION}"; parsed anyway`
      });
    }
    documents.push(entry);
  });
  return { documents, issues };
}

// node_modules/@vultr/model-catalog/dist/catalog.js
var DEFAULT_BASE_URL = "https://api.vultrinference.com/v1";
var DEFAULT_TIMEOUT_MS = 8e3;
var CatalogError = class extends Error {
  name = "CatalogError";
};
function modelsUrl(baseUrl = DEFAULT_BASE_URL) {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}
async function fetchCatalog(options = {}) {
  const url = modelsUrl(options.baseUrl);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers = { accept: "application/json", ...options.headers };
  if (options.apiKey) {
    headers["authorization"] = `Bearer ${options.apiKey}`;
  }
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal });
    if (!response.ok) {
      throw new CatalogError(`GET ${url} returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof CatalogError) {
      throw error;
    }
    throw new CatalogError(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}
function buildCatalog(payload, source, fetchedAt) {
  const { documents, issues } = parseCatalog(payload);
  return { models: documents.map(normalizeModel), issues, source, fetchedAt };
}
async function readCache(path, baseUrl) {
  try {
    const cached = JSON.parse(await readFile(path, "utf8"));
    if (cached.base_url !== baseUrl || typeof cached.fetched_at !== "number") {
      return null;
    }
    parseCatalog(cached.payload);
    return cached;
  } catch {
    return null;
  }
}
async function writeCache(path, cache) {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(cache));
    await rename(temporary, path);
  } catch {
  }
}
async function loadCatalog(options = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const cached = options.cachePath ? await readCache(options.cachePath, baseUrl) : null;
  if (cached && now() - cached.fetched_at < (options.maxAgeMs ?? 0)) {
    return buildCatalog(cached.payload, "cache", cached.fetched_at);
  }
  try {
    const payload = await fetchCatalog({ ...options, baseUrl });
    const catalog = buildCatalog(payload, "network", now());
    if (options.cachePath && catalog.models.length > 0) {
      await writeCache(options.cachePath, { base_url: baseUrl, fetched_at: catalog.fetchedAt, payload });
    }
    return catalog;
  } catch (error) {
    if (cached) {
      return buildCatalog(cached.payload, "stale-cache", cached.fetched_at);
    }
    throw error instanceof CatalogError ? error : new CatalogError(String(error), { cause: error });
  }
}

// src/models.ts
var LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
var INPUTS = ["text", "image", "video", "audio"];
function thinkingLevelMap(model) {
  const reasoning = model.reasoning;
  if (!reasoning) {
    return void 0;
  }
  const map = { off: reasoning.mandatory ? null : "none" };
  if (reasoning.supportedEfforts) {
    for (const level of LEVELS) {
      map[level] = reasoning.supportedEfforts.includes(level) ? level : null;
    }
  }
  return map;
}
var MAX_OUTPUT_TOKENS = 65536;
function outputBudget(model) {
  const contextWindow = model.contextWindow ?? 0;
  return Math.min(model.maxOutputTokens ?? contextWindow, MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4));
}
function isUsable(model) {
  return isChatModel(model) && model.isReady && model.contextWindow !== null;
}
function toOpenClawModel(model) {
  const price2 = pricePerMillion(model);
  const levels = thinkingLevelMap(model);
  const contextWindow = model.contextWindow ?? 0;
  const efforts = model.reasoning?.supportedEfforts;
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning !== null,
    ...levels ? { thinkingLevelMap: levels } : {},
    input: INPUTS.filter((modality) => acceptsInput(model, modality)),
    cost: {
      input: price2.prompt ?? 0,
      output: price2.completion ?? 0,
      cacheRead: price2.cachedPrompt ?? 0,
      cacheWrite: price2.cacheWrite ?? 0
    },
    contextWindow,
    maxTokens: outputBudget(model),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: model.reasoning !== null,
      ...efforts ? { supportedReasoningEfforts: efforts } : {},
      supportsTools: model.tools,
      maxTokensField: "max_tokens"
    }
  };
}
function toOpenClawModels(models2) {
  return models2.filter(isUsable).map(toOpenClawModel);
}

// index.ts
var PROVIDER = "vultr";
var API_KEY_ENV = "VULTR_INFERENCE_API_KEY";
var BASE_URL_ENV = "VULTR_INFERENCE_BASE_URL";
var baseUrlFrom = (env) => env[BASE_URL_ENV] || DEFAULT_BASE_URL;
async function models(baseUrl, agentDir) {
  const catalog = await loadCatalog({
    baseUrl,
    timeoutMs: 5e3,
    ...agentDir ? { cachePath: join(agentDir, "cache", "vultr-model-catalog.json") } : {}
  });
  return toOpenClawModels(catalog.models);
}
var index_default = definePluginEntry({
  id: PROVIDER,
  name: "Vultr",
  description: "Vultr Inference model provider with a live model catalog",
  register(api) {
    const resolved = /* @__PURE__ */ new Map();
    api.registerProvider({
      id: PROVIDER,
      label: "Vultr",
      envVars: [API_KEY_ENV],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER,
          methodId: "api-key",
          label: "Vultr Inference API key",
          hint: "API key from the Vultr Inference dashboard",
          optionKey: "vultrApiKey",
          flagName: "--vultr-api-key",
          envVar: API_KEY_ENV,
          promptMessage: "Enter your Vultr Inference API key"
        })
      ],
      // Feeds the model list and picker.
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER).apiKey;
          if (!apiKey) {
            return null;
          }
          const baseUrl = baseUrlFrom(ctx.env);
          try {
            return {
              provider: { baseUrl, apiKey, api: "openai-completions", models: await models(baseUrl, ctx.agentDir) }
            };
          } catch {
            return null;
          }
        }
      },
      // The agent runtime resolves a model it has no config entry for through these two.
      prepareDynamicModel: async (ctx) => {
        try {
          for (const model of await models(baseUrlFrom(process.env), ctx.agentDir)) {
            resolved.set(model.id, model);
          }
        } catch {
        }
      },
      resolveDynamicModel: (ctx) => {
        const model = resolved.get(ctx.modelId);
        if (!model) {
          return void 0;
        }
        return {
          ...model,
          // The runtime model takes text and image only; video and audio stay catalog metadata.
          input: model.input.filter((modality) => modality === "text" || modality === "image"),
          contextWindow: model.contextWindow ?? 0,
          provider: PROVIDER,
          api: "openai-completions",
          baseUrl: baseUrlFrom(process.env)
        };
      }
    });
  }
});
export {
  API_KEY_ENV,
  BASE_URL_ENV,
  PROVIDER,
  index_default as default
};
