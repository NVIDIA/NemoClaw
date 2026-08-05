// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type {
  ManagedBootstrapRuntimeCreateLifecycle,
  ManagedBootstrapRuntimeCreateLifecycleInput,
  ManagedBootstrapRuntimeOnboardRouting,
  ManagedBootstrapRuntimeOnboardRoutingInput,
} from "../managed-bootstrap/runtime-create";
import type { ManagedImageSelectionPolicy } from "../workload/source";

export const RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION = 1 as const;
export const RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION = 1 as const;
export const RUNTIME_PROVIDER_SNAPSHOT_PREFLIGHT_SCHEMA_VERSION = 1 as const;

export type RuntimeProviderGatewayLauncher = "nemoclaw" | "openshell";
export type RuntimeProviderLifecycleAction = "start" | "stop";
export type RuntimeProviderChannelStopTransport = "docker-kubectl-first" | "openshell";
export type RuntimeProviderMutationOperation =
  | "registration"
  | "start"
  | "stop"
  | "inference-set"
  | "rebuild"
  | "clone"
  | "provider-cleanup"
  | "destroy"
  | "workload-cleanup";
export type RuntimeProviderContainerEngineOperation =
  | "host-doctor"
  | "gateway-inspection"
  | "sandbox-lifecycle"
  | "workload-cleanup";

export interface RuntimeProviderIdentity {
  readonly contractVersion: typeof RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION;
  readonly id: string;
  readonly displayName: string;
}

export interface RuntimeProviderBoundSurface {
  readonly providerId: string;
  readonly supported: boolean;
}

export interface RuntimeProviderUnsupportedSurface extends RuntimeProviderBoundSurface {
  readonly supported: false;
  readonly reason: string;
}

export type RuntimeProviderSupportedSurface<T extends object> = Readonly<
  RuntimeProviderBoundSurface & {
    readonly supported: true;
  } & T
>;

export interface RuntimeProviderPlanDefinition {
  readonly gatewayLauncher: RuntimeProviderGatewayLauncher;
}

export interface RuntimeProviderNormalizedCapabilities {
  readonly hostLocalInference: boolean;
  readonly directLifecycle: boolean;
  readonly legacyGatewayContainerInspection: boolean;
  readonly workloadImageCleanup: boolean;
}

export type RuntimeProviderManagedImageSupport = {
  readonly exactDigestReferences: boolean;
  readonly platforms: readonly ("linux/amd64" | "linux/arm64")[];
  readonly startupProfileContractVersions: readonly number[];
  readonly capabilityContractVersions: readonly number[];
};

export type RuntimeProviderNativeArtifactSupport = {
  readonly exactDigestReferences: boolean;
  readonly platforms: readonly "windows/x64"[];
  readonly agents: readonly "openclaw"[];
  readonly contractVersions: readonly number[];
  readonly startupProfileContractVersions: readonly number[];
};

export interface RuntimeProviderWorkloadProfile {
  readonly support: RuntimeProviderManagedImageSupport | null;
  readonly nativeArtifactSupport?: RuntimeProviderNativeArtifactSupport | null;
  readonly hostArchitectures: readonly string[];
  readonly managedImageSelectionPolicy: ManagedImageSelectionPolicy;
  readonly legacyDockerfileBuilds: boolean;
}

export type RuntimeProviderDoctorCheck = {
  readonly group: "Host";
  readonly label: string;
  readonly status: "ok" | "warn" | "fail" | "info";
  readonly detail: string;
  readonly hint?: string;
};

export type RuntimeProviderCommandCapture = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
};

export interface RuntimeProviderLifecycleInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly log: (message: string) => void;
  readonly sandbox: SandboxEntry;
  readonly sandboxName: string;
}

export type RuntimeProviderLifecycleResult = {
  readonly exitCode: number;
  readonly message?: string;
};

export type RuntimeProviderLifecycleStopOutcome = RuntimeProviderLifecycleResult & {
  readonly state?: "already-stopped" | "stopped";
};

export interface RuntimeProviderLifecycleStopHooks {
  readonly beforeStop: () => void;
}

export type RuntimeProviderProviderDetachResult = {
  readonly detached: string[];
  readonly failures: Array<{ readonly name: string; readonly output: string }>;
};

export interface RuntimeProviderCleanupInput {
  readonly sandbox: SandboxEntry;
  readonly sandboxName: string;
}

export type RuntimeProviderWorkloadCleanupPlan =
  | {
      readonly action: "retain";
      readonly reason: "no-owned-image" | "shared-image";
    }
  | {
      readonly action: "remove";
      readonly engineDisplayName: string;
      readonly reference: string;
    }
  | {
      readonly action: "block";
      readonly reason: "authority-unproven";
    };

export type RuntimeProviderWorkloadCleanupResult =
  | {
      readonly status: "skipped";
      readonly reason: "no-owned-image" | "shared-image" | "authority-unproven";
    }
  | {
      readonly status: "removed";
      readonly engineDisplayName: string;
      readonly reference: string;
    }
  | {
      readonly status: "failed";
      readonly engineDisplayName: string;
      readonly reference: string;
    };

export interface RuntimeProviderCleanupOperations {
  readonly detachProviders: () => RuntimeProviderProviderDetachResult;
}

/**
 * Provider-neutral, bounded state persisted by provider-backed snapshots.
 * Provider handles remain opaque strings; acceleration is normalized so no
 * action module needs a Docker-, CDI-, or device-specific DTO.
 */
export interface RuntimeProviderRuntimeReceipt {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly runtime: {
    readonly kind: string;
    readonly handle: string;
  };
  readonly acceleration:
    | {
        readonly kind: "none";
      }
    | {
        readonly kind: "gpu";
        readonly vendor: string;
        readonly devices: readonly string[];
      };
}

export type RuntimeProviderSnapshotOperation = "backup" | "restore";
export type RuntimeProviderSnapshotLifecycleState = "running" | "paused" | "stopped";

export interface RuntimeProviderSnapshotPreflightReceipt {
  readonly schemaVersion: typeof RUNTIME_PROVIDER_SNAPSHOT_PREFLIGHT_SCHEMA_VERSION;
  readonly providerId: string;
  readonly operation: RuntimeProviderSnapshotOperation;
  readonly sandboxName: string;
  readonly providerHandle: string;
  readonly lifecycleState: RuntimeProviderSnapshotLifecycleState;
  readonly lifecycleGeneration: string;
}

export interface RuntimeProviderManagedProfileRestoreAuthority {
  readonly agent: string;
  readonly profileFingerprint: string;
}

/**
 * Complete normalized source state supplied to the owning restore facet.
 * `providerHandle` binds the lifecycle generation and full runtime receipt.
 */
export interface RuntimeProviderSnapshotRestoreSource {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly providerHandle: string;
  readonly lifecycleState: RuntimeProviderSnapshotLifecycleState;
  readonly lifecycleGeneration: string;
  readonly runtime: RuntimeProviderRuntimeReceipt;
}

export interface RuntimeProviderSnapshotRestoreReceipt {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly sandboxName: string;
  /** Provider-authored proof over preflight, source state, profile, and live runtime. */
  readonly providerHandle: string;
  readonly lifecycleState: RuntimeProviderSnapshotLifecycleState;
  readonly lifecycleGeneration: string;
  readonly runtime: RuntimeProviderRuntimeReceipt;
  readonly managedProfile: RuntimeProviderManagedProfileRestoreAuthority;
}

export type RuntimeProviderPreflightDoctorSurface = RuntimeProviderSupportedSurface<{
  inspectHost(): RuntimeProviderDoctorCheck;
  preflightLifecycle(
    action: RuntimeProviderLifecycleAction,
    input: RuntimeProviderLifecycleInput,
  ): RuntimeProviderLifecycleResult | null;
}>;

export type RuntimeProviderGatewaySurface = RuntimeProviderSupportedSurface<{
  readonly launcher: RuntimeProviderGatewayLauncher;
  readonly inspectLegacyContainer: boolean;
}>;

export type RuntimeProviderWorkloadSurface = RuntimeProviderSupportedSurface<{
  readonly profile: RuntimeProviderWorkloadProfile;
  acceptsReceipt(receipt: SandboxWorkloadReceipt | undefined): boolean;
}>;

export type RuntimeProviderLifecycleSurface =
  | RuntimeProviderSupportedSurface<{
      readonly channelStopTransport: RuntimeProviderChannelStopTransport;
      start(input: RuntimeProviderLifecycleInput): RuntimeProviderLifecycleResult;
      verifyStarted(
        input: RuntimeProviderLifecycleInput,
        verifyGateway: (sandboxName: string) => Promise<void>,
      ): Promise<void>;
      stop(
        input: RuntimeProviderLifecycleInput,
        hooks: RuntimeProviderLifecycleStopHooks,
      ): RuntimeProviderLifecycleStopOutcome;
    }>
  | RuntimeProviderUnsupportedSurface;

export type RuntimeProviderMutationAuthoritySurface =
  | RuntimeProviderSupportedSurface<{
      readonly operations: readonly RuntimeProviderMutationOperation[];
    }>
  | RuntimeProviderUnsupportedSurface;

export type RuntimeProviderBootstrapSurface =
  | RuntimeProviderSupportedSurface<{
      createAuthorityStore(input: {
        readonly stateRoot: string;
      }): import("../managed-bootstrap/adapter").ManagedBootstrapAuthorityStore;
      createLifecycle(
        input: ManagedBootstrapRuntimeCreateLifecycleInput,
      ): ManagedBootstrapRuntimeCreateLifecycle;
      createOnboardRouting(
        input: ManagedBootstrapRuntimeOnboardRoutingInput,
      ): ManagedBootstrapRuntimeOnboardRouting;
    }>
  | RuntimeProviderUnsupportedSurface;

export type RuntimeProviderSnapshotSurface =
  | RuntimeProviderSupportedSurface<{
      /**
       * Version the snapshot facet independently so providers can reject a
       * central contract they do not implement without forcing unrelated
       * bundle surfaces to rev in lockstep.
       */
      readonly contractVersion: typeof RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION;
      readonly capabilities: {
        readonly backup: boolean;
        readonly restore: boolean;
        readonly managedProfileRestore: boolean;
      };
      preflight(
        operation: RuntimeProviderSnapshotOperation,
        sandbox: SandboxEntry,
      ): RuntimeProviderSnapshotPreflightReceipt;
      capture(
        sandbox: SandboxEntry,
        preflight: RuntimeProviderSnapshotPreflightReceipt,
      ): RuntimeProviderRuntimeReceipt;
      validateRestore(
        sandbox: SandboxEntry,
        preflight: RuntimeProviderSnapshotPreflightReceipt,
        source: RuntimeProviderSnapshotRestoreSource,
        managedProfile: RuntimeProviderManagedProfileRestoreAuthority,
      ): void;
      restore(
        sandbox: SandboxEntry,
        preflight: RuntimeProviderSnapshotPreflightReceipt,
        source: RuntimeProviderSnapshotRestoreSource,
        managedProfile: RuntimeProviderManagedProfileRestoreAuthority,
      ): RuntimeProviderSnapshotRestoreReceipt;
    }>
  | RuntimeProviderUnsupportedSurface;

export type RuntimeProviderRecoverySurface =
  | RuntimeProviderSupportedSurface<{
      recover(sandbox: SandboxEntry): RuntimeProviderLifecycleResult;
    }>
  | RuntimeProviderUnsupportedSurface;

export type RuntimeProviderCleanupSurface =
  | RuntimeProviderSupportedSurface<{
      prepareDestroy(
        input: RuntimeProviderCleanupInput,
        operations: RuntimeProviderCleanupOperations,
      ): RuntimeProviderProviderDetachResult;
      /**
       * Produce a side-effect-free cleanup plan before any destructive
       * sandbox action. Providers must revalidate the same authority inside
       * removeOwnedWorkload before mutating their runtime.
       */
      planOwnedWorkloadCleanup(
        input: RuntimeProviderCleanupInput,
      ): RuntimeProviderWorkloadCleanupPlan;
      removeOwnedWorkload(input: RuntimeProviderCleanupInput): RuntimeProviderWorkloadCleanupResult;
    }>
  | RuntimeProviderUnsupportedSurface;

export type RuntimeProviderContainerEngineSurface =
  | RuntimeProviderSupportedSurface<{
      readonly identities: readonly {
        readonly operation: RuntimeProviderContainerEngineOperation;
        readonly engineId: string;
        readonly displayName: string;
      }[];
    }>
  | RuntimeProviderUnsupportedSurface;

/**
 * The sole registration unit for a runtime provider. Every surface is present
 * and bound to the same opaque identity; future work extends this object
 * instead of creating another independently populated registry.
 */
export interface RuntimeProviderBundle {
  readonly identity: RuntimeProviderIdentity;
  readonly plan: RuntimeProviderSupportedSurface<RuntimeProviderPlanDefinition>;
  readonly capabilities: RuntimeProviderSupportedSurface<RuntimeProviderNormalizedCapabilities>;
  readonly preflightDoctor: RuntimeProviderPreflightDoctorSurface;
  readonly gateway: RuntimeProviderGatewaySurface;
  readonly workload: RuntimeProviderWorkloadSurface;
  readonly lifecycle: RuntimeProviderLifecycleSurface;
  readonly mutationAuthority: RuntimeProviderMutationAuthoritySurface;
  readonly bootstrap: RuntimeProviderBootstrapSurface;
  readonly snapshot: RuntimeProviderSnapshotSurface;
  readonly recovery: RuntimeProviderRecoverySurface;
  readonly cleanup: RuntimeProviderCleanupSurface;
  readonly containerEngine: RuntimeProviderContainerEngineSurface;
}

export type RuntimeProviderBundleRegistry = Readonly<Record<string, RuntimeProviderBundle>>;
