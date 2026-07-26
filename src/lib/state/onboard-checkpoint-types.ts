// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { OnboardMachineState } from "../onboard/machine/types";

export const CHECKPOINT_SCHEMA_VERSION = 2 as const;

export type CheckpointSchemaVersion = typeof CHECKPOINT_SCHEMA_VERSION;

export type CheckpointDecision<T> =
  | { readonly kind: "unset" }
  | { readonly kind: "declined" }
  | { readonly kind: "selected"; readonly value: T };

export interface CheckpointSandboxIdentity {
  readonly name: string;
  readonly agent: string;
}

export interface CheckpointResourceProfile {
  readonly cpu: string;
  readonly memory: string;
}

export interface CheckpointMessagingSelection {
  readonly selectedChannels: readonly string[];
  readonly disabledChannels: readonly string[];
}

export type CheckpointEffectGroupName =
  | "web_search_provider"
  | "messaging_providers"
  | "sandbox_create"
  | "sandbox_register";

export interface CheckpointEffectGroupRecord {
  readonly completedAt: string;
  readonly fingerprint: string;
}

export interface CheckpointProviderBinding {
  readonly name: string;
  readonly type: string;
  readonly credentialEnv: string;
}

export interface CheckpointGatewaySupervisor {
  readonly kind: "systemd-system" | "systemd-user";
  readonly serviceName: string;
  readonly execPath: string;
}

/** Secret-free lifecycle authority bound to one canonical gateway name and port. */
export interface CheckpointGatewayAuthority {
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly mode: "nemoclaw-managed" | "externally-supervised";
  readonly source: "declared" | "packaged-service" | "standalone";
  readonly endpoint: string | null;
  readonly stateDir: string | null;
  readonly supervisor: CheckpointGatewaySupervisor | null;
  readonly requiredCapabilities: readonly string[];
}

export interface CheckpointBindings {
  readonly credentialEnvs: readonly string[];
  readonly registeredProviders: readonly CheckpointProviderBinding[];
}

export interface OnboardCheckpoint {
  readonly schemaVersion: CheckpointSchemaVersion;
  readonly sessionId: string;
  readonly machineState: OnboardMachineState;
  readonly updatedAt: string;
  readonly sandboxIdentity: CheckpointDecision<CheckpointSandboxIdentity>;
  readonly webSearch: CheckpointDecision<WebSearchConfig>;
  readonly messaging: CheckpointDecision<CheckpointMessagingSelection>;
  readonly resourceProfile: CheckpointDecision<CheckpointResourceProfile>;
  readonly gatewayAuthority: CheckpointDecision<CheckpointGatewayAuthority>;
  readonly effectGroups: Readonly<
    Partial<Record<CheckpointEffectGroupName, CheckpointEffectGroupRecord>>
  >;
  readonly bindings: CheckpointBindings;
}

export type CheckpointLoadResult =
  | { readonly status: "none" }
  | { readonly status: "loaded"; readonly checkpoint: OnboardCheckpoint }
  | {
      readonly status: "migrated";
      readonly checkpoint: OnboardCheckpoint;
      readonly fromVersion: number;
    }
  | { readonly status: "unsupported_future"; readonly foundVersion: number }
  | { readonly status: "corrupt" };
