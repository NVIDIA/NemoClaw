// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { NemoClawConfigDocumentName, NemoClawConfigDocumentUid } from "../../config/model";
import type {
  V1Alpha1Export,
  V1Alpha1ExportAgent,
  V1Alpha1ExportSandbox,
} from "../../config/v1alpha1-export";
import type { VerifiedExportSource } from "./export-evidence";

const OLLAMA_SERVICE_NAME = "ollama-auth";
const VLLM_SERVICE_NAME = "vllm";

function targetBridgeAddress(documentUid: NemoClawConfigDocumentUid): string {
  const subnet = createHash("sha256").update(documentUid).digest()[0]!;
  return `172.30.${subnet}.1`;
}

function providerLocalName(provider: string): string {
  const normalized = provider
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  return `hosted-${normalized || "provider"}`.slice(0, 40).replace(/[^a-z0-9]+$/gu, "");
}

function exportedProviderName(inference: VerifiedExportSource["inference"]): string {
  if ("serving" in inference)
    return inference.serving.backend === "vllm" ? "managed-vllm" : "local";
  return providerLocalName(inference.provider);
}

function bareSha256Digest(digest: string): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(digest);
  if (!match) throw new Error("Verified Ollama model digest is invalid.");
  return match[1];
}

function inferenceProvider(
  source: VerifiedExportSource,
  name: string,
): V1Alpha1Export["spec"]["inferenceProviders"][number] {
  if ("serving" in source.inference) {
    return {
      name,
      provider: "openai",
      api: "openai-completions",
      serviceRef:
        source.inference.serving.backend === "ollama" ? OLLAMA_SERVICE_NAME : VLLM_SERVICE_NAME,
    };
  }
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

function ollamaService(
  source: VerifiedExportSource,
  bridgeAddress: string,
): NonNullable<V1Alpha1Export["spec"]["services"]>[string] {
  if (!("serving" in source.inference) || source.inference.serving.backend !== "ollama") {
    throw new Error("Only verified attached Ollama inference can create an Ollama proxy service.");
  }
  const { daemon, proxy, model } = source.inference.serving;
  return {
    kind: "ollamaProxy",
    image: null,
    endpoint: `http://${bridgeAddress}:${proxy.hostPort}/v1`,
    upstream: {
      endpoint: `http://127.0.0.1:${daemon.hostPort}/v1`,
      model: { name: model.servedName, digest: bareSha256Digest(model.digest) },
    },
  };
}

function vllmService(
  source: VerifiedExportSource,
): NonNullable<V1Alpha1Export["spec"]["services"]>[string] {
  if (!("serving" in source.inference) || source.inference.serving.backend !== "vllm") {
    throw new Error("Only verified managed vLLM inference can create a vLLM service.");
  }
  const { model, hostPort } = source.inference.serving;
  return {
    kind: "vllm",
    authentication: "bearer",
    hardware: {
      architecture: "amd64",
      minComputeCapability: 90,
      minGpuMemoryBytes: 96_000_000_000,
      minDriverMajor: 580,
    },
    container: { ipc: "host", sharedMemoryGiB: 32 },
    image: null,
    model: { repository: model.id, revision: model.revision },
    serving: {
      modelName: model.servedName,
      mambaBackend: "flashinfer",
      enforceEager: false,
      toolParser: "qwen3_coder",
      reasoningParser: "nemotron_v3",
      port: hostPort,
      contextTokens: 65_536,
      maxSequences: 1,
      batchTokens: 4096,
      startupTimeoutSeconds: 1800,
    },
    memory: { gpuMemoryUtilization: 0.75 },
  };
}

function exportServices(
  source: VerifiedExportSource,
  bridgeAddress: string,
): V1Alpha1Export["spec"]["services"] | undefined {
  if (!("serving" in source.inference)) return undefined;
  if (source.inference.serving.backend === "ollama") {
    return { [OLLAMA_SERVICE_NAME]: ollamaService(source, bridgeAddress) };
  }
  return { [VLLM_SERVICE_NAME]: vllmService(source) };
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

function exportSandbox(source: VerifiedExportSource, providerName: string): V1Alpha1ExportSandbox {
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
          agent: exportAgent(source, providerName, { name: "primary", primary: true }),
        };
  return sandbox;
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
  const services = exportServices(source, targetBridgeAddress(identity.documentUid));
  const sandbox = exportSandbox(source, providerName);
  const candidate = {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: { name: identity.documentName, uid: identity.documentUid },
    spec: {
      gateway: {
        management: "managed",
        endpoint: `http://127.0.0.1:${source.gateway.port}`,
      },
      ...(services ? { services } : {}),
      inferenceProviders: [inferenceProvider(source, providerName)],
      sandboxes: [sandbox],
    },
  } satisfies V1Alpha1Export;
  return candidate;
}
