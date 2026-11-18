// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { NemoClawConfigDocumentName, NemoClawConfigDocumentUid } from "../../config/model";
import type {
  V1Alpha1Export,
  V1Alpha1ExportAgent,
  V1Alpha1ExportSandbox,
  V1Alpha1FabricHarnessKind,
} from "../../config/v1alpha1-export";
import type { VerifiedExportSource } from "./export-evidence";

/**
 * v1 requires a digest-pinned agent `image.ref` and service `image`. None of v0's agent images
 * (OpenClaw, Hermes, Deep Agents) ships Fabric or its adapter, v0 has no v1 vLLM or Ollama service
 * image, and v1 publishes none yet. The export writes this parseable stand-in, and the export report
 * names each place it appears.
 */
export const V1_IMAGE_REF_PLACEHOLDER = `REPLACE-ME@sha256:${"0".repeat(64)}`;
/**
 * OpenShell names the network policy it composes from an attached provider with this prefix
 * (`PROVIDER_RULE_NAME_PREFIX` in openshell-policy), rejects it in a submitted policy, and builds
 * it again for each provider the destination attaches. `openshell policy get --base` drops the
 * same keys. The SDK has no base-policy read, so the export drops them from the effective policy.
 */
export const OPENSHELL_PROVIDER_RULE_PREFIX = "_provider_";

export function isOpenShellProviderRule(name: string): boolean {
  return name.startsWith(OPENSHELL_PROVIDER_RULE_PREFIX);
}

/** Explicit-policy sections that describe the source image rather than its network access. */
export const IMAGE_POLICY_SECTIONS = ["filesystem_policy", "process", "landlock"] as const;

export const OLLAMA_SERVICE_NAME = "ollama-auth";
export const VLLM_SERVICE_NAME = "vllm";

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
): V1Alpha1Export["spec"]["inferenceProviders"][string] {
  if ("serving" in source.inference) {
    return {
      provider: "openai",
      api: "openai-completions",
      serviceRef:
        source.inference.serving.backend === "ollama" ? OLLAMA_SERVICE_NAME : VLLM_SERVICE_NAME,
    };
  }
  const driver: "anthropic" | "openai" =
    source.inference.api === "anthropic-messages" ? "anthropic" : "openai";
  const provider = {
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
    image: V1_IMAGE_REF_PLACEHOLDER,
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
    image: V1_IMAGE_REF_PLACEHOLDER,
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

const FABRIC_HARNESS_KIND: Readonly<
  Record<VerifiedExportSource["agent"], V1Alpha1FabricHarnessKind>
> = {
  openclaw: "nvidia.fabric.openclaw",
  hermes: "nvidia.fabric.hermes",
  "langchain-deepagents-code": "nvidia.fabric.langchain.deepagents",
};

function exportHarness(source: VerifiedExportSource): V1Alpha1ExportSandbox["harness"] {
  return {
    kind: FABRIC_HARNESS_KIND[source.agent],
    ...(source.execution?.timeoutSeconds === undefined
      ? {}
      : { runtime: { timeout_seconds: source.execution.timeoutSeconds } }),
  };
}

/** v1 route overrides accept only `maxTokens` of v0's tuning keys. */
function routeOverrides(source: VerifiedExportSource) {
  const maxTokens =
    "overrides" in source.inference
      ? (source.inference.overrides as { maxTokens?: number } | undefined)?.maxTokens
      : undefined;
  return {
    model: source.inference.model,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function exportAgent(source: VerifiedExportSource, providerName: string): V1Alpha1ExportAgent {
  // v0's tool `disclosure` is an adapter-native control with no v1 home, so it is not exported.
  return {
    name: "primary",
    ...(source.webSearch === undefined
      ? {}
      : { integrationRefs: [`${source.webSearch.provider}-search` as const] }),
    ...(source.auth !== undefined ? { auth: { method: source.auth.method } } : {}),
    inference: {
      routes: [{ name: "primary", providerRef: providerName, overrides: routeOverrides(source) }],
    },
  };
}

function targetEndpoint(endpoint: Record<string, unknown>): void {
  delete endpoint.provider_credentialed;
  // v1 names a raw TLS tunnel `skip`; OpenShell called the same behavior `passthrough`.
  if (endpoint.tls === "passthrough") endpoint.tls = "skip";
  // Omitting `tls` is v1's automatic TLS detection and termination, which `terminate` named.
  if (endpoint.tls === "terminate") delete endpoint.tls;
}

/**
 * Project an OpenShell sandbox policy to the explicit v1 policy the export writes. Live checks
 * reuse it so their expected policy cannot drift from the export. The input is not changed.
 */
export function exportedExplicitPolicy(sourcePolicy: unknown): Record<string, unknown> {
  const policy = structuredClone(sourcePolicy) as Record<string, unknown>;
  const composed = policy.network_policies as
    | Record<string, { endpoints?: Record<string, unknown>[] }>
    | undefined;
  const networks =
    composed &&
    Object.fromEntries(Object.entries(composed).filter(([name]) => !isOpenShellProviderRule(name)));
  if (networks) policy.network_policies = networks;
  for (const network of Object.values(networks ?? {})) network.endpoints?.forEach(targetEndpoint);
  // These sections describe the V0 image (its run_as identity and writable paths). The v1 image
  // differs, so they have no exact equivalent; the export report lists each one.
  for (const section of IMAGE_POLICY_SECTIONS) delete policy[section];
  return policy;
}

function exportSandbox(source: VerifiedExportSource, providerName: string): V1Alpha1ExportSandbox {
  return {
    network: { policy: { explicit: exportedExplicitPolicy(source.policy) } },
    image: { ref: V1_IMAGE_REF_PLACEHOLDER },
    harness: exportHarness(source),
    agent: exportAgent(source, providerName),
  };
}

function exportIntegrations(
  source: VerifiedExportSource,
): V1Alpha1Export["spec"]["integrations"] | undefined {
  if (source.webSearch === undefined) return undefined;
  return {
    [`${source.webSearch.provider}-search`]: {
      kind: "webSearch",
      provider: source.webSearch.provider,
      credential: source.webSearch.credential,
    },
  } as V1Alpha1Export["spec"]["integrations"];
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
  const integrations = exportIntegrations(source);
  const candidate = {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: { name: identity.documentName, uid: identity.documentUid },
    spec: {
      gateway: {
        management: "managed",
        runtime: { provider: "docker" },
        endpoint: `http://127.0.0.1:${source.gateway.port}`,
      },
      ...(services ? { services } : {}),
      inferenceProviders: { [providerName]: inferenceProvider(source) },
      ...(integrations ? { integrations } : {}),
      sandboxes: { [source.sandboxName]: sandbox },
    },
  } satisfies V1Alpha1Export;
  return candidate;
}
