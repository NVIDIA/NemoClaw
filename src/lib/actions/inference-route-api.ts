// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxInferenceConfig } from "../inference/config";
import type { ConfigObject } from "../security/credential-filter";
import { isConfigObject } from "../security/credential-filter";
import type { Session } from "../state/onboard-session";

export type InferenceApi = "openai-completions" | "anthropic-messages" | "openai-responses";

const SUPPORTED_INFERENCE_APIS = new Set<InferenceApi>([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]);

export function normalizeInferenceApi(value: unknown): InferenceApi | null {
  return typeof value === "string" && SUPPORTED_INFERENCE_APIS.has(value as InferenceApi)
    ? (value as InferenceApi)
    : null;
}

function readProviderApi(config: ConfigObject, providerKey: string): InferenceApi | null {
  const models = config.models;
  if (!isConfigObject(models)) return null;
  const providers = models.providers;
  if (!isConfigObject(providers)) return null;
  const provider = providers[providerKey];
  if (!isConfigObject(provider)) return null;
  return normalizeInferenceApi(provider.api);
}

function readOpenClawPrimaryProviderKey(config: ConfigObject): "anthropic" | "inference" | null {
  const agents = config.agents;
  if (!isConfigObject(agents)) return null;
  const defaults = agents.defaults;
  if (!isConfigObject(defaults)) return null;
  const model = defaults.model;
  if (!isConfigObject(model)) return null;
  const primary = model.primary;
  if (typeof primary !== "string") return null;

  if (primary.startsWith("anthropic/")) return "anthropic";
  if (primary.startsWith("inference/")) return "inference";
  return null;
}

function readOpenClawPrimaryRouteApi(config: ConfigObject): InferenceApi | null {
  const providerKey = readOpenClawPrimaryProviderKey(config);
  if (providerKey === "anthropic") {
    return "anthropic-messages";
  }
  if (providerKey === "inference") {
    const api = readProviderApi(config, "inference");
    return api === "openai-responses" ? "openai-responses" : "openai-completions";
  }
  return null;
}

function readOpenClawRouteApi(config: ConfigObject, provider: string): InferenceApi | null {
  if (provider === "anthropic-prod") return readProviderApi(config, "anthropic");
  if (provider === "compatible-anthropic-endpoint") {
    // Source-of-truth boundary: old sandboxes may only have config state, not
    // session preferredInferenceApi. In OpenClaw config, the active provider
    // family is the primary model ref. Provider blocks are merged and may
    // contain stale sibling entries, so read them only after the primary ref.
    return (
      readOpenClawPrimaryRouteApi(config) ||
      readProviderApi(config, "anthropic") ||
      readProviderApi(config, "inference")
    );
  }
  return readProviderApi(config, getSandboxInferenceConfig("", provider).providerKey);
}

function readHermesRouteApi(config: ConfigObject): InferenceApi | null {
  const model = config.model;
  if (!isConfigObject(model)) return null;
  switch (model.api_mode) {
    case "anthropic_messages":
      return "anthropic-messages";
    case "codex_responses":
      return "openai-responses";
    case undefined:
    case null:
    case "":
      return "openai-completions";
    default:
      return null;
  }
}

function sessionRouteApi(
  session: Session | null,
  sandboxName: string,
  provider: string,
): InferenceApi | null {
  if (!session || session.sandboxName !== sandboxName || session.provider !== provider) return null;
  return normalizeInferenceApi(session.preferredInferenceApi);
}

export function resolveRuntimeInferenceApi(options: {
  agentName: string;
  config: ConfigObject;
  currentProvider: string | null | undefined;
  provider: string;
  sandboxName: string;
  session: Session | null;
}): InferenceApi | null {
  const { agentName, config, currentProvider, provider, sandboxName, session } = options;
  if (provider === "anthropic-prod") return "anthropic-messages";

  const sameProvider = currentProvider === provider;
  const sessionApi = sameProvider ? sessionRouteApi(session, sandboxName, provider) : null;
  if (sessionApi) return sessionApi;

  const configApi =
    sameProvider && agentName === "hermes"
      ? readHermesRouteApi(config)
      : sameProvider
        ? readOpenClawRouteApi(config, provider)
        : null;
  if (configApi) return configApi;

  if (provider === "compatible-anthropic-endpoint") return "anthropic-messages";
  return null;
}

export function hermesApiMode(inferenceApi: string): string | null {
  switch (inferenceApi) {
    case "":
    case "openai-completions":
      return null;
    case "anthropic-messages":
      return "anthropic_messages";
    case "openai-responses":
      return "codex_responses";
    default:
      return null;
  }
}
