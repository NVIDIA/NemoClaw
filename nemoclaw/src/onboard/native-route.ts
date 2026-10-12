// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelProviderEntry, OpenClawConfig } from "../index.js";
import { isObjectRecord } from "../shared/object-record.js";

function record(value: unknown): Record<string, unknown> {
  return isObjectRecord(value) ? value : {};
}

function credentialReference(value: unknown): string | undefined {
  const reference =
    typeof value === "string"
      ? /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(value)?.[1]
      : record(value).source === "env"
        ? record(value).id
        : undefined;
  return typeof reference === "string" && /^[A-Z_][A-Z0-9_]*$/.test(reference)
    ? reference
    : undefined;
}

function describeEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value) return "(not configured)";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "(configured)";
    // A display must not expose URL credentials, query values or fragments.
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(configured)";
  }
}

/** Read the host's current native configuration, never the onboarding snapshot. */
export function readNativeRoute(config: OpenClawConfig) {
  const modelConfig = record(record(config.agents).defaults).model;
  const primary = typeof modelConfig === "string" ? modelConfig : record(modelConfig).primary;
  const model = typeof primary === "string" ? primary.trim() : "";
  const separator = model.indexOf("/");
  const provider = separator > 0 ? model.slice(0, separator) : "";
  const modelId = separator > 0 ? model.slice(separator + 1) : "";
  const providers = record(record(config.models).providers);
  const providerConfig = record(providers[provider]);
  const credentialEnv = credentialReference(providerConfig.apiKey);
  const credential = credentialEnv
    ? `$${credentialEnv} (set via env var)`
    : providerConfig.apiKey
      ? "(configured)"
      : "(not configured)";
  const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
  const selected = record(models.find((entry) => record(entry).id === modelId));
  const entry: ModelProviderEntry = { id: model, label: modelId };
  if (typeof selected.contextWindow === "number") entry.contextWindow = selected.contextWindow;
  if (typeof selected.maxTokens === "number") entry.maxOutput = selected.maxTokens;
  return {
    model: model || "(not configured)",
    provider: provider || "(not configured)",
    endpoint: describeEndpoint(providerConfig.baseUrl),
    credential,
    credentialEnv,
    // Other provider registrations belong to OpenClaw, not this plugin.
    managedModel:
      provider === "inference" && modelId && isObjectRecord(providers[provider])
        ? entry
        : undefined,
  };
}
