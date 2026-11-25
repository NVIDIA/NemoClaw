// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NEMOCLAW_CONFIG_KIND } from "./model";
import type { WebSearchProvider } from "../inference/web-search/provider";

export const V1ALPHA1_EXPORT_API_VERSION = "nemoclaw.nvidia.com/v1alpha1" as const;

const V1_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

export function isV1Alpha1ExportName(value: unknown): value is string {
  return typeof value === "string" && V1_SLUG_PATTERN.test(value);
}

interface V1Alpha1HostedInferenceProvider {
  readonly provider: "anthropic" | "openai";
  readonly api: "anthropic-messages" | "openai-completions" | "openai-responses";
  readonly endpoint: string;
  readonly credential?: Readonly<{ env: string }>;
  readonly serviceRef?: never;
}

interface V1Alpha1ServiceInferenceProvider {
  readonly provider: "openai";
  readonly api: "openai-completions";
  readonly serviceRef: string;
  readonly endpoint?: never;
  readonly credential?: never;
}

export interface V1Alpha1OllamaProxyService {
  readonly kind: "ollamaProxy";
  /** A digest-pinned placeholder: v0 has no v1 service image. */
  readonly image: string;
  readonly endpoint: string;
  readonly upstream: Readonly<{
    endpoint: string;
    model: Readonly<{ name: string; digest: string }>;
  }>;
}

export interface V1Alpha1VllmService {
  readonly kind: "vllm";
  readonly authentication: "bearer";
  readonly hardware: Readonly<{
    architecture: "amd64";
    minComputeCapability: 90;
    minGpuMemoryBytes: 96_000_000_000;
    minDriverMajor: 580;
  }>;
  readonly container: Readonly<{ ipc: "host"; sharedMemoryGiB: 32 }>;
  /** A digest-pinned placeholder: v0 has no v1 service image. */
  readonly image: string;
  readonly model: Readonly<{ repository: string; revision: string }>;
  readonly serving: Readonly<{
    modelName: string;
    mambaBackend: "flashinfer";
    enforceEager: false;
    toolParser: "qwen3_coder";
    reasoningParser: "nemotron_v3";
    port: number;
    contextTokens: 65_536;
    maxSequences: 1;
    batchTokens: 4096;
    startupTimeoutSeconds: 1800;
  }>;
  readonly memory: Readonly<{ gpuMemoryUtilization: 0.75 }>;
}

export type V1Alpha1ExportService = V1Alpha1OllamaProxyService | V1Alpha1VllmService;

export interface V1Alpha1ExportAgent {
  readonly name: string;
  readonly inference: Readonly<{
    routes: readonly Readonly<{
      name: string;
      providerRef: string;
      overrides: Readonly<Record<string, unknown> & { model: string }>;
    }>[];
  }>;
  readonly auth?: Readonly<{ method: "api-key" }>;
  readonly integrationRefs?: readonly `${WebSearchProvider}-search`[];
}

interface V1Alpha1ExportSandboxBase {
  readonly network: Readonly<{
    policy: Readonly<{ explicit: Readonly<Record<string, unknown>> }>;
  }>;
}

/** Fabric adapter IDs that current v1 selects through `harness.kind`. */
export type V1Alpha1FabricHarnessKind =
  | "nvidia.fabric.langchain.deepagents"
  | "nvidia.fabric.hermes"
  | "nvidia.fabric.openclaw";

interface V1Alpha1ExportHarness {
  readonly kind: V1Alpha1FabricHarnessKind;
  readonly runtime?: Readonly<{ timeout_seconds: number }>;
}

export type V1Alpha1ExportSandbox = V1Alpha1ExportSandboxBase &
  Readonly<{
    harness: V1Alpha1ExportHarness;
    image: Readonly<{ ref: string }>;
    agent: Readonly<V1Alpha1ExportAgent>;
  }>;

export type V1Alpha1ExportIntegration = Readonly<{
  kind: "webSearch";
  provider: WebSearchProvider;
  credential: Readonly<{ env: string }>;
}>;

/** Producer-owned pre-release v1 shape emitted by v0. */
export interface V1Alpha1Export {
  readonly apiVersion: typeof V1ALPHA1_EXPORT_API_VERSION;
  readonly kind: typeof NEMOCLAW_CONFIG_KIND;
  readonly metadata: Readonly<{ name: string; uid: string }>;
  readonly spec: Readonly<{
    gateway: Readonly<{
      management: "managed";
      runtime: Readonly<{ provider: "docker" }>;
      endpoint: string;
    }>;
    services?: Readonly<Record<string, Readonly<V1Alpha1ExportService>>>;
    inferenceProviders: Readonly<
      Record<string, Readonly<V1Alpha1HostedInferenceProvider | V1Alpha1ServiceInferenceProvider>>
    >;
    integrations?: Readonly<Record<`${WebSearchProvider}-search`, V1Alpha1ExportIntegration>>;
    sandboxes: Readonly<Record<string, V1Alpha1ExportSandbox>>;
  }>;
}
