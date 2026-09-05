// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared result and failure contracts used by the extracted onboarding helper modules.
 *
 * Keeping these shapes in one place avoids subtle field drift across http probing,
 * provider-model validation, and recovery classification.
 */

export interface ValidationFailureLike {
  httpStatus?: number;
  curlStatus?: number;
  message?: string;
  stderr?: string;
}

export interface ProbeResultBase {
  httpStatus: number;
  curlStatus: number;
  body: string;
  stderr: string;
  message: string;
}

export type ProbeResult = ({ ok: true } & ProbeResultBase) | ({ ok: false } & ProbeResultBase);

export interface ModelCatalogFetchSuccess {
  ok: true;
  ids: string[];
}

export interface ModelCatalogFetchFailure extends ValidationFailureLike {
  ok: false;
  httpStatus: number;
  curlStatus: number;
  message: string;
}

export type ModelCatalogFetchResult = ModelCatalogFetchSuccess | ModelCatalogFetchFailure;

export interface ModelValidationSuccess {
  ok: true;
  validated?: boolean;
}

export interface ModelValidationFailure extends ValidationFailureLike {
  ok: false;
  httpStatus: number;
  curlStatus: number;
  message: string;
}

export type ModelValidationResult = ModelValidationSuccess | ModelValidationFailure;

export interface SandboxCreateIntent {
  /** Complete secret-free create plan resolved by the onboarding machine. */
  readonly resolved?: import("./sandbox-create-intent-types").SandboxCreateIntent;
  /** Defer provider, credential, and attachment effects until the created sandbox identity is verified. */
  readonly deferSandboxEffectsUntilIdentityVerification?: true;
  readonly recreate: boolean;
  /** Explicit fresh-create mode that lets APF supply the sandbox-scoped policy. */
  readonly apfInterceptorRequested?: true;
  readonly toolDisclosure: import("../tool-disclosure").ToolDisclosure;
  readonly observabilityEnabled: boolean;
  /** Present only when the operator explicitly selected observability on or off. */
  readonly observabilityRequestedExplicitly?: true;
  readonly dcodeAutoApprovalMode?: import("./dcode-auto-approval").DcodeAutoApprovalMode;
  /** Non-secret upstream endpoint metadata for managed image config generation. */
  readonly endpointUrl?: string | null;
  /** Validated OpenAI-compatible reasoning capability selected during onboarding. */
  readonly compatibleEndpointReasoning?: "true" | "false";
  /** Provenance for the endpoint recorded with the created sandbox. */
  readonly endpointSource?: import("../inference/selection").InferenceEndpointSource | null;
  /** Internal authoritative rebuild tier used before replacement registration completes. */
  readonly policyTier?: string | null;
  /** Gateway-level extra providers reconciled immediately before sandbox creation. */
  readonly extraProviders?: readonly string[];
  /** Internal OpenClaw resume authority for exact registered provider reuse. */
  readonly reuseRegisteredCredentials?: true;
  /** Internal durable handoff for one journaled same-name replacement. */
  readonly recreateTransaction?: {
    readonly id: string;
    readonly targetGeneration: string;
    readonly targetIntentFingerprint: string;
  };
  /** Internal outer-rebuild authority for carrying managed MCP state through replacement. */
  readonly recreateJournalTargetIntentFingerprint?: string;
  /** Validated non-secret Hermes environment assignments carried by a rebuild. */
  readonly rebuildPreservedEnv?: readonly import("../state/preserved-env").PreservedEnvFile[];
  /** Bounded live OpenShell policy handoff for one active rebuild. */
  readonly rebuildPolicySourcePath?: string;
}

/** Exact sandbox identity retained from the immediate create boundary. */
export interface VerifiedSandboxCreateBoundary {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly createAttemptNonce?: string;
  readonly route: import("./docker-gpu-route").SelectedDockerGpuRoute;
}

/** Exact context made available after OpenShell confirms the created sandbox identity. */
export interface VerifiedSandboxCreateEffectsContext extends VerifiedSandboxCreateBoundary {
  readonly revalidateSandboxIdentity: (operation: string) => void;
}

/** Ephemeral effects that may run only after OpenShell confirms the created sandbox identity. */
export type VerifiedSandboxCreateEffects = (
  context: VerifiedSandboxCreateEffectsContext,
) => Promise<void>;

/** Durable onboarding-session identity and exact pending inference route. */
export interface InferenceRouteReservationAuthority {
  readonly sessionId: string;
  readonly selection: import("../inference/selection").InferenceSelection;
}

export type OnboardOptions = {
  /** Hidden temporary opt-in for new managed-image runtime activation. */
  tempManagedRuntime?: boolean;
  /** Hidden exact-catalog input for managed-runtime qualification. */
  tempManagedRuntimeCatalog?: string | null;
  nonInteractive?: boolean;
  recreateSandbox?: boolean;
  /** Internal CLI composition for host-only Google Chat tunnel effects. */
  googlechatTunnelRuntime?: Omit<
    import("../messaging/channels/googlechat/hooks/tunnel-runtime").GooglechatTunnelRuntimeDeps,
    "prompt" | "sandboxName"
  >;
  authoritativeResumeConfig?: boolean;
  /** Internal permission granted only by a validated prepared-backup rebuild. */
  allowRemovedImmutabilityStateRecord?: true;
  /** Internal endpoint provenance preserved across an authoritative rebuild. */
  endpointSource?: import("../inference/selection").InferenceEndpointSource | null;
  /** Internal authoritative rebuild target; never exposed as a public CLI option. */
  targetGatewayName?: string | null;
  /** Internal authoritative rebuild target; must match targetGatewayName. */
  targetGatewayPort?: number | null;
  /** Exact OpenShell client target frozen by the outer rebuild transaction. */
  runtimeSelection?: import("../adapters/openshell/runtime-selection").OpenShellRuntimeSelection;
  /** Internal rebuild handoff: the outer destructive lifecycle owns the onboard lock. */
  onboardLockAlreadyHeld?: boolean;
  /** Internal command handoff: propagate an exit request after onboarding restores its scopes. */
  deferProcessExit?: boolean;
  /** Internal rebuild handoff: target fingerprint of the journal opened before deletion. */
  recreateJournalTargetIntentFingerprint?: string | null;
  /** Internal one-shot handoff for a prevalidated managed DCode replacement. */
  preparedDcodeRebuild?: import("./prepared-dcode-rebuild").PreparedDcodeRebuildHandoff;
  /** Internal authoritative registry route captured before rebuild deletion. */
  rebuildRegistryInferenceRoute?: import("./rebuild-route-handoff").RebuildRouteHandoff | null;
  /** Internal one-shot authority to upsert a provider observed missing during rebuild preflight. */
  rebuildProviderReconfigure?: import("./rebuild-route-handoff").RebuildProviderReconfigureHandoff;
  /** Internal one-shot authority to recover the recorded provider during a locked rebuild resume. */
  providerRecoveryReceipt?: import("./rebuild-route-handoff").ProviderRecoveryReceipt;
  /** Internal rebuild handoff for a recorded provider admitted by Deferred N1x readiness. */
  allowDeferredN1xManagedVllm?: true;
  /** Internal one-shot handoff for the exact image context validated before rebuild deletion. */
  preparedImageRebuild?: import("./prepared-dcode-rebuild").PreparedImageRebuildHandoff;
  /** Internal immutable managed-image/profile handoff validated before rebuild deletion. */
  managedWorkloadRebuild?: import("./workload/rebuild").ManagedWorkloadRebuildHandoff;
  /** Internal validated non-secret Hermes environment assignments carried by a rebuild. */
  rebuildPreservedEnv?: readonly import("../state/preserved-env").PreservedEnvFile[];
  /** Bounded live OpenShell policy handoff for one active rebuild. */
  rebuildPolicySourcePath?: string;
  /** Internal hint for resolving the sandbox base image without repeating remote discovery. */
  baseImageResolutionHint?:
    | import("../sandbox-base-image").SandboxBaseImageResolutionMetadata
    | null;
  /** Internal rebuild handoff for provenance already bound to an immutable local base ref. */
  preResolvedBaseImageMetadata?:
    | import("../sandbox-base-image").SandboxBaseImageResolutionMetadata
    | null;
  resume?: boolean;
  fresh?: boolean;
  /** Operator-selected APF compatibility mode for fresh sandbox creation. */
  apfInterceptorRequested?: boolean | null;
  fromDockerfile?: string | null;
  sandboxName?: string | null;
  /** Explicit host directories exposed read-only to the sandbox. */
  hostMounts?: readonly import("../state/registry/types").SandboxHostMount[];
  sandboxGpu?: "enable" | "disable" | null;
  sandboxGpuDevice?: string | null;
  /** GPU exposed to the host-side vLLM container managed by NemoClaw. */
  vllmGpuDevice?: string | null;
  acceptThirdPartySoftware?: boolean;
  agent?: string | null;
  toolDisclosure?: import("../tool-disclosure").ToolDisclosure | null;
  observabilityEnabled?: boolean | null;
  /** Internal provenance for an authoritative observability value. */
  observabilityRequestedExplicitly?: boolean;
  dcodeAutoApprovalMode?: import("./dcode-auto-approval").DcodeAutoApprovalMode | null;
  /** Internal authoritative rebuild tier; never exposed as an onboard CLI option. */
  policyTier?: string | null;
  controlUiPort?: number | null;
  gpu?: boolean;
  noGpu?: boolean;
  autoYes?: boolean;
  experimentalProfile?: import("./docker-driver-platform").ExperimentalOnboardProfile | null;
  /** Read-only checkpoint identity captured before the onboarding lock. */
  resumeIntentSnapshot?: import("./session-bootstrap").OnboardResumeIntentSnapshot | null;
  /** Secret-free inference activation used by the locked portable environment scope. */
  portableInferenceActivation?:
    | import("./experimental/portable-inference-descriptor").PortableInferenceActivation
    | null;
  /** Internal portable host-preparation dependency for boundary verification. */
  preparePortableHost?: typeof import("./experimental/portable-host-preparation").preparePortableExperimentalHost;
  /** Exact secret-free serving catalog identity selected by the generic profile UX. */
  servingProfileProvenance?: import("../inference/serving/types").ServingProfileProvenance | null;
};
