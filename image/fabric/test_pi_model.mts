// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore } from "/opt/fabric-source/adapters/typescript/node_modules/@earendil-works/pi-ai/dist/index.js";
import { loadConfiguredModel } from "/opt/fabric-source/adapters/typescript/pi/dist/pi-model.js";

const selected = {
  provider: "openai",
  model: "gpt-4o-mini",
  base_url: "https://inference.local/v1",
};
const load = (
  metadata: NonNullable<Parameters<typeof loadConfiguredModel>[0]["settings"]>[string] | undefined,
  model = "qwen3:4b",
) =>
  loadConfiguredModel(
    {
      ...selected,
      model,
      ...(metadata === undefined ? {} : { settings: { model_metadata: metadata } }),
    },
    new InMemoryCredentialStore(),
  );

test("Pi resolves the declared catalog model", async () => {
  const loaded = await load(undefined, selected.model);
  try {
    assert.equal(loaded.model.id, selected.model);
    assert.equal(loaded.model.baseUrl, selected.base_url);
  } finally {
    await loaded.cleanup();
  }
});

test("Pi loads native fields, applies defaults, and preserves deployment identity", async () => {
  const loaded = await load({
    api: "openai-completions",
    contextWindow: 8192,
    maxTokens: 2048,
    thinkingLevelMap: { off: null },
    samplingParams: { temperature: 0.17 },
    compat: { supportsDeveloperRole: false },
    id: "wrong-model",
    baseUrl: "https://wrong.example/v1",
  });
  try {
    const model = loaded.model;
    assert.equal(model.id, "qwen3:4b");
    assert.equal(model.baseUrl, selected.base_url);
    assert.equal(model.contextWindow, 8192);
    assert.equal(model.maxTokens, 2048);
    assert.equal(model.api, "openai-completions");
    assert.deepEqual(model.thinkingLevelMap, { off: null });
    assert.deepEqual(model.samplingParams, { temperature: 0.17 });
    assert(model.compat && "supportsDeveloperRole" in model.compat);
    assert.equal(model.compat.supportsDeveloperRole, false);
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.input, ["text"]);
  } finally {
    await loaded.cleanup();
  }
});

test("Pi rejects invalid native schema values and invalid context limits", async () => {
  await assert.rejects(
    load({ api: "openai-completions", contextWindow: "invalid" }),
    /Invalid models.json schema/,
  );
  await assert.rejects(
    load({ api: "openai-completions", contextWindow: -1 }),
    /invalid contextWindow/,
  );
});

test("unknown models without configuration fail instead of borrowing another model", async () => {
  await assert.rejects(load(undefined, "custom-model"), /piModel/);
});
