// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type {
  ManagedBootstrapRuntimeCreateLifecycle,
  ManagedBootstrapRuntimeCreateLifecycleInput,
  ManagedBootstrapRuntimeOnboardRouting,
  ManagedBootstrapRuntimeOnboardRoutingInput,
} from "../managed-bootstrap/runtime-create";
import type { NativeArtifactWorkloadReceiptV1 } from "../workload/native-artifact";
import type { ManagedImageSelectionPolicy } from "../workload/source";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceOperationInput,
  HostLocalInferenceService,
} from "./host-local-inference";

export const RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION = 1 as const;
export const RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION = 1 as const;
export const RUNTIME_PROVIDER_SNAPSHOT_PREFLIGHT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION = 2 as const;
export const RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION = 2 as const;
export const RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_CONTRACT_VERSION = 4 as const;
export const RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_PLAN_SCHEMA_VERSION = 1 as const;

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
  | "host-local-inference"
  | "sandbox-lifecycle"
  | "state-mutation"
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

export type RuntimeProviderReadOnlyHostMountCapability =
  | {
      readonly supported: true;
      readonly hostPlatforms: readonly NodeJS.Platform[];
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

export interface RuntimeProviderNormalizedCapabilities {
  readonly hostLocalInference: boolean;
  readonly directLifecycle: boolean;
  readonly legacyGatewayContainerInspection: boolean;
  readonly workloadImageCleanup: boolean;
  readonly readOnlyHostMounts: RuntimeProviderReadOnlyHostMountCapability;
}

export interface RuntimeProviderNativeArtifactBootstrapInput {
  readonly providerId: string;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly driveRoot: string;
  readonly artifactRoot: string;
  readonly workload: NativeArtifactWorkloadReceiptV1;
}

export interface RuntimeProviderNativeArtifactBootstrapPlan {
  readonly schemaVersion: typeof RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_PLAN_SCHEMA_VERSION;
  readonly providerId: string;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly authoritySha256: string;
  /** Provider-owned idempotency and recovery authority assigned before resource mutation. */
  readonly providerHandle: string;
  readonly driveRoot: string;
  readonly artifactRoot: string;
  readonly shareDirectory: string;
  readonly homeDirectory: string;
  readonly stateDirectory: string;
  readonly temporaryDirectory: string;
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly environment: {
    readonly HOME: string;
    readonly OPENCLAW_CONFIG_PATH: string;
    readonly OPENCLAW_HOME: string;
    readonly OPENCLAW_STATE_DIR: string;
    readonly TEMP: string;
    readonly TMP: string;
    readonly USERPROFILE: string;
  };
  readonly workload: NativeArtifactWorkloadReceiptV1;
}

export type RuntimeProviderNativeArtifactVerifyAndCreateOutcome =
  | {
      readonly status: "created";
      readonly authoritySha256: string;
      readonly providerHandle: string;
      readonly sandboxName: string;
      readonly lifecycleGeneration: string;
      readonly artifactDigest: string;
      readonly executableDigest: string;
    }
  | {
      readonly status: "not-created";
      readonly reason: "artifact-verification-failed" | "create-rejected";
    }
  | {
      readonly status: "unknown";
    };

export interface RuntimeProviderNativeArtifactReadinessEvidence {
  readonly authoritySha256: string;
  readonly providerHandle: string;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly artifactDigest: string;
  readonly executableDigest: string;
  readonly ready: boolean;
}

export type RuntimeProviderNativeArtifactRecoveryOutcome =
  | { readonly status: "absent" }
  | {
      readonly status: "removed" | "retained";
      readonly authoritySha256: string;
      readonly providerHandle: string;
      readonly sandboxName: string;
      readonly lifecycleGeneration: string;
    };

export interface RuntimeProviderNativeArtifactBootstrapOperations {
  /**
   * Verify artifact and executable digests, then create while holding the same stable filesystem
   * object authority. The provider must not re-resolve plan paths after verification.
   */
  verifyAndCreate(
    plan: RuntimeProviderNativeArtifactBootstrapPlan,
  ): Promise<RuntimeProviderNativeArtifactVerifyAndCreateOutcome>;
  verifyReadiness(
    plan: RuntimeProviderNativeArtifactBootstrapPlan,
    created: Extract<RuntimeProviderNativeArtifactVerifyAndCreateOutcome, { status: "created" }>,
  ): Promise<RuntimeProviderNativeArtifactReadinessEvidence>;
  /** Reconcile and remove only the resource bound to the plan's provider handle. */
  recoverCreate(
    plan: RuntimeProviderNativeArtifactBootstrapPlan,
  ): Promise<RuntimeProviderNativeArtifactRecoveryOutcome>;
}

export type RuntimeProviderNativeArtifactBootstrapResult = Readonly<{
  readonly outcome: "ready" | "not-created" | "retained";
  readonly reason:
    | null
    | "artifact-verification-failed"
    | "create-rejected"
    | "create-outcome-unknown"
    | "create-authority-mismatch"
    | "readiness-not-proven"
    | "recovered"
    | "recovery-not-proven";
  readonly authoritySha256: string;
  readonly providerHandle: string;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly resourceState: "active" | "absent" | "possibly-retained";
  readonly cleanup: {
    readonly attempted: boolean;
    readonly resourceRemovalAuthorized: boolean;
    readonly removed: boolean;
  };
  readonly recoveryRequired: boolean;
}>;

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

export type RuntimeProviderStateMutationSelector =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "prefix"; readonly prefix: string };

export type RuntimeProviderStateMutationProtectionPosture = "locked" | "mutable";
export type RuntimeProviderStateMutationFencePhase =
  | "fenced"
  | "published"
  | "rolled-back"
  | "activation-proven";

/** Exact recursive protection policy consumed by a fixed provider helper. */
export interface RuntimeProviderStateMutationStateLockPlan {
  readonly version: 1;
  readonly readOnlyRoots: readonly string[];
  readonly confidentialRoots: readonly string[];
  readonly readOnlyPrefixes: readonly string[];
  readonly confidentialPrefixes: readonly string[];
  readonly writableSubpaths: readonly string[];
}

/** One bounded runtime provider state mutation. Providers never accept commands or callbacks. */
interface RuntimeProviderStateMutationPlanBase {
  readonly schemaVersion: typeof RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION;
  readonly stateRoot: string;
  readonly selectors: readonly RuntimeProviderStateMutationSelector[];
  /** Digest of the complete projection produced by the selected AgentDefinition. */
  readonly projectionSha256: string;
}

export type RuntimeProviderStateMutationPlan =
  | (RuntimeProviderStateMutationPlanBase & {
      readonly intent: "protection-transition";
      readonly target: RuntimeProviderStateMutationProtectionPosture;
      readonly rollback: RuntimeProviderStateMutationProtectionPosture;
      readonly stateLockPlan: RuntimeProviderStateMutationStateLockPlan;
    })
  | (RuntimeProviderStateMutationPlanBase & {
      readonly intent: "restore";
      readonly target?: never;
      readonly rollback?: never;
      readonly stateLockPlan?: never;
    });

export interface RuntimeProviderPreparedStateMutationPlan {
  readonly plan: RuntimeProviderStateMutationPlan;
  /** Canonical bounded JSON suitable for a fixed provider helper's stdin. */
  readonly serializedPlan: string;
  readonly planSha256: string;
  readonly projectionSha256: string;
}

export interface RuntimeProviderStateMutationContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly sandbox: SandboxEntry;
  readonly sandboxName: string;
}

/** Opaque provider proof for one active, exact-runtime provider state mutation fence. */
export interface RuntimeProviderStateMutationFence {
  readonly schemaVersion: 1;
  readonly intent: "protection-transition";
  /** Last durable helper phase observed when this fence was returned. */
  readonly phase: RuntimeProviderStateMutationFencePhase;
  readonly providerId: string;
  readonly sandboxName: string;
  readonly transactionId: string;
  readonly lifecycleGeneration: string;
  readonly runtimeId: string;
  readonly runtimeStateSha256: string;
  /** Digest of the exact operation-scoped provider engine binding. */
  readonly engineBindingSha256: string;
  readonly stateRoot: string;
  readonly mountNamespaceId: string;
  readonly stateRootDevice: string;
  readonly stateRootInode: string;
  readonly planSha256: string;
  readonly projectionSha256: string;
  readonly target: RuntimeProviderStateMutationProtectionPosture;
  readonly rollback: RuntimeProviderStateMutationProtectionPosture;
  readonly nonce: string;
  readonly providerHandle: string;
}

/** Fresh service evidence required before a runtime provider state mutation fence may retire. */
export interface RuntimeProviderStateMutationActivationProof {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly runtimeId: string;
  readonly nonce: string;
  readonly configurationGeneration: string;
  readonly listenerIdentity: string;
  readonly healthSha256: string;
  readonly providerHandle: string;
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

export type RuntimeProviderHostLocalInferenceSurface =
  | RuntimeProviderSupportedSurface<{
      readonly services: readonly HostLocalInferenceService[];
      createOperation(input: HostLocalInferenceOperationInput): HostLocalInferenceOperation;
    }>
  | RuntimeProviderUnsupportedSurface;

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

export type RuntimeProviderStateMutationSurface =
  | RuntimeProviderSupportedSurface<{
      readonly contractVersion: typeof RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION;
      acquire(
        input: RuntimeProviderStateMutationContext & {
          /** Frozen, digested runtime provider state mutation plan. */
          readonly plan: RuntimeProviderPreparedStateMutationPlan;
        },
      ): RuntimeProviderStateMutationFence;
      assertFenced(
        input: RuntimeProviderStateMutationContext,
        fence: RuntimeProviderStateMutationFence,
      ): void;
      publish(
        input: RuntimeProviderStateMutationContext,
        fence: RuntimeProviderStateMutationFence,
      ): void;
      rollback(
        input: RuntimeProviderStateMutationContext,
        fence: RuntimeProviderStateMutationFence,
      ): void;
      activate(
        input: RuntimeProviderStateMutationContext,
        fence: RuntimeProviderStateMutationFence,
      ): RuntimeProviderStateMutationActivationProof;
      release(
        input: RuntimeProviderStateMutationContext,
        fence: RuntimeProviderStateMutationFence,
        proof: RuntimeProviderStateMutationActivationProof,
        completedLedgerSha256: string,
      ): void;
      recover(input: RuntimeProviderStateMutationContext): RuntimeProviderStateMutationFence | null;
    }>
  | RuntimeProviderUnsupportedSurface;

export type RuntimeProviderManagedImageBootstrapSurface = RuntimeProviderSupportedSurface<{
  readonly bootstrapKind: "managed-image";
  createAuthorityStore(input: {
    readonly stateRoot: string;
  }): import("../managed-bootstrap/adapter").ManagedBootstrapAuthorityStore;
  createLifecycle(
    input: ManagedBootstrapRuntimeCreateLifecycleInput,
  ): ManagedBootstrapRuntimeCreateLifecycle;
  createOnboardRouting(
    input: ManagedBootstrapRuntimeOnboardRoutingInput,
  ): ManagedBootstrapRuntimeOnboardRouting;
}>;

export type RuntimeProviderNativeArtifactBootstrapSurface = RuntimeProviderSupportedSurface<{
  readonly bootstrapKind: "native-artifact";
  readonly contractVersion: typeof RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_CONTRACT_VERSION;
  /** Run only with the provider-owned operations bound when the bundle is constructed. */
  run(
    input: RuntimeProviderNativeArtifactBootstrapInput,
  ): Promise<RuntimeProviderNativeArtifactBootstrapResult>;
  recover(
    input: RuntimeProviderNativeArtifactBootstrapInput,
  ): Promise<RuntimeProviderNativeArtifactBootstrapResult>;
}>;

export type RuntimeProviderBootstrapSurface =
  | RuntimeProviderManagedImageBootstrapSurface
  | RuntimeProviderNativeArtifactBootstrapSurface
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
  readonly hostLocalInference: RuntimeProviderHostLocalInferenceSurface;
  readonly lifecycle: RuntimeProviderLifecycleSurface;
  readonly mutationAuthority: RuntimeProviderMutationAuthoritySurface;
  readonly stateMutation: RuntimeProviderStateMutationSurface;
  readonly bootstrap: RuntimeProviderBootstrapSurface;
  readonly snapshot: RuntimeProviderSnapshotSurface;
  readonly recovery: RuntimeProviderRecoverySurface;
  readonly cleanup: RuntimeProviderCleanupSurface;
  readonly containerEngine: RuntimeProviderContainerEngineSurface;
}

export type RuntimeProviderBundleRegistry = Readonly<Record<string, RuntimeProviderBundle>>;
