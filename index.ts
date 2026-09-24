import { join } from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { DEFAULT_BASE_URL, loadCatalog } from "@vultr/model-catalog";

import { toOpenClawModels, type OpenClawModel } from "./src/models.ts";

export const PROVIDER = "vultr";
export const API_KEY_ENV = "VULTR_INFERENCE_API_KEY";
export const BASE_URL_ENV = "VULTR_INFERENCE_BASE_URL";

const baseUrlFrom = (env: NodeJS.ProcessEnv) => env[BASE_URL_ENV] || DEFAULT_BASE_URL;

// The last good catalog is served when the network fails.
async function models(baseUrl: string, agentDir: string | undefined): Promise<OpenClawModel[]> {
  const catalog = await loadCatalog({
    baseUrl,
    timeoutMs: 5_000,
    ...(agentDir ? { cachePath: join(agentDir, "cache", "vultr-model-catalog.json") } : {}),
  });
  return toOpenClawModels(catalog.models);
}

export default definePluginEntry({
  id: PROVIDER,
  name: "Vultr",
  description: "Vultr Inference model provider with a live model catalog",
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
        return {
          ...model,
          // The runtime model takes text and image only; video and audio stay catalog metadata.
          input: model.input.filter((modality) => modality === "text" || modality === "image"),
          contextWindow: model.contextWindow ?? 0,
          provider: PROVIDER,
          api: "openai-completions",
          baseUrl: baseUrlFrom(process.env),
        };
      },
    });
  },
});
