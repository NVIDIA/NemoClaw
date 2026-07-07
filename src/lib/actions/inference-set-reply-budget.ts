// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConfigObject, ConfigValue } from "../security/credential-filter";
import { isConfigObject } from "../security/credential-filter";

// SOURCE_OF_TRUTH_REVIEW (Anthropic reply budget; gateway regression #4504,
// OpenClaw 2026.6.10 adopted in #5595): OpenClaw rejects an Anthropic Messages
// model without a positive maxTokens before sending the request. Onboarding's
// canonical fallback lives in scripts/generate-openclaw-config.mts, but
// `inference set` creates and patches live provider namespaces without running
// that generator. Preserve a valid target-model budget first, then the exact
// active-primary budget, then the generator-aligned fallback. Regression proof
// lives in inference-set-patch-openclaw.test.ts. Remove this local inheritance
// when the minimum supported OpenClaw normalizes a positive budget for new
// anthropic-messages models, or when both paths consume one generator-owned
// default; until then keep this value aligned with NEMOCLAW_MAX_TOKENS.
const DEFAULT_OPENCLAW_MAX_TOKENS = 4096;

function positiveReplyBudget(value: ConfigValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function readOpenClawPrimaryReplyBudget(config: ConfigObject): number | undefined {
  const agents = config.agents;
  if (!isConfigObject(agents)) return undefined;
  const defaults = agents.defaults;
  if (!isConfigObject(defaults)) return undefined;
  const selectedModel = defaults.model;
  if (!isConfigObject(selectedModel) || typeof selectedModel.primary !== "string") {
    return undefined;
  }

  const primary = selectedModel.primary;
  const separator = primary.indexOf("/");
  if (separator <= 0 || separator === primary.length - 1) return undefined;
  const providerKey = primary.slice(0, separator);
  const modelId = primary.slice(separator + 1);
  const models = config.models;
  if (!isConfigObject(models)) return undefined;
  const providers = models.providers;
  if (!isConfigObject(providers) || !Object.hasOwn(providers, providerKey)) return undefined;
  const provider = providers[providerKey];
  if (!isConfigObject(provider) || !Array.isArray(provider.models)) return undefined;

  for (const entry of provider.models) {
    if (!isConfigObject(entry)) continue;
    if (entry.name === primary || entry.id === modelId) {
      return positiveReplyBudget(entry.maxTokens);
    }
  }
  return undefined;
}

export function applyOpenClawAnthropicReplyBudget(
  modelConfig: ConfigObject,
  inheritedReplyBudget?: number,
): void {
  modelConfig.maxTokens =
    positiveReplyBudget(modelConfig.maxTokens) ??
    inheritedReplyBudget ??
    DEFAULT_OPENCLAW_MAX_TOKENS;
}
