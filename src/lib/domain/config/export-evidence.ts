// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import {
  BoundedTextSchema,
  CredentialEnvironmentReferenceNameSchema,
  ImmutableImageReferenceSchema,
  InferenceEndpointSchema,
  LocalResourceNameSchema,
  NemoClawInferenceApiSchema,
  NemoClawAgentTypeSchema,
  NemoClawManagedProxyConfigSchema,
  RuntimeProviderSchema,
  SandboxNameSchema,
  TcpPortSchema,
  isCredentialEnvironmentReferenceName,
  isValidNemoClawBoundedText,
  isValidNemoClawInferenceEndpoint,
  isValidNemoClawSandboxName,
} from "../../config/model";
import type { SandboxConfiguration } from "../sandbox/configuration";
import type { SandboxEntry } from "../../state/registry/types";

const { Type } = require("typebox") as typeof TypeBoxModule;

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
  "hermesApiPort",
  "hermesAuthMethod",
  "hermesDashboardEnabled",
  "hermesDashboardInternalPort",
  "hermesDashboardPort",
  "hermesDashboardTui",
  "hermesInferenceProvider",
  "hermesToolGateways",
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
  readonly provider: {
    readonly gatewayName: string;
    readonly workspace: string;
    readonly name: string;
    readonly id: string;
    readonly resourceVersion: string;
  };
  readonly endpoint: string;
  readonly source:
    | {
        readonly kind: "provider-config";
        readonly key: "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL";
      }
    | { readonly kind: "builtin-profile"; readonly profileId: "nvidia" };
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
  readonly resourceVersion: string;
  readonly workspace: string;
  readonly imageRef: string;
  readonly providerNames: readonly string[];
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
      configuration: SandboxConfiguration;
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

// Runtime refinements preserve semantic checks that are not part of JSON Schema.
const ExportInferenceSchema = Type.Object({
  provider: Type.Refine(BoundedTextSchema, isValidNemoClawBoundedText),
  model: Type.Refine(BoundedTextSchema, isValidNemoClawBoundedText),
  api: NemoClawInferenceApiSchema,
  endpoint: Type.Refine(InferenceEndpointSchema, isValidNemoClawInferenceEndpoint),
  credentialEnv: Type.Optional(
    Type.Refine(CredentialEnvironmentReferenceNameSchema, isCredentialEnvironmentReferenceName),
  ),
});

/** Representable values only; provenance and policy qualification remain separate. */
export const ExportSourceValuesSchema = Type.Object({
  sandboxName: Type.Refine(SandboxNameSchema, isValidNemoClawSandboxName),
  agent: NemoClawAgentTypeSchema,
  runtime: Type.Object({
    provider: RuntimeProviderSchema,
    imageRef: ImmutableImageReferenceSchema,
  }),
  gateway: Type.Object({ name: LocalResourceNameSchema, port: TcpPortSchema }),
  proxy: Type.Optional(NemoClawManagedProxyConfigSchema),
  inference: ExportInferenceSchema,
});

type ExportSourceValues = DeepReadonly<TypeBoxModule.Type.Static<typeof ExportSourceValuesSchema>>;
export type VerifiedExportGateway = ExportSourceValues["gateway"];
export type VerifiedExportInference = ExportSourceValues["inference"];

declare const VERIFIED_EXPORT_SOURCE: unique symbol;

/** Source values that passed all v1 export eligibility and provenance checks. */
export type VerifiedExportSource = ExportSourceValues & {
  readonly [VERIFIED_EXPORT_SOURCE]: true;
  readonly policy: CanonicalExportPolicy;
};

export type ExportSourceVerificationResult =
  | Readonly<{ kind: "verified"; source: VerifiedExportSource }>
  | Readonly<{ kind: "rejected"; findings: NonEmptyExportFindings }>;

/** The only observation port. Each call reads one complete source snapshot. */
export interface ExportSnapshotReader {
  read(sandboxName: string): Promise<RawExportSnapshot>;
}
