// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { OnboardMachineState } from "../onboard/machine/types";

export const CHECKPOINT_SCHEMA_VERSION = 4 as const;

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

export type CheckpointOnboardProfile = "default" | "portable";

/** Secret-free durable identity for the user-owned portable Podman runtime. */
export interface CheckpointPortableRuntimeAuthority {
  readonly schemaVersion: 1;
  readonly kind: "podman";
  readonly ownership: "current-user";
  readonly uid: number;
  readonly homeDir: string;
  readonly configHome: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
}

export type CheckpointProfileDecision = {
  readonly kind: "selected";
  readonly value: CheckpointOnboardProfile;
};

export type CheckpointRuntimeAuthorityDecision =
  | { readonly kind: "unset" }
  | { readonly kind: "selected"; readonly value: CheckpointPortableRuntimeAuthority };

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

export type CheckpointSandboxRecreatePhase =
  | "planned"
  | "deleting"
  | "deleted"
  | "creating"
  | "created"
  | "registry_committing"
  | "completed";

/** Secret-free runtime ownership fields needed to remove one replaced image. */
export interface CheckpointSandboxRecreateSourceWorkload {
  readonly openshellDriver: string | null;
  readonly imageTag: string;
  readonly workload: {
    readonly kind: "legacy-dockerfile";
    readonly reference: string | null;
    readonly shared: boolean;
  } | null;
}

/**
 * Secret-free journal for one sandbox creation or same-name replacement. The
 * containing checkpoint supplies the session identity; the generation stamped
 * into the registry row proves which same-name sandbox this run created.
 */
export interface CheckpointSandboxRecreateTransaction {
  readonly version: 1;
  readonly id: string;
  readonly revision: number;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly sourceRegistryFingerprint: string;
  readonly sourceLiveIdentityFingerprint: string | null;
  readonly sourceWorkload: CheckpointSandboxRecreateSourceWorkload | null;
  readonly targetIntentFingerprint: string;
  readonly targetGeneration: string;
  readonly targetLiveIdentityFingerprint: string | null;
  readonly phase: CheckpointSandboxRecreatePhase;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface OnboardCheckpoint {
  readonly schemaVersion: CheckpointSchemaVersion;
  readonly sessionId: string;
  readonly machineState: OnboardMachineState;
  readonly updatedAt: string;
  readonly profile: CheckpointProfileDecision;
  readonly runtimeAuthority: CheckpointRuntimeAuthorityDecision;
  readonly sandboxIdentity: CheckpointDecision<CheckpointSandboxIdentity>;
  readonly webSearch: CheckpointDecision<WebSearchConfig>;
  readonly messaging: CheckpointDecision<CheckpointMessagingSelection>;
  readonly resourceProfile: CheckpointDecision<CheckpointResourceProfile>;
  readonly gatewayAuthority: CheckpointDecision<CheckpointGatewayAuthority>;
  readonly effectGroups: Readonly<
    Partial<Record<CheckpointEffectGroupName, CheckpointEffectGroupRecord>>
  >;
  readonly bindings: CheckpointBindings;
  readonly sandboxRecreate: CheckpointSandboxRecreateTransaction | null;
}

export type CheckpointLoadResult =
  | { readonly status: "none" }
  | { readonly status: "loaded"; readonly checkpoint: OnboardCheckpoint }
  | { readonly status: "legacy"; readonly foundVersion?: 1 | 2 | 3 }
  | { readonly status: "unsupported_future"; readonly foundVersion: number }
  | { readonly status: "corrupt" };
