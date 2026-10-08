import { join } from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createProviderApiKeyAuthMethod,
  isProviderApiKeyConfigured,
  resolveProviderAuthProfileApiKey,
} from "openclaw/plugin-sdk/provider-auth";
import type { OpenClawConfig, ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_BASE_URL, loadCatalog, type CatalogModel } from "@vultr/model-catalog";

import {
  readSpeechSettings,
  responseFormat,
  speechBody,
  speechModels,
  speechSettingsFrom,
  toVoiceOptions,
  transcriptionModels,
  uploadName,
  type SpeechSettings,
} from "./src/audio.ts";
import { toOpenClawModels, type OpenClawModel } from "./src/models.ts";

export const PROVIDER = "vultr";
export const API_KEY_ENV = "VULTR_INFERENCE_API_KEY";
export const BASE_URL_ENV = "VULTR_INFERENCE_BASE_URL";

const baseUrlFrom = (env: NodeJS.ProcessEnv) => env[BASE_URL_ENV] || DEFAULT_BASE_URL;

// OpenClaw reads a speech provider's models once, at registration, and ignores a voiceModel
// ref missing from them. These arrays are what it holds, so every catalog load refills them.
const speechModelIds: string[] = [];
const transcriptionModelIds: string[] = [];
let lastModels: CatalogModel[] | undefined;

// The last good catalog is served when the network fails.
async function catalogModels(baseUrl: string, agentDir: string | undefined): Promise<CatalogModel[]> {
  const catalog = await loadCatalog({
    baseUrl,
    timeoutMs: 5_000,
    ...(agentDir ? { cachePath: join(agentDir, "cache", "vultr-model-catalog.json") } : {}),
  });
  lastModels = catalog.models;
  speechModelIds.splice(0, speechModelIds.length, ...speechModels(catalog.models));
  transcriptionModelIds.splice(0, transcriptionModelIds.length, ...transcriptionModels(catalog.models));
  return catalog.models;
}

async function models(baseUrl: string, agentDir: string | undefined): Promise<OpenClawModel[]> {
  return toOpenClawModels(await catalogModels(baseUrl, agentDir));
}

// Speech and transcription calls get no agent dir: they reuse the last catalog or fetch one.
async function firstModel(baseUrl: string, pick: (models: CatalogModel[]) => string[], kind: string): Promise<string> {
  const model = pick(lastModels ?? (await catalogModels(baseUrl, undefined)))[0];
  if (!model) {
    throw new Error(`The Vultr catalog has no ${kind} model`);
  }
  return model;
}

// A key in the provider block, then the stored Vultr credential, then the environment.
async function speechApiKey(cfg: OpenClawConfig | undefined, settings: SpeechSettings): Promise<string | undefined> {
  if (settings.apiKey) {
    return settings.apiKey;
  }
  try {
    const stored = await resolveProviderAuthProfileApiKey({ provider: PROVIDER, ...(cfg ? { cfg } : {}) });
    if (stored) {
      return stored;
    }
  } catch {
    // No profile store: fall through to the environment.
  }
  return process.env[API_KEY_ENV] || undefined;
}

// Vultr answers errors as {error: {code, message, type}}.
async function failure(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  let message = body.slice(0, 500);
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message;
  } catch {
    // Not JSON: keep the text.
  }
  return new Error(`${label} failed (${response.status}): ${message}`);
}

const timeout = (timeoutMs: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

export default definePluginEntry({
  id: PROVIDER,
  name: "Vultr",
  description: "Vultr Inference models, speech and transcription from the live model catalog",
  register(api) {
    // resolveDynamicModel is synchronous, so prepareDynamicModel fills this first.
    const resolved = new Map<string, OpenClawModel>();

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
          promptMessage: "Enter your Vultr Inference API key",
        }),
      ],

      // Feeds the model list and picker.
      catalog: {
        order: "simple",
        run: async (ctx) => {
          // Listing models needs no key, but a provider without one cannot be called.
          const apiKey = ctx.resolveProviderApiKey(PROVIDER).apiKey;
          if (!apiKey) {
            return null;
          }
          const baseUrl = baseUrlFrom(ctx.env);
          try {
            return {
              provider: { baseUrl, apiKey, api: "openai-completions", models: await models(baseUrl, ctx.agentDir) },
            };
          } catch {
            return null;
          }
        },
      },

      // The agent runtime resolves a model it has no config entry for through these two.
      prepareDynamicModel: async (ctx) => {
        try {
          for (const model of await models(baseUrlFrom(process.env), ctx.agentDir)) {
            resolved.set(model.id, model);
          }
        } catch {
          // The model stays unknown: resolveDynamicModel returns undefined for it.
        }
      },
      resolveDynamicModel: (ctx) => {
        const model = resolved.get(ctx.modelId);
        if (!model) {
          return undefined;
        }
        // The fields toOpenClawModel sets. The catalog entry type allows explicit undefineds the runtime model does not.
        const { id, name, reasoning, thinkingLevelMap, cost, maxTokens, compat } = model;
        return {
          id,
          name,
          reasoning,
          // thinkingLevelMap() sets every level it lists to a string or null, never undefined.
          ...(thinkingLevelMap
            ? { thinkingLevelMap: thinkingLevelMap as NonNullable<ProviderRuntimeModel["thinkingLevelMap"]> }
            : {}),
          cost,
          maxTokens,
          ...(compat ? { compat } : {}),
          // The runtime model takes text and image only; video and audio stay catalog metadata.
          input: model.input.filter((modality) => modality === "text" || modality === "image"),
          contextWindow: model.contextWindow ?? 0,
          provider: PROVIDER,
          api: "openai-completions",
          baseUrl: baseUrlFrom(process.env),
        };
      },
    });

    api.registerSpeechProvider({
      id: PROVIDER,
      label: "Vultr",
      models: speechModelIds,
      resolveConfig: ({ rawConfig }) => ({ ...speechSettingsFrom(rawConfig) }),
      isConfigured: ({ cfg, providerConfig }) => {
        if (readSpeechSettings(providerConfig).apiKey || process.env[API_KEY_ENV]) {
          return true;
        }
        try {
          return isProviderApiKeyConfigured({ provider: PROVIDER, ...(cfg ? { cfg } : {}) });
        } catch {
          return false;
        }
      },
      synthesize: async (req) => {
        const settings = readSpeechSettings(req.providerConfig);
        const apiKey = await speechApiKey(req.cfg, settings);
        if (!apiKey) {
          throw new Error("Vultr Inference API key missing");
        }
        const baseUrl = settings.baseUrl ?? baseUrlFrom(process.env);
        const override = req.providerOverrides?.model ?? req.providerOverrides?.modelId;
        const model =
          (typeof override === "string" && override.trim()) ||
          settings.model ||
          (await firstModel(baseUrl, speechModels, "speech"));
        const format = responseFormat(req.target, settings.responseFormat);
        const response = await fetch(`${baseUrl}/audio/speech`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(speechBody({ text: req.text, model, settings, overrides: req.providerOverrides, format })),
          signal: timeout(req.timeoutMs),
        });
        if (!response.ok) {
          throw await failure(response, "Vultr speech");
        }
        return {
          audioBuffer: Buffer.from(await response.arrayBuffer()),
          outputFormat: format,
          fileExtension: `.${format}`,
          voiceCompatible: req.target === "voice-note" && format === "opus",
        };
      },
      // The voices of the configured model, or of the catalog's first speech model.
      listVoices: async (req) => {
        const settings = readSpeechSettings(req.providerConfig);
        const apiKey = req.apiKey || (await speechApiKey(req.cfg, settings));
        if (!apiKey) {
          throw new Error("Vultr Inference API key missing");
        }
        const baseUrl = req.baseUrl || settings.baseUrl || baseUrlFrom(process.env);
        const model = settings.model ?? (await firstModel(baseUrl, speechModels, "speech"));
        const response = await fetch(`${baseUrl}/audio/voices?model=${encodeURIComponent(model)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: timeout(req.timeoutMs ?? 10_000),
        });
        if (!response.ok) {
          throw await failure(response, "Vultr voices");
        }
        return toVoiceOptions(await response.json());
      },
    });

    // OpenClaw resolves the stored Vultr key for this provider and passes it as req.apiKey.
    api.registerMediaUnderstandingProvider({
      id: PROVIDER,
      capabilities: ["audio"],
      transcribeAudio: async (req) => {
        const baseUrl = req.baseUrl || baseUrlFrom(process.env);
        const model = req.model || (await firstModel(baseUrl, transcriptionModels, "transcription"));
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(req.buffer)], { type: req.mime ?? "application/octet-stream" }),
          uploadName(req.fileName, req.mime),
        );
        form.append("model", model);
        if (req.language) {
          form.append("language", req.language);
        }
        if (req.prompt) {
          form.append("prompt", req.prompt);
        }
        const response = await (req.fetchFn ?? fetch)(`${baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { ...req.headers, Authorization: `Bearer ${req.apiKey}` },
          body: form,
          signal: timeout(req.timeoutMs, req.signal),
        });
        if (!response.ok) {
          throw await failure(response, "Vultr transcription");
        }
        const payload = (await response.json()) as { text?: unknown };
        if (typeof payload.text !== "string") {
          throw new Error("Vultr transcription answered without text");
        }
        return { text: payload.text, model };
      },
    });
  },
});
