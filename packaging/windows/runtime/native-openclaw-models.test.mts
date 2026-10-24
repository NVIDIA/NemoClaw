// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { nativeOpenClawModels, type NativeModelCatalog } from "./native-openclaw-models.mts";

const catalog: NativeModelCatalog = {
  provider: "nvidia",
  configuration: {
    baseUrl: "http://127.0.0.1:18790/v1",
    apiKey: "new-session-token",
    api: "openai-completions",
    models: [
      {
        id: "nvidia/first",
        name: "First",
        reasoning: true,
        contextWindow: 1000000,
        maxTokens: 8192,
      },
      {
        id: "other/second",
        name: "Second",
        input: ["text", "image"],
        contextWindow: 262144,
        maxTokens: 16384,
      },
    ],
  },
  references: { "nvidia/first": "nvidia/first", "other/second": "nvidia/other/second" },
  referenceAliases: { "nvidia/nvidia/first": "nvidia/first" },
};

test("the native catalog, metadata and provider references populate the existing picker", () => {
  const config = nativeOpenClawModels(catalog, "nvidia/first");
  assert.equal(config.models.providers.nvidia, catalog.configuration);
  assert.equal(config.models.mode, "replace");
  assert.deepEqual(Object.keys(config.agents.defaults.models), Object.values(catalog.references));
  assert.equal(config.agents.defaults.model.primary, "nvidia/first");
  assert(!("nemoclawNative" in config.models.providers));
});

test("restart retains native selection, fallbacks and model settings but rotates broker transport", () => {
  const previous = {
    models: { providers: { nvidia: { apiKey: "stale-token", baseUrl: "https://other.invalid" } } },
    agents: {
      defaults: {
        model: { primary: "nvidia/other/second", fallbacks: ["nvidia/first", "openai/foreign"] },
        models: {
          "nvidia/other/second": { alias: "Second choice", params: { temperature: 0.2 } },
          "openai/foreign": {},
        },
        thinkingDefault: "medium",
      },
      list: [{ id: "main", name: "My assistant", default: true }],
    },
  };
  const original = structuredClone(previous);
  const result = nativeOpenClawModels(catalog, "nvidia/first", previous);
  assert.deepEqual(result.agents.defaults.model, {
    primary: "nvidia/other/second",
    fallbacks: ["nvidia/first"],
  });
  assert.deepEqual(
    result.agents.defaults.models["nvidia/other/second"],
    previous.agents.defaults.models["nvidia/other/second"],
  );
  assert.equal(result.agents.defaults.thinkingDefault, "medium");
  assert.deepEqual(result.agents.list, previous.agents.list);
  assert.equal(result.models.providers.nvidia.apiKey, "new-session-token");
  assert.equal(result.models.providers.nvidia.baseUrl, catalog.configuration.baseUrl);
  assert(!("openai/foreign" in result.agents.defaults.models));
  assert.deepEqual(previous, original);
});

test("legacy installer choices migrate to native references without adding unavailable models", () => {
  const previous = { agents: { defaults: { model: "nemoclawNative/other/second" } } };
  assert.equal(
    nativeOpenClawModels(catalog, "nvidia/first", previous).agents.defaults.model.primary,
    "nvidia/other/second",
  );
  assert.throws(() => nativeOpenClawModels(catalog, "missing"), /not available/);
  assert.throws(
    () =>
      nativeOpenClawModels(
        { ...catalog, references: {}, configuration: { models: [] } },
        "nvidia/first",
      ),
    /not available/,
  );
  const foreign = { agents: { defaults: { model: { primary: "openai/foreign" } } } };
  assert.equal(
    nativeOpenClawModels(catalog, "nvidia/first", foreign).agents.defaults.model.primary,
    "nvidia/first",
  );
});

test("restart retains native picker aliases and tuning without admitting unknown references", () => {
  const previous = {
    agents: {
      defaults: {
        model: {
          primary: "nvidia/nvidia/first",
          fallbacks: ["nvidia/nvidia/first", "nvidia/nvidia/missing"],
        },
        models: { "nvidia/nvidia/first": { alias: "My selection", params: { temperature: 0.3 } } },
      },
    },
  };
  const original = structuredClone(previous);
  const result = nativeOpenClawModels(catalog, "other/second", previous);
  assert.deepEqual(result.agents.defaults.model, {
    primary: "nvidia/first",
    fallbacks: ["nvidia/first"],
  });
  assert.deepEqual(
    result.agents.defaults.models["nvidia/first"],
    previous.agents.defaults.models["nvidia/nvidia/first"],
  );
  assert.deepEqual(previous, original);
  assert.equal(
    nativeOpenClawModels(catalog, "other/second", previous, true).agents.defaults.model.primary,
    "nvidia/other/second",
  );
  const unavailable = { ...catalog, referenceAliases: { "nvidia/nvidia/first": "openai/foreign" } };
  assert.equal(
    nativeOpenClawModels(unavailable, "other/second", previous).agents.defaults.model.primary,
    "nvidia/other/second",
  );
});

test("an explicit installer provider or model change takes precedence over the old native default", () => {
  const previous = { agents: { defaults: { model: "nvidia/other/second" } } };
  assert.equal(
    nativeOpenClawModels(catalog, "nvidia/first", previous, true).agents.defaults.model.primary,
    "nvidia/first",
  );
  assert.throws(() => nativeOpenClawModels(catalog, "missing", previous, true), /not available/);
});
