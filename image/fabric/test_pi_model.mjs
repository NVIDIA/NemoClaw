// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRuntime } from '/opt/fabric-source/adapters/typescript/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { InMemoryCredentialStore } from '/opt/fabric-source/adapters/typescript/node_modules/@earendil-works/pi-ai/dist/index.js';
import { resolveConfiguredModel } from '/opt/fabric-source/adapters/typescript/pi/dist/pi-model.js';

const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
  modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const selected = { provider: 'openai', model: 'gpt-4o-mini', base_url: 'https://inference.local/v1' };

test('catalog selection retains the configured identity and that model metadata', () => {
  const catalog = runtime.getModel(selected.provider, selected.model);
  assert.ok(catalog);
  const model = resolveConfiguredModel(selected, catalog);
  assert.equal(model.id, 'gpt-4o-mini');
  assert.equal(model.baseUrl, selected.base_url);
  assert.equal(model.contextWindow, catalog.contextWindow);
  assert.deepEqual(model.cost, catalog.cost);
});

test('custom identity and explicit metadata are registered without a catalog alias', () => {
  const config = { ...selected, model: 'qwen3:4b', settings: { model_metadata: {
    api: 'openai-completions', contextTokens: 8192, maxOutputTokens: 2048,
    reasoning: false, input: ['text'],
  } } };
  const model = resolveConfiguredModel(config);
  runtime.registerProvider(config.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
  const actual = runtime.getModel(config.provider, config.model);
  assert.equal(actual.id, config.model);
  assert.equal(actual.contextWindow, 8192);
  assert.equal(actual.maxTokens, 2048);
  assert.equal(actual.api, 'openai-completions');
  assert.equal(actual.reasoning, false);
  assert.deepEqual(actual.input, ['text']);
  assert.deepEqual(actual.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('unknown models without metadata fail instead of borrowing another model', () => {
  assert.throws(() => resolveConfiguredModel({ ...selected, model: 'custom-model' }), /piModel/);
});
