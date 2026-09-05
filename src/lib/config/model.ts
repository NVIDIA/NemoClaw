// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NEMOCLAW_CONFIG_API_VERSION = "nemoclaw.nvidia.com/v1" as const;
export const NEMOCLAW_CONFIG_KIND = "NemoClawConfig" as const;

export interface CredentialEnvironmentReference {
  readonly env: string;
}

export interface NemoClawConfigMetadata {
  readonly name: string;
  /** Unbound document identity until a later accepted operation establishes ownership. */
  readonly uid: string;
}

export interface NemoClawGatewayConfig {
  readonly management: "nemoclaw";
  readonly name: string;
  readonly port: number;
}

export interface NemoClawInferenceProviderConfig {
  readonly name: string;
  readonly provider: string;
  readonly api: string;
  readonly endpoint: string;
  readonly credential?: CredentialEnvironmentReference;
}

export interface NemoClawRouteOverrides {
  readonly model: string;
}

export interface NemoClawInferenceRouteConfig {
  readonly name: string;
  readonly providerRef: string;
  readonly overrides: NemoClawRouteOverrides;
}

export interface NemoClawAgentConfig {
  readonly name: string;
  readonly type: "openclaw";
  readonly inference: Readonly<{ routes: readonly NemoClawInferenceRouteConfig[] }>;
}

export interface NemoClawManagedImageConfig {
  readonly ref: string;
  readonly digest: string;
}

export interface NemoClawSandboxRuntimeConfig {
  readonly provider: string;
  readonly image: NemoClawManagedImageConfig;
}

/** Lossless explicit OpenShell policy data. The shipped policy schema validates its fields. */
export type NemoClawExplicitPolicy = Readonly<Record<string, unknown>>;

export interface NemoClawSandboxConfig {
  readonly name: string;
  readonly runtime: NemoClawSandboxRuntimeConfig;
  readonly network: Readonly<{ policy: Readonly<{ explicit: NemoClawExplicitPolicy }> }>;
  readonly agents: readonly NemoClawAgentConfig[];
}

export interface NemoClawConfigSpec {
  readonly gateway: NemoClawGatewayConfig;
  readonly inferenceProviders: readonly NemoClawInferenceProviderConfig[];
  readonly sandboxes: readonly NemoClawSandboxConfig[];
}

/** Aggregate public configuration shared by export, validation, planning, and apply. */
export interface NemoClawConfig {
  readonly apiVersion: typeof NEMOCLAW_CONFIG_API_VERSION;
  readonly kind: typeof NEMOCLAW_CONFIG_KIND;
  readonly metadata: NemoClawConfigMetadata;
  readonly spec: NemoClawConfigSpec;
}
