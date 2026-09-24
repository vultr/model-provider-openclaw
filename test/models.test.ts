import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeModel, type ModelDocument, type ModelReasoning } from "@vultr/model-catalog";

import { MAX_OUTPUT_TOKENS, isUsable, outputBudget, thinkingLevelMap, toOpenClawModel, toOpenClawModels } from "../src/models.ts";

function document(overrides: Partial<ModelDocument> = {}): ModelDocument {
  return {
    schema_version: "2.4",
    id: "glm-5.3",
    name: "GLM 5.3",
    input_modalities: [
      {
        type: "text",
        supported_inputs: { max_context_length: { value: 1_048_576, unit: "token" } },
        pricing: [
          { type: "prompt", unit: "token", cost_usd: "0.0000006" },
          { type: "cached_prompt", unit: "token", cost_usd: "0.0000001" },
        ],
      },
      { type: "image" },
      { type: "video" },
    ],
    output_modalities: [
      {
        type: "text",
        max_length: { value: 32_768, unit: "token" },
        supported_parameters: { tools: { type: "boolean" } },
        pricing: [{ type: "completion", unit: "token", cost_usd: "0.0000022" }],
      },
    ],
    reasoning: {
      mandatory: false,
      supported_efforts: ["ultra", "max", "high", "medium", "low"],
      supports_max_tokens: true,
    },
    ...overrides,
  };
}

test("a catalog model becomes an OpenClaw model", () => {
  assert.deepEqual(toOpenClawModel(normalizeModel(document())), {
    id: "glm-5.3",
    name: "GLM 5.3",
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" },
    input: ["text", "image", "video"],
    cost: { input: 0.6, output: 2.2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["ultra", "max", "high", "medium", "low"],
      supportsTools: true,
      maxTokensField: "max_tokens",
    },
  });
});

test("thinking levels follow the reasoning block", () => {
  const map = (reasoning: ModelReasoning | null) => thinkingLevelMap(normalizeModel(document({ reasoning })));
  assert.equal(map(null), undefined);
  // No allowlist: OpenClaw's defaults stand, only "off" is pinned.
  assert.deepEqual(map({ mandatory: false, supported_efforts: null }), { off: "none" });
  // Mandatory reasoning cannot be switched off.
  assert.equal(map({ mandatory: true, supported_efforts: ["high"] })?.off, null);
});

test("a model that cannot reason, see images or report limits still maps", () => {
  const model = toOpenClawModel(
    normalizeModel(
      document({
        reasoning: null,
        input_modalities: [{ type: "text", supported_inputs: { max_context_length: { value: 8_192 } } }],
        output_modalities: [{ type: "text", supported_parameters: {} }],
      }),
    ),
  );
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
  assert.deepEqual(model.input, ["text"]);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(model.maxTokens, 2_048);
  assert.deepEqual(model.compat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsTools: false,
    maxTokensField: "max_tokens",
  });
});

test("only ready chat models with a context window are offered", () => {
  const reranker = document({ id: "rerank", output_modalities: [{ type: "rerank", supported_parameters: {} }] });
  const unready = document({ id: "unready", is_ready: false });
  const blind = document({ id: "no-context", input_modalities: [{ type: "text" }] });
  const models = [document(), reranker, unready, blind].map(normalizeModel);
  assert.deepEqual(models.map(isUsable), [true, false, false, false]);
  assert.deepEqual(
    toOpenClawModels(models).map((model) => model.id),
    ["glm-5.3"],
  );
});

test("the output budget leaves room for the prompt", () => {
  const budget = (context: number, output?: number) =>
    outputBudget(
      normalizeModel(
        document({
          input_modalities: [{ type: "text", supported_inputs: { max_context_length: { value: context } } }],
          output_modalities: [
            { type: "text", supported_parameters: {}, ...(output ? { max_length: { value: output } } : {}) },
          ],
        }),
      ),
    );
  // Vultr's usual shape: the published output limit is the whole context window.
  assert.equal(budget(1_048_576, 1_048_576), MAX_OUTPUT_TOKENS);
  assert.equal(budget(131_072, 131_072), 32_768);
  // A real output limit below the cap is kept.
  assert.equal(budget(1_048_576, 16_384), 16_384);
  assert.equal(budget(131_072), 32_768);
});
