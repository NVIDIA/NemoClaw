// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentModelConfig } from 'nemo-fabric-adapter-contract';
import { LifecycleError } from 'nemo-fabric-adapters-common';

/** Keep the route identity and use only catalog or explicitly supplied metadata. */
export function resolveConfiguredModel(selected: AgentModelConfig, catalog?: Model<Api>): Model<Api> {
  const metadata = selected.settings?.model_metadata;
  if (metadata === undefined) {
    if (catalog === undefined) {
      throw new LifecycleError('pi_model_metadata_required',
        'The configured model is not in the Pi catalog; supply piModel protocol and context metadata');
    }
    return { ...catalog, id: selected.model, ...(selected.base_url ? { baseUrl: selected.base_url } : {}) };
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new LifecycleError('pi_model_metadata_invalid', 'Invalid Pi model metadata');
  }
  const { api, contextTokens, maxOutputTokens, reasoning, input } = metadata;
  if ((api !== 'openai-completions' && api !== 'openai-responses') ||
      typeof contextTokens !== 'number' || !Number.isSafeInteger(contextTokens) || contextTokens <= 0 ||
      typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens <= 0 || maxOutputTokens > contextTokens || typeof reasoning !== 'boolean' ||
      !Array.isArray(input) || input.length === 0 || input.some(value => value !== 'text' && value !== 'image') ||
      new Set(input).size !== input.length || !selected.base_url) {
    throw new LifecycleError('pi_model_metadata_invalid', 'Invalid Pi model metadata');
  }
  return {
    id: selected.model, name: selected.model, provider: selected.provider,
    baseUrl: selected.base_url, api, contextWindow: contextTokens,
    maxTokens: maxOutputTokens, reasoning, input: input as ('text' | 'image')[],
    // Pi requires numeric costs. Custom metadata disables cost estimation;
    // these zeros are not a claim about the inference provider's prices.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
