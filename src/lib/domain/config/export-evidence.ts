// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ImmutableImageReference, InferenceApi } from "../../config/model";
import type { SandboxEntry } from "../../state/registry/types";

type Primitive = bigint | boolean | null | number | string | symbol | undefined;
type DeepReadonly<Value> = Value extends Primitive
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export const EXPORT_REGISTRY_EVIDENCE_KEYS = [
  "agent",
  "compatibleEndpointReasoning",
  "compatibleEndpointReasoningEffort",
  "credentialEnv",
  "dashboardRemoteBindPrepared",
  "endpointUrl",
  "fromDockerfile",
  "gatewayName",
  "gatewayPort",
  "hostLocalInferenceProvenance",
  "hostLocalInferenceReceipt",
  "hostMounts",
  "imageTag",
  "lifecycleGeneration",
  "lifecycleLiveIdentityFingerprint",
  "mcp",
  "messaging",
  "model",
  "name",
  "nimContainer",
  "observabilityEnabled",
  "openclawImagePluginInstalls",
  "openshellDriver",
  "pendingRouteReservation",
  "preferredInferenceApi",
  "provider",
  "sandboxGpuDevice",
  "sandboxGpuEnabled",
  "toolDisclosure",
  "webSearchEnabled",
  "webSearchProvider",
  "workload",
] as const satisfies readonly (keyof SandboxEntry)[];

type ObservedExportRegistryKey = (typeof EXPORT_REGISTRY_EVIDENCE_KEYS)[number];

export type ObservedExportRegistry = DeepReadonly<Pick<SandboxEntry, ObservedExportRegistryKey>>;

declare const CANONICAL_EXPORT_POLICY: unique symbol;
export type CanonicalExportPolicy = Readonly<Record<string, unknown>> & {
  readonly [CANONICAL_EXPORT_POLICY]: true;
};

export interface ObservedExportGateway {
  readonly name: string;
  readonly port: number;
  readonly management: "nemoclaw" | "external" | "unknown";
  readonly stateRootOwned: boolean;
}

export interface ObservedExportEndpointEvidence {
  readonly endpoint: string;
  readonly gatewayName: string;
  readonly providerName: string;
  readonly configKey: "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL";
}

export interface ObservedExportInference {
  readonly topology: "hosted" | "managed" | "local" | "unknown";
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  /** Registry endpoint. It is not sufficient without independent live evidence. */
  readonly endpoint: string;
  readonly endpointEvidence: ObservedExportEndpointEvidence | null;
  readonly credentialEnv: string | null;
}

export interface ObservedExportPolicy {
  readonly sandboxId: string;
  readonly revision: string;
  readonly document: string;
}

export interface ObservedExportSandboxIdentity {
  readonly sandboxId: string;
  readonly fingerprint: string;
  readonly resourceVersion: number;
  readonly policyVersion: number;
}

export type ExportSnapshotReadStage =
  | "registry"
  | "gateway-binding"
  | "sandbox-inventory"
  | "sandbox-identity"
  | "inference-route"
  | "provider-metadata"
  | "effective-policy";

/** One complete, untrusted read from all export evidence owners. */
export type RawExportSnapshot =
  | Readonly<{ kind: "read-failed"; stage: ExportSnapshotReadStage }>
  | Readonly<{
      kind: "not-found";
      sandboxName: string;
    }>
  | Readonly<{
      kind: "observed";
      sandboxName: string;
      registry: ObservedExportRegistry;
      sandbox: ObservedExportSandboxIdentity;
      gateway: ObservedExportGateway;
      inference: ObservedExportInference;
      policy: ObservedExportPolicy;
    }>;

export type ObservedExportSnapshot = Extract<RawExportSnapshot, { kind: "observed" }>;

export type QualifiedExportPolicy = Readonly<
  Pick<ObservedExportPolicy, "revision" | "sandboxId"> &
    ({ kind: "verified"; canonical: CanonicalExportPolicy } | { kind: "not-representable" })
>;

/** One stable observation with its exact policy document qualified at the action boundary. */
export type QualifiedExportSnapshot = Readonly<
  Omit<ObservedExportSnapshot, "policy"> & { policy: QualifiedExportPolicy }
>;

export type ExportSourceFailureCategory =
  | "not-found"
  | "unsupported"
  | "missing-provenance"
  | "ambiguous"
  | "drifted"
  | "unstable-source"
  | "live-verification-failed"
  | "policy-not-representable";

export interface ExportFinding {
  readonly field: string;
  readonly category: ExportSourceFailureCategory;
  readonly diagnostic: string;
}

export type NonEmptyExportFindings = readonly [ExportFinding, ...ExportFinding[]];

export interface VerifiedExportGateway {
  readonly name: string;
  readonly port: number;
}

export interface VerifiedExportInference {
  readonly provider: string;
  readonly model: string;
  readonly api: InferenceApi;
  readonly endpoint: string;
  readonly credentialEnv?: string;
}

declare const VERIFIED_EXPORT_SOURCE: unique symbol;

/** Source values that passed all v1 export eligibility and provenance checks. */
export interface VerifiedExportSource {
  readonly [VERIFIED_EXPORT_SOURCE]: true;
  readonly sandboxName: string;
  readonly runtime: Readonly<{
    provider: string;
    imageRef: ImmutableImageReference;
  }>;
  readonly gateway: VerifiedExportGateway;
  readonly inference: VerifiedExportInference;
  readonly policy: CanonicalExportPolicy;
}

export type ExportSourceVerificationResult =
  | Readonly<{ kind: "verified"; source: VerifiedExportSource }>
  | Readonly<{ kind: "rejected"; findings: NonEmptyExportFindings }>;

/** The only observation port. Each call reads one complete source snapshot. */
export interface ExportSnapshotReader {
  read(sandboxName: string): Promise<RawExportSnapshot>;
}
