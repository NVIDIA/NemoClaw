// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NEMOCLAW_CONFIG_KIND } from "./model";

export const V1ALPHA1_EXPORT_API_VERSION = "nemoclaw.nvidia.com/v1alpha1" as const;

const V1_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

export function isV1Alpha1ExportName(value: unknown): value is string {
  return typeof value === "string" && V1_SLUG_PATTERN.test(value);
}

/** Producer-owned shape emitted by v0. The v1 Rust parser remains the target contract authority. */
export interface V1Alpha1Export {
  readonly apiVersion: typeof V1ALPHA1_EXPORT_API_VERSION;
  readonly kind: typeof NEMOCLAW_CONFIG_KIND;
  readonly metadata: Readonly<{ name: string; uid: string }>;
  readonly spec: Readonly<{
    gateway: Readonly<{ management: "managed"; endpoint: string }>;
    inferenceProviders: readonly Readonly<{
      name: string;
      provider: "anthropic" | "openai";
      api: "anthropic-messages" | "openai-completions" | "openai-responses";
      endpoint: string;
      credential?: Readonly<{ env: string }>;
    }>[];
    sandboxes: readonly Readonly<{
      name: string;
      runtime: Readonly<{ provider: "docker" }>;
      network: Readonly<{
        policy: Readonly<{ explicit: Readonly<Record<string, unknown>> }>;
        proxy?: Readonly<{ host: string; port: number }>;
      }>;
      harness: Readonly<{
        kind: "hermes" | "openclaw";
        execution?: Readonly<{ timeoutSeconds?: number; heartbeatEvery?: string }>;
        interfaces?: Readonly<Record<string, unknown>>;
        observability?: Readonly<Record<string, unknown>>;
      }>;
      agents: readonly Readonly<{
        name: string;
        inference: Readonly<{
          routes: readonly Readonly<{
            name: string;
            providerRef: string;
            overrides: Readonly<Record<string, unknown> & { model: string }>;
          }>[];
        }>;
        auth?: Readonly<{ method: "api-key" }>;
        tools?:
          | Readonly<{ disclosure: "direct" | "progressive" }>
          | Readonly<{ allow: readonly "read"[] }>;
        integrationRefs?: readonly "brave-search"[];
      }>[];
      integrations?: Readonly<{
        "brave-search": Readonly<{
          kind: "webSearch";
          provider: "brave";
          credential: Readonly<{ env: string }>;
        }>;
      }>;
    }>[];
  }>;
}
