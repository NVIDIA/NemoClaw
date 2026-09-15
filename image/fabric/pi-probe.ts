// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { resolveConfiguredModel } from './pi-model.js';

try {
  const overrides = JSON.parse(process.argv[2] ?? 'null');
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = resolveConfiguredModel({ provider: 'openai', model: overrides.model,
    base_url: 'https://inference.local/v1',
    ...(overrides.piModel ? { settings: { model_metadata: overrides.piModel } } : {}) },
    runtime.getModel('openai', overrides.model));
  const responses = model.api === 'openai-responses';
  if (!responses && model.api !== 'openai-completions') throw new Error('Unsupported Pi inference API');
  const result = await fetch(`${model.baseUrl}/${responses ? 'responses' : 'chat/completions'}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openshell-placeholder' },
    body: JSON.stringify(responses
      ? { model: model.id, input: 'Reply OK.', max_output_tokens: Math.min(16, model.maxTokens), stream: false }
      : { model: model.id, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: Math.min(16, model.maxTokens), stream: false }),
    signal: AbortSignal.timeout(80000),
  });
  const body = await result.json() as { output?: unknown[]; choices?: unknown[] };
  const output = responses ? body.output : body.choices;
  process.exitCode = result.ok && Array.isArray(output) && output.length > 0 ? 0 : 1;
} catch {
  process.exitCode = 1;
}
