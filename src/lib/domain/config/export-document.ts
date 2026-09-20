// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NemoClawConfigDocumentName, NemoClawConfigDocumentUid } from "../../config/model";
import type {
  V1Alpha1Export,
  V1Alpha1ExportAgent,
  V1Alpha1ExportSandbox,
} from "../../config/v1alpha1-export";
import type { VerifiedExportSource } from "./export-evidence";

function providerLocalName(provider: string): string {
  const normalized = provider
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  return `hosted-${normalized || "provider"}`.slice(0, 40).replace(/[^a-z0-9]+$/gu, "");
}

function exportedProviderName(inference: VerifiedExportSource["inference"]): string {
  if ("serving" in inference)
    return inference.serving.backend === "vllm" ? "managed-vllm" : "local-ollama";
  return providerLocalName(inference.provider);
}

function inferenceProvider(
  source: VerifiedExportSource,
  name: string,
): V1Alpha1Export["spec"]["inferenceProviders"][number] {
  if ("serving" in source.inference)
    throw new Error("Deferred local inference cannot be exported to v1alpha1.");
  const driver: "anthropic" | "openai" =
    source.inference.api === "anthropic-messages" ? "anthropic" : "openai";
  const provider = {
    name,
    provider: driver,
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
          ...(source.interfaces ? { interfaces: source.interfaces } : {}),
          ...(source.observability ? { observability: source.observability } : {}),
        }
      : {
          ...(source.interfaces ? { interfaces: source.interfaces } : {}),
        }),
    ...(source.execution ? { execution: source.execution } : {}),
  };
}

function exportAgent(
  source: VerifiedExportSource,
  providerName: string,
  agent: Readonly<{
    name: string;
    primary: boolean;
    tools?: Readonly<{ allow: readonly "read"[] }>;
  }>,
): V1Alpha1ExportAgent {
  const tools = agent.primary ? source.tools : agent.tools;
  return {
    name: agent.name,
    ...(tools === undefined ? {} : { tools }),
    ...(source.webSearch?.agentRefs.some((reference) => reference === agent.name)
      ? { integrationRefs: ["brave-search" as const] }
      : {}),
    ...(agent.primary && source.auth !== undefined ? { auth: { method: source.auth.method } } : {}),
    inference: {
      routes: [
        {
          name: "primary",
          providerRef: providerName,
          overrides: {
            model: source.inference.model,
            ...("overrides" in source.inference ? source.inference.overrides : {}),
          },
        },
      ],
    },
  };
}

function exportAgents(
  source: VerifiedExportSource,
  providerName: string,
): readonly V1Alpha1ExportAgent[] {
  const primary = exportAgent(source, providerName, { name: "primary", primary: true });
  return [
    primary,
    ...(source.additionalAgents ?? []).map((agent) =>
      exportAgent(source, providerName, {
        name: agent.name,
        primary: false,
        tools: agent.tools,
      }),
    ),
  ];
}

function targetProcess(policy: Record<string, unknown>): void {
  const process = policy.process as Record<string, unknown> | undefined;
  if (process?.run_as_user === "sandbox") process.run_as_user = "1000";
  if (process?.run_as_group === "sandbox") process.run_as_group = "1000";
}

function agentFilesystemRoots(agent: VerifiedExportSource["agent"]): string[] {
  if (agent === "openclaw") return ["/app"];
  if (agent === "hermes") return ["/opt/hermes"];
  return [];
}

function targetFilesystem(
  policy: Record<string, unknown>,
  agent: VerifiedExportSource["agent"],
): void {
  const filesystem = policy.filesystem_policy as Record<string, unknown> | undefined;
  if (!filesystem) return;
  const readOnly = Array.isArray(filesystem.read_only) ? [...filesystem.read_only] : [];
  const readWrite = Array.isArray(filesystem.read_write) ? filesystem.read_write : [];
  const roots = ["/opt/fabric", "/opt/nemoclaw", ...agentFilesystemRoots(agent)];
  for (const root of roots) {
    if (!readOnly.includes(root) && !readWrite.includes(root)) readOnly.push(root);
  }
  filesystem.read_only = readOnly;
}

function targetPolicy(source: VerifiedExportSource): Record<string, unknown> {
  const policy = structuredClone(source.policy) as Record<string, unknown>;
  targetProcess(policy);
  targetFilesystem(policy, source.agent);
  return policy;
}

export interface ExportConfigBuildIdentity {
  readonly documentName: NemoClawConfigDocumentName;
  readonly documentUid: NemoClawConfigDocumentUid;
}

/** Map one verified export source to an unbound aggregate document. */
export function buildExportConfig(
  source: VerifiedExportSource,
  identity: ExportConfigBuildIdentity,
): V1Alpha1Export {
  const providerName = exportedProviderName(source.inference);
  const sandboxBase = {
    name: source.sandboxName,
    runtime: {
      provider: "docker" as const,
    },
    network: {
      policy: { explicit: targetPolicy(source) },
      ...(source.proxy === undefined ? {} : { proxy: source.proxy }),
    },
    ...(source.webSearch === undefined
      ? {}
      : {
          integrations: {
            "brave-search": {
              kind: "webSearch" as const,
              provider: source.webSearch.provider,
              credential: source.webSearch.credential,
            },
          },
        }),
  };
  const sandbox: V1Alpha1ExportSandbox =
    source.agent === "langchain-deepagents-code"
      ? {
          ...sandboxBase,
          image: { ref: source.runtime.imageRef },
          harness: { kind: "deepagents", ...agentSettings(source) },
          agent: exportAgent(source, providerName, { name: "primary", primary: true }),
        }
      : {
          ...sandboxBase,
          harness: { kind: source.agent, ...agentSettings(source) },
          agents: exportAgents(source, providerName),
        };
  const candidate = {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: { name: identity.documentName, uid: identity.documentUid },
    spec: {
      gateway: {
        management: "managed",
        endpoint: `http://127.0.0.1:${source.gateway.port}`,
      },
      inferenceProviders: [inferenceProvider(source, providerName)],
      sandboxes: [sandbox],
    },
  } satisfies V1Alpha1Export;
  return candidate;
}
