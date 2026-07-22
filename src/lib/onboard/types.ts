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
  readonly recreate: boolean;
  readonly toolDisclosure: import("../tool-disclosure").ToolDisclosure;
  readonly observabilityEnabled: boolean;
  /** Present only when the operator explicitly selected observability on or off. */
  readonly observabilityRequestedExplicitly?: true;
  readonly dcodeAutoApprovalMode?: import("./dcode-auto-approval").DcodeAutoApprovalMode;
  /** Non-secret upstream endpoint metadata for managed image config generation. */
  readonly endpointUrl?: string | null;
  /** Provenance for the endpoint recorded with the created sandbox. */
  readonly endpointSource?: import("../inference/selection").InferenceEndpointSource | null;
  /** Internal authoritative rebuild tier used before replacement registration completes. */
  readonly policyTier?: string | null;
  /** Gateway-level extra providers reconciled immediately before sandbox creation. */
  readonly extraProviders?: readonly string[];
  /** Internal OpenClaw resume authority for exact registered provider reuse. */
  readonly reuseRegisteredCredentials?: true;
}

export type OnboardOptions = {
  nonInteractive?: boolean;
  recreateSandbox?: boolean;
  authoritativeResumeConfig?: boolean;
  /** Internal endpoint provenance preserved across an authoritative rebuild. */
  endpointSource?: import("../inference/selection").InferenceEndpointSource | null;
  /** Internal authoritative rebuild target; never exposed as a public CLI option. */
  targetGatewayName?: string | null;
  /** Internal authoritative rebuild target; must match targetGatewayName. */
  targetGatewayPort?: number | null;
  /** Internal rebuild handoff: the outer destructive lifecycle owns the onboard lock. */
  onboardLockAlreadyHeld?: boolean;
  /** Internal one-shot handoff for a prevalidated managed DCode replacement. */
  preparedDcodeRebuild?: import("./prepared-dcode-rebuild").PreparedDcodeRebuildHandoff;
  /** Internal authoritative registry route captured before rebuild deletion. */
  rebuildRegistryInferenceRoute?: import("./rebuild-route-handoff").RebuildRouteHandoff | null;
  /** Internal one-shot authority to upsert a provider observed missing during rebuild preflight. */
  rebuildProviderReconfigure?: import("./rebuild-route-handoff").RebuildProviderReconfigureHandoff;
  /** Internal one-shot authority to recover the recorded provider during a locked rebuild resume. */
  providerRecoveryReceipt?: import("./rebuild-route-handoff").ProviderRecoveryReceipt;
  /** Internal one-shot handoff for the exact image context validated before rebuild deletion. */
  preparedImageRebuild?: import("./prepared-dcode-rebuild").PreparedImageRebuildHandoff;
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
  fromDockerfile?: string | null;
  sandboxName?: string | null;
  sandboxGpu?: "enable" | "disable" | null;
  sandboxGpuDevice?: string | null;
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
};
