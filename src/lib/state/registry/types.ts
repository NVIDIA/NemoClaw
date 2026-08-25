// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxPolicyAuthority } from "../../adapters/openshell/policy-authority";
import type { InferenceSelection } from "../../inference/selection";
import type { ServingProfileProvenance } from "../../inference/serving/types";
import type { WebSearchProvider } from "../../inference/web-search";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import type { NativeArtifactWorkloadReceiptV1 } from "../../onboard/workload/native-artifact";
import type { TrustedPrivatePolicyPinReceipt } from "../../policy/trusted-private-endpoints";
import type { ToolDisclosure } from "../../tool-disclosure";
import type { OpenClawImagePluginInstall } from "../openclaw-plugin-restore";
import type { SandboxMcpState } from "../registry-mcp";
import type { SandboxMessagingState } from "../registry-messaging";

export interface CustomPolicyEntry {
  name: string;
  content: string;
  /** Desired content reserved before a crash-safe generated-policy transition. */
  pendingContent?: string;
  sourcePath?: string;
  appliedAt?: string;
  /** Content-bound authority for generated exact destination pins. */
  trustedPrivatePins?: TrustedPrivatePolicyPinReceipt;
}

export interface BaselineExclusionEntry {
  /** Persistence schema version for this reviewed exclusion intent. */
  version: 1;
  /** Agent baseline that supplied the reviewed entry. */
  agent: string;
  /** Exact baseline network policy key excluded, e.g. "nous_research". */
  key: string;
  /** Digest of the reviewed baseline entry content the approval was bound to. */
  digest: string;
  /** When the exclusion was acknowledged. */
  acknowledgedAt?: string;
  /** Agent build/version recorded when the exclusion was last applied. */
  appliedAgentVersion?: string | null;
}

export type BaselineExclusionTransitionOperation = "exclude" | "restore";

/**
 * Durable journal for the one cross-system baseline mutation that is in flight.
 * `baselineExclusions` remains the last committed operator intent until this
 * transaction is published after the live OpenShell mutation succeeds.
 */
export interface BaselineExclusionTransition {
  id: string;
  operation: BaselineExclusionTransitionOperation;
  exclusion: BaselineExclusionEntry;
  /** Exact live-entry digest that completes the transition; null means absent. */
  targetLiveDigest: string | null;
  startedAt: string;
}

// Outcome of the last live sandbox GPU proof run during onboarding/recovery.
// `status` separates a configured-but-unverified GPU from one whose CUDA
// usability was actually proven (`verified`) or actively failed a live proof
// (`failed`, e.g. Jetson `/dev/nvmap` permission errors). Persisted so
// `nemoclaw <sandbox> status` can report proof state instead of treating any
// configured GPU as healthy (#4231).
export type SandboxGpuProofStatus = "verified" | "unverified" | "failed";

export interface SandboxGpuProofResult {
  status: SandboxGpuProofStatus;
  // True only when a CUDA-usability proof (cuInit via libcuda) actually passed.
  cudaVerified: boolean;
  // Label of the last proof that determined `status`.
  label?: string | null;
  // Redacted, truncated diagnostic captured when the proof failed.
  detail?: string | null;
  at: string;
}

/** Explicit host directories exposed read-only to this sandbox. */
export interface SandboxHostMount {
  source: string;
  target: string;
  readonly readOnly: true;
  /** Host filesystem identity captured when the source path was validated. */
  readonly sourceIdentity?: {
    readonly device: string;
    readonly inode: string;
  };
}

/**
 * Durable proof that one host-local runtime was explicitly admitted through
 * the hidden provider lifecycle selection. Legacy routes never receive this
 * record, even when they carry the same provider name or receipt schema.
 */
export interface SandboxHostLocalInferenceProvenance {
  readonly schemaVersion: 1;
  readonly origin: "startup-selection";
  /** Original private-state owner retained when exact same-gateway clones share a runtime. */
  readonly runtimeOwnerSandboxName: string;
  /** Provider create transaction bound to the canonical receipt. */
  readonly transactionId: string;
  /** Digest of the exact serialized receipt bytes carried by this row. */
  readonly receiptSha256: string;
}

export interface SandboxEntry extends Partial<InferenceSelection> {
  name: string;
  /** Route-only placeholder created before sandbox creation; never eligible as the default. */
  pendingRouteReservation?: true;
  /** Onboard session that owns a pending reservation, so resume preserves its own row while abandoned reservations stay reconcilable. */
  reservationSessionId?: string;
  createdAt?: string;
  /** Immutable catalog provenance for an explicitly selected serving profile. */
  servingProfileProvenance?: ServingProfileProvenance;
  gpuEnabled?: boolean;
  hostGpuDetected?: boolean;
  sandboxGpuEnabled?: boolean;
  sandboxGpuMode?: "auto" | "1" | "0" | string | null;
  sandboxGpuDevice?: string | null;
  sandboxGpuProof?: SandboxGpuProofResult | null;
  hostMounts?: SandboxHostMount[];
  openshellDriver?: string | null;
  openshellVersion?: string | null;
  /** Policy authority for a completed sandbox; absence means unknown. */
  policyAuthority?: SandboxPolicyAuthority;
  policies?: string[];
  customPolicies?: CustomPolicyEntry[];
  /** Operator exclusions from the agent baseline policy, replayed on rebuild. */
  baselineExclusions?: BaselineExclusionEntry[];
  /** Crash-recoverable journal for an exclusion/restore live-policy mutation. */
  baselineExclusionTransition?: BaselineExclusionTransition;
  policyTier?: string | null;
  // True once the onboard policy step has fully completed and reconciled the
  // effective preset selection (set by the post-policy registry write). Absent
  // on a sandbox whose registration recorded only boot-time presets but whose
  // policy step never finished — so re-onboard knows whether `policies`
  // represents a final selection it can carry forward. See #4621.
  policyPresetsFinalized?: boolean;
  webSearchEnabled?: boolean;
  /** Selected disclosure preference; model compatibility safeguards may downgrade runtime behavior. */
  toolDisclosure?: ToolDisclosure;
  /** Enables backend-neutral trace export to the fixed local OTLP collector boundary. */
  observabilityEnabled?: boolean;
  /** Image-baked permission to expose DCode's per-thread auto-approval opt-in. */
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  /** Durable provider identity for enabled managed web search. */
  webSearchProvider?: WebSearchProvider | null;
  agent?: string | null;
  agentVersion?: string | null;
  /** Plugin install baseline captured before state is restored into a fresh OpenClaw image. */
  openclawImagePluginInstalls?: OpenClawImagePluginInstall[];
  // NemoClaw build fingerprint (the NemoClaw CLI/build version) stamped only on
  // NemoClaw-managed images at create/rebuild time. `upgrade-sandboxes` compares
  // it against the running NemoClaw build so an image/build change with an
  // unchanged agent version is still detected as needing a rebuild. Custom-image
  // (`--from`) sandboxes are intentionally left without a fingerprint so they
  // are never auto-rebuilt onto the default image (#5026).
  nemoclawVersion?: string | null;
  fromDockerfile?: string | null;
  hermesAuthMethod?: "oauth" | "api_key" | null;
  imageTag?: string | null;
  /**
   * Durable source and ownership receipt for the workload behind imageTag.
   * Managed images are immutable shared release artifacts and must never flow
   * through per-sandbox image deletion.
   */
  workload?: SandboxWorkloadReceipt;
  /** Canonical provider-neutral receipt for an out-of-sandbox inference runtime. */
  hostLocalInferenceReceipt?: string | null;
  /** Explicit hidden-lifecycle provenance; absence keeps llama.cpp on its legacy path. */
  hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
  messaging?: SandboxMessagingState;
  mcp?: SandboxMcpState;
  hermesToolGateways?: string[];
  /** Destination-scoped provider holding the host-minted Hermes inference key. */
  hermesInferenceProvider?: string;
  hermesDashboardEnabled?: boolean;
  hermesDashboardPort?: number | null;
  hermesDashboardInternalPort?: number | null;
  hermesDashboardTui?: boolean;
  /**
   * Host port this sandbox exposes its OpenAI-compatible API on. The sandbox
   * and the host forward share the number, so two Hermes sandboxes on one host
   * need two values. Rows written before the port became per-sandbox carry no
   * value and resolve to the range start.
   */
  hermesApiPort?: number | null;
  dashboardPort?: number | null;
  /** Remote dashboard exposure was included in the sandbox's generated config. */
  dashboardRemoteBindPrepared?: boolean;
  /** Generation proving which durable same-name recreate registered this row. */
  lifecycleGeneration?: string;
  /** Hashed OpenShell identity paired with lifecycleGeneration for exact recovery. */
  lifecycleLiveIdentityFingerprint?: string;
  // OpenShell gateway registration name and host port bound to this sandbox.
  // Persisted so later lifecycle commands operate on the sandbox's own gateway
  // instead of the process-global `nemoclaw` singleton — a second sandbox on a
  // different NEMOCLAW_GATEWAY_PORT no longer recreates/kills the first (#4422).
  gatewayName?: string | null;
  gatewayPort?: number | null;
}

export type SandboxWorkloadReceipt =
  | {
      readonly schemaVersion: 1;
      readonly kind: "managed-image";
      readonly reference: string;
      /**
       * Exact OCI platform selected from the publication index. Receipts
       * created before multi-architecture managed images may omit this field,
       * but runtime providers must reject the ambiguous receipt rather than
       * infer a platform.
       */
      readonly platform?: "linux/amd64" | "linux/arm64";
      readonly release: string;
      readonly sourceRevision: string;
      /** Exact all-agent publication cohort that produced the immutable image. */
      readonly sourceCohort: string;
      readonly capabilityContractVersion: 1;
      readonly startupProfileContractVersion: 1;
      /** Canonical, secret-free base64url profile transport used to start this image. */
      readonly encodedProfile: string;
      readonly startupProfileSha256: string;
      /** Re-acquire launch-only proxy credentials from the operator environment when cloning. */
      readonly credentialProxyReplayRequired: boolean;
      /** Optional canonical standard-base64 public CA bundle bound by the profile digest. */
      readonly corporateCaB64?: string;
      readonly shared: true;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "legacy-dockerfile";
      readonly reference: string | null;
      readonly shared: false;
    }
  | NativeArtifactWorkloadReceiptV1;

export interface SandboxRegistry {
  sandboxes: Record<string, SandboxEntry>;
  defaultSandbox: string | null;
  defaultSelectionRevision?: number;
  extraProviders?: string[];
}
