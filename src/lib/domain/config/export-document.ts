// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EXPORTED_VLLM_CONTEXT_WINDOW } from "../../config/model";
import type {
  NemoClawConfig,
  NemoClawAgentConfig,
  NemoClawConfigDocumentName,
  NemoClawConfigDocumentUid,
  NemoClawInferenceProviderConfig,
} from "../../config/model";
import type { VerifiedExportSource } from "./export-evidence";

function providerLocalName(provider: string): string {
  const normalized = provider
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  return `hosted-${normalized || "provider"}`.slice(0, 63).replace(/[^a-z0-9]+$/gu, "");
}

function exportedProviderName(inference: VerifiedExportSource["inference"]): string {
  if ("serving" in inference)
    return inference.serving.backend === "vllm" ? "managed-vllm" : "local-ollama";
  return providerLocalName(inference.provider);
}

function inferenceProvider(
  source: VerifiedExportSource,
  name: string,
): NemoClawInferenceProviderConfig {
  if ("serving" in source.inference) {
    if (source.inference.serving.backend === "ollama") {
      return {
        name,
        provider: "ollama-local",
        api: "openai-completions",
        serving: source.inference.serving,
      };
    }
    return {
      name,
      provider: "vllm-local",
      api: "openai-completions",
      serving: source.inference.serving,
    };
  }
  const provider = {
    name,
    provider: source.inference.provider,
    api: source.inference.api,
    endpoint: source.inference.endpoint,
  };
  return source.inference.credentialEnv === undefined
    ? provider
    : { ...provider, credential: { env: source.inference.credentialEnv } };
}

function agentSettings(source: VerifiedExportSource) {
  return {
    ...(source.agent === "openclaw"
      ? {
          type: "openclaw" as const,
          ...(source.tools === undefined ? {} : { tools: source.tools }),
          ...(source.interfaces ? { interfaces: source.interfaces } : {}),
          ...(source.observability ? { observability: source.observability } : {}),
        }
      : {
          type: "hermes" as const,
          ...(source.interfaces ? { interfaces: source.interfaces } : {}),
        }),
    ...(source.execution ? { execution: source.execution } : {}),
  };
}

function exportAgent(source: VerifiedExportSource, providerName: string): NemoClawAgentConfig {
  return {
    name: "primary",
    ...(source.auth === undefined
      ? {}
      : { auth: { method: source.auth.method, providerRef: providerName } }),
    ...agentSettings(source),
    inference: {
      routes: [
        {
          name: "primary",
          providerRef: providerName,
          overrides: {
            model: source.inference.model,
            ...(source.inference.provider === "vllm-local" && "serving" in source.inference
              ? { contextWindow: EXPORTED_VLLM_CONTEXT_WINDOW }
              : {}),
            ...("overrides" in source.inference ? source.inference.overrides : {}),
          },
        },
      ],
    },
  };
}

function exportAgents(source: VerifiedExportSource, providerName: string): NemoClawAgentConfig[] {
  const primary = exportAgent(source, providerName);
  return [
    primary,
    ...(source.additionalAgents ?? []).map((agent) => ({
      name: agent.name,
      type: "openclaw" as const,
      tools: agent.tools,
      inference: primary.inference,
    })),
  ];
}

export interface ExportConfigBuildIdentity {
  readonly documentName: NemoClawConfigDocumentName;
  readonly documentUid: NemoClawConfigDocumentUid;
}

/** Map one verified export source to an unbound aggregate document. */
export function buildExportConfig(
  source: VerifiedExportSource,
  identity: ExportConfigBuildIdentity,
): NemoClawConfig {
  const providerName = exportedProviderName(source.inference);
  const candidate = {
    apiVersion: "nemoclaw.nvidia.com/v1",
    kind: "NemoClawConfig",
    metadata: { name: identity.documentName, uid: identity.documentUid },
    spec: {
      gateway: {
        management: "nemoclaw",
        name: source.gateway.name,
        port: source.gateway.port,
      },
      inferenceProviders: [inferenceProvider(source, providerName)],
      sandboxes: [
        {
          name: source.sandboxName,
          runtime: {
            provider: source.runtime.provider,
            image: { ref: source.runtime.imageRef },
          },
          network: {
            policy: { explicit: source.policy },
            ...(source.proxy === undefined ? {} : { proxy: source.proxy }),
          },
          ...(source.webSearch === undefined
            ? {}
            : { integrations: { webSearch: source.webSearch } }),
          agents: exportAgents(source, providerName),
        },
      ],
    },
  } satisfies NemoClawConfig;
  return candidate;
}
