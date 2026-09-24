import type { ProviderCatalogResult } from "openclaw/plugin-sdk/plugin-entry";
import { acceptsInput, isChatModel, pricePerMillion, type CatalogModel } from "@vultr/model-catalog";

type ProviderEntry = Extract<NonNullable<ProviderCatalogResult>, { provider: unknown }>["provider"];
export type OpenClawModel = NonNullable<ProviderEntry["models"]>[number];
type ThinkingLevelMap = NonNullable<OpenClawModel["thinkingLevelMap"]>;

// OpenClaw's levels that travel as reasoning_effort. "off" is handled apart.
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const INPUTS = ["text", "image", "video", "audio"] as const;

// A level the model does not list is hidden (null). Without an allowlist OpenClaw's
// defaults stand. "off" sends "none", unless the model cannot stop reasoning.
export function thinkingLevelMap(model: CatalogModel): ThinkingLevelMap | undefined {
  const reasoning = model.reasoning;
  if (!reasoning) {
    return undefined;
  }
  const map: ThinkingLevelMap = { off: reasoning.mandatory ? null : "none" };
  if (reasoning.supportedEfforts) {
    for (const level of LEVELS) {
      map[level] = reasoning.supportedEfforts.includes(level) ? level : null;
    }
  }
  return map;
}

// Vultr publishes max_length equal to the context window for most models. OpenClaw sends
// maxTokens as max_tokens without clamping it to the context that is left, and the engine
// rejects prompt + max_tokens > context. An output budget has to leave room for the prompt.
export const MAX_OUTPUT_TOKENS = 65_536;

export function outputBudget(model: CatalogModel): number {
  const contextWindow = model.contextWindow ?? 0;
  return Math.min(model.maxOutputTokens ?? contextWindow, MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4));
}

export function isUsable(model: CatalogModel): boolean {
  return isChatModel(model) && model.isReady && model.contextWindow !== null;
}

export function toOpenClawModel(model: CatalogModel): OpenClawModel {
  const price = pricePerMillion(model);
  const levels = thinkingLevelMap(model);
  const contextWindow = model.contextWindow ?? 0;
  const efforts = model.reasoning?.supportedEfforts;
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning !== null,
    ...(levels ? { thinkingLevelMap: levels } : {}),
    input: INPUTS.filter((modality) => acceptsInput(model, modality)),
    cost: {
      input: price.prompt ?? 0,
      output: price.completion ?? 0,
      cacheRead: price.cachedPrompt ?? 0,
      cacheWrite: price.cacheWrite ?? 0,
    },
    contextWindow,
    maxTokens: outputBudget(model),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: model.reasoning !== null,
      ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
      supportsTools: model.tools,
      maxTokensField: "max_tokens",
    },
  };
}

export function toOpenClawModels(models: CatalogModel[]): OpenClawModel[] {
  return models.filter(isUsable).map(toOpenClawModel);
}
