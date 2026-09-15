// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { loadConfiguredModel } from './pi-model.js';

let cleanup: (() => Promise<void>) | undefined;
try {
  const overrides = JSON.parse(process.argv[2] ?? 'null');
  const loaded = await loadConfiguredModel({ provider: 'openai', model: overrides.model,
    base_url: 'https://inference.local/v1',
    ...(overrides.piModel ? { settings: { model_metadata: overrides.piModel } } : {}) },
    new InMemoryCredentialStore());
  cleanup = loaded.cleanup;
  const { modelRuntime, model } = loaded;
  await modelRuntime.setRuntimeApiKey('openai', 'openshell-placeholder');
  const result = await modelRuntime.completeSimple(model, {
    messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }],
  }, { maxTokens: Math.min(16, model.maxTokens), signal: AbortSignal.timeout(80000) });
  process.exitCode = result.stopReason !== 'error' && result.stopReason !== 'aborted' && result.content.length > 0 ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await cleanup?.();
}
