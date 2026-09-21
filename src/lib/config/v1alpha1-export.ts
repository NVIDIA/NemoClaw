// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NEMOCLAW_CONFIG_KIND } from "./model";

export const V1ALPHA1_EXPORT_API_VERSION = "nemoclaw.nvidia.com/v1alpha1" as const;

const V1_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

export function isV1Alpha1ExportName(value: unknown): value is string {
  return typeof value === "string" && V1_SLUG_PATTERN.test(value);
}

interface V1Alpha1HostedInferenceProvider {
  readonly name: string;
  readonly provider: "anthropic" | "openai";
  readonly api: "anthropic-messages" | "openai-completions" | "openai-responses";
  readonly endpoint: string;
  readonly credential?: Readonly<{ env: string }>;
  readonly serviceRef?: never;
}

interface V1Alpha1OllamaInferenceProvider {
  readonly name: string;
  readonly provider: "openai";
  readonly api: "openai-completions";
  readonly serviceRef: string;
  readonly endpoint?: never;
  readonly credential?: never;
}

export interface V1Alpha1OllamaProxyService {
  readonly kind: "ollamaProxy";
  readonly endpoint: string;
  readonly upstream: Readonly<{
    endpoint: string;
    model: Readonly<{ name: string; digest: string }>;
  }>;
}

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
  readonly tools?:
    | Readonly<{ disclosure: "direct" | "progressive" }>
    | Readonly<{ allow: readonly "read"[] }>;
  readonly integrationRefs?: readonly "brave-search"[];
}

interface V1Alpha1ExportSandboxBase {
  readonly name: string;
  readonly runtime: Readonly<{ provider: "docker" }>;
  readonly network: Readonly<{
    policy: Readonly<{ explicit: Readonly<Record<string, unknown>> }>;
    proxy?: Readonly<{ host: string; port: number }>;
  }>;
  readonly integrations?: Readonly<{
    "brave-search": Readonly<{
      kind: "webSearch";
      provider: "brave";
      credential: Readonly<{ env: string }>;
    }>;
  }>;
}

interface V1Alpha1ExportHarness {
  readonly kind: "deepagents" | "hermes" | "openclaw";
  readonly execution?: Readonly<{ timeoutSeconds?: number; heartbeatEvery?: string }>;
  readonly interfaces?: Readonly<Record<string, unknown>>;
  readonly observability?: Readonly<Record<string, unknown>>;
}

export type V1Alpha1ExportSandbox = V1Alpha1ExportSandboxBase &
  (
    | Readonly<{
        harness: V1Alpha1ExportHarness & Readonly<{ kind: "deepagents" }>;
        image: Readonly<{ ref: string }>;
        agent: Readonly<V1Alpha1ExportAgent>;
      }>
    | Readonly<{
        harness: V1Alpha1ExportHarness & Readonly<{ kind: "openclaw" }>;
        agent: Readonly<V1Alpha1ExportAgent>;
      }>
    | Readonly<{
        harness: V1Alpha1ExportHarness & Readonly<{ kind: "hermes" | "openclaw" }>;
        agents: readonly Readonly<V1Alpha1ExportAgent>[];
      }>
  );

/** Producer-owned shape emitted by v0. The v1 Rust parser remains the target contract authority. */
export interface V1Alpha1Export {
  readonly apiVersion: typeof V1ALPHA1_EXPORT_API_VERSION;
  readonly kind: typeof NEMOCLAW_CONFIG_KIND;
  readonly metadata: Readonly<{ name: string; uid: string }>;
  readonly spec: Readonly<{
    gateway: Readonly<{ management: "managed"; endpoint: string }>;
    services?: Readonly<Record<string, Readonly<V1Alpha1OllamaProxyService>>>;
    inferenceProviders: readonly Readonly<
      V1Alpha1HostedInferenceProvider | V1Alpha1OllamaInferenceProvider
    >[];
    sandboxes: readonly V1Alpha1ExportSandbox[];
  }>;
}
