// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EXPORTED_VLLM_CONTEXT_WINDOW } from "../../config/model";
import type {
  NemoClawConfig,
  NemoClawConfigDocumentName,
  NemoClawConfigDocumentUid,
  NemoClawAgentConfig,
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

function inferenceProvider(
  source: VerifiedExportSource,
  name: string,
): NemoClawInferenceProviderConfig {
  if ("serving" in source.inference) {
    return {
      name,
      provider: source.inference.provider,
      api: source.inference.api,
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

function primaryAgent(source: VerifiedExportSource, providerName: string): NemoClawAgentConfig {
  return {
    name: "primary",
    ...agentSettings(source),
    ...(source.auth === undefined
      ? {}
      : { auth: { method: source.auth.method, providerRef: providerName } }),
    inference: {
      routes: [
        {
          name: "primary",
          providerRef: providerName,
          overrides: {
            model: source.inference.model,
            ...("serving" in source.inference
              ? { contextWindow: EXPORTED_VLLM_CONTEXT_WINDOW }
              : {}),
            ...("overrides" in source.inference ? source.inference.overrides : {}),
          },
        },
      ],
    },
  };
}

export interface ExportConfigBuildIdentity {
  readonly documentName: NemoClawConfigDocumentName;
  readonly documentUid: NemoClawConfigDocumentUid;
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
      : { type: "hermes" as const }),
    ...(source.execution ? { execution: source.execution } : {}),
  };
}

/** Map one verified export source to an unbound aggregate document. */
export function buildExportConfig(
  source: VerifiedExportSource,
  identity: ExportConfigBuildIdentity,
): NemoClawConfig {
  const providerName =
    "serving" in source.inference ? "managed-vllm" : providerLocalName(source.inference.provider);
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
          ...(source.webSearch ? { integrations: { webSearch: source.webSearch } } : {}),
          agents: [primaryAgent(source, providerName)],
        },
      ],
    },
  } satisfies NemoClawConfig;
  return candidate;
}
