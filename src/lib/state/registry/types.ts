// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InferenceSelection } from "../../inference/selection";
import type { ServingProfileProvenance } from "../../inference/serving/types";
import type { WebSearchProvider } from "../../inference/web-search";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import type { NativeArtifactWorkloadReceiptV1 } from "../../onboard/workload/native-artifact";
import type { ToolDisclosure } from "../../tool-disclosure";
import type { OpenClawImagePluginInstall } from "../openclaw-plugin-restore";
import type { SandboxMcpState } from "../registry-mcp";
import type { SandboxMessagingState } from "../registry-messaging";

/** Bounded identity checkpoint for one incomplete sandbox create. */
export interface PendingSandboxCreateIdentity {
  readonly schemaVersion: 1;
  readonly state: "verified-create";
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly sandboxIdentityFingerprint: string;
  readonly createAttemptNonce?: string;
  readonly route: "none" | "native" | "compatibility";
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
  /** Onboard session that owns this route transaction, retained after publication for exact idempotence. */
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
  /** Verified create boundary retained until final registration publishes atomically. */
  pendingCreateIdentity?: PendingSandboxCreateIdentity;
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
