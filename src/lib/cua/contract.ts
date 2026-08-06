// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isCredentialShapedName } from "../security/credential-env.js";
import { CUA_HOST_COORDINATE, CUA_SENSITIVE_VALUE, canonicalJsonSha256 } from "./shared-primitives";

export const CUA_LIFECYCLE_SCHEMA_VERSION = "1.1.0" as const;
export const SUPPORTED_CUA_LIFECYCLE_SCHEMA_MAJOR = 1;

export const CUA_CAPABILITIES = ["browser", "computer", "terminal"] as const;
export type CuaCapability = (typeof CUA_CAPABILITIES)[number];

export const CUA_TARGET_OPERATIONS = [
  "target.attach",
  "target.status",
  "target.health",
  "target.detach",
  "target.destroy",
] as const;

export const CUA_TASK_OPERATIONS = [
  "task.start",
  "task.status",
  "task.result",
  "task.cancel",
] as const;

export const CUA_DEFERRED_TARGET_OPERATIONS = ["target.reset"] as const;
export const CUA_DEFERRED_TASK_OPERATIONS = [
  "task.pause",
  "task.guide",
  "task.respond",
  "task.events",
  "task.logs",
  "task.plans",
] as const;

export const CUA_SECURITY_OPERATIONS = ["security.status", "security.verify"] as const;

export const CUA_OPERATIONS = [
  ...CUA_TARGET_OPERATIONS,
  ...CUA_DEFERRED_TARGET_OPERATIONS,
  ...CUA_TASK_OPERATIONS,
  ...CUA_DEFERRED_TASK_OPERATIONS,
  ...CUA_SECURITY_OPERATIONS,
] as const;
export type CuaOperation = (typeof CUA_OPERATIONS)[number];

export const CUA_FAILURE_FAMILIES = [
  "lifecycle_unavailable",
  "runtime_unavailable",
  "runtime_incompatible",
  "inference_unavailable",
  "policy_invalid",
  "target_unreachable",
  "target_replaced",
  "target_incompatible",
  "capability_unhealthy",
  "target_conflict",
  "task_conflict",
  "task_timeout",
  "task_cancelled",
  "validation_failed",
] as const;
export type CuaFailureFamily = (typeof CUA_FAILURE_FAMILIES)[number];

export interface CuaComponentIdentity {
  name: string;
  version: string;
  digest: string;
  owner: string;
}

export interface CuaInferenceIdentity {
  provider: string;
  model: string;
  /** Secret-free identity of the complete managed inference route. */
  routeDigest: string;
}

/** Content-free identity of the effective OpenShell policy applied to one sandbox. */
export interface CuaAppliedPolicyIdentity {
  revision: number;
  digest: string;
}

export interface CuaCapabilityHealth {
  id: CuaCapability;
  protocolVersion: string;
  health: "healthy" | "unhealthy" | "unknown";
}

export interface CuaCapabilityIdentity {
  id: CuaCapability;
  protocolVersion: string;
}

export interface CuaRuntimeReadiness {
  schemaVersion: string;
  kind: "runtime-readiness";
  agent: "nemocua";
  mode: "standalone";
  status: "candidate" | "available" | "unavailable" | "incompatible";
  sourceRevision: string;
  sourceClean: true;
  runtimeManifestDigest: string;
  providerAuthorityDigest: string;
  qualification:
    | {
        state: "candidate";
        environmentDigest: string;
        bundleReceiptDigest: string;
      }
    | {
        state: "qualified";
        candidateSourceRevision: string;
        environmentDigest: string;
        receiptDigest: string;
        bundleReceiptDigest: string;
      }
    | null;
  components: {
    openshell: CuaComponentIdentity;
    runtime: CuaComponentIdentity;
    sandboxImage: CuaComponentIdentity;
    targetAdapter: CuaComponentIdentity;
    policy: CuaComponentIdentity;
    taskProtocol: CuaComponentIdentity;
    securityVerifier: CuaComponentIdentity;
  };
  inference: CuaInferenceIdentity;
  commands: {
    interactive: true;
    headless: true;
    version: true;
    smoke: true;
  };
  limits: {
    targetsPerWorker: 1;
    activeTasksPerTarget: 1;
  };
  requiredCapabilities: readonly CuaCapability[];
  targetOperations: readonly (typeof CUA_TARGET_OPERATIONS)[number][];
  taskOperations: readonly (typeof CUA_TASK_OPERATIONS)[number][];
  securityOperations: readonly (typeof CUA_SECURITY_OPERATIONS)[number][];
}

export interface CuaTargetAttachment {
  schemaVersion: string;
  kind: "target-attachment";
  status: "attached" | "detached" | "unreachable" | "incompatible" | "replaced";
  runtimeReadinessDigest: string | null;
  target: null | {
    identityDigest: string;
    platform: string;
    image: CuaComponentIdentity;
    serviceBundle: CuaComponentIdentity;
    capabilities: readonly CuaCapabilityHealth[];
  };
  activeTask: null | {
    taskId: string;
    status: "running" | "paused" | "input-required" | "cancelling";
    appliedPolicy: CuaAppliedPolicyIdentity;
  };
}

export interface CuaEvidenceReference {
  digest: string;
  classification: "private";
  mediaType?: string;
  sizeBytes?: number;
}

export interface CuaCapabilityReceipt {
  capability: CuaCapability;
  status: "completed" | "failed";
  evidenceDigests: readonly string[];
}

export interface CuaTaskResult {
  schemaVersion: string;
  kind: "task-result";
  taskId: string;
  status: "succeeded" | "failed" | "cancelled";
  targetIdentityDigest: string;
  runtimeReadinessDigest: string;
  components: {
    openshell: CuaComponentIdentity;
    runtime: CuaComponentIdentity;
    sandboxImage: CuaComponentIdentity;
    targetImage: CuaComponentIdentity;
    serviceBundle: CuaComponentIdentity;
    policy: CuaComponentIdentity;
    taskProtocol: CuaComponentIdentity;
  };
  inference: CuaInferenceIdentity;
  appliedPolicy: CuaAppliedPolicyIdentity;
  capabilities: readonly CuaCapabilityIdentity[];
  agentResult: {
    status: "succeeded" | "failed" | "cancelled";
    resultDigest: string;
  };
  verification: {
    status: "passed" | "failed" | "not-run";
    checkIds: readonly string[];
    evidenceDigests: readonly string[];
  };
  receipts: readonly CuaCapabilityReceipt[];
  evidence: readonly CuaEvidenceReference[];
}

/** Content identity used to reject state replay across readiness changes. */
export function getCuaRuntimeReadinessDigest(readiness: CuaRuntimeReadiness): string {
  return `sha256:${canonicalJsonSha256(readiness)}`;
}

export const CUA_DENIED_DESTINATIONS = [
  "unrelated-internet",
  "cloud-metadata",
  "undeclared-loopback",
  "host-administration",
  "host-desktop",
  "docker-socket",
] as const;

export const CUA_MATERIAL_EXCLUSIONS = [
  "prompt",
  "sandbox-filesystem",
  "arguments",
  "logs",
  "state",
  "diagnostics",
  "backups",
  "public-json",
  "build-logs",
] as const;

export const CUA_ARTIFACT_CLEANUP_OPERATIONS = ["target.detach", "target.destroy"] as const;

export const CUA_PRIVATE_MATERIALS = [
  "screenshots",
  "page-content",
  "screen-content",
  "downloads",
  "browser-profiles",
  "cookies",
  "mutable-target-state",
  "task-content",
  "results",
  "logs",
  "documents",
] as const;

export const CUA_UNTRUSTED_INPUTS = [
  "page-content",
  "screen-content",
  "downloads",
  "task-input",
  "runtime-output",
] as const;

export interface CuaSecurityAttestation {
  schemaVersion: string;
  kind: "security-attestation";
  status: "enforced";
  bindings: {
    runtimeReadinessDigest: string;
    targetIdentityDigest: string;
    components: CuaTaskResult["components"];
    inference: CuaInferenceIdentity;
    appliedPolicy: CuaAppliedPolicyIdentity;
    capabilities: readonly CuaCapabilityIdentity[];
  };
  network: {
    defaultAction: "deny";
    managedInference: "only";
    targetServices: readonly CuaCapability[];
    deniedDestinations: readonly (typeof CUA_DENIED_DESTINATIONS)[number][];
  };
  materialBoundary: {
    delivery: "host-side-secret-boundary";
    sandboxMaterial: "absent";
    excludedFrom: readonly (typeof CUA_MATERIAL_EXCLUSIONS)[number][];
  };
  isolation: {
    runAs: "non-root";
    privileged: false;
    hostDockerSocket: false;
    hostDesktop: false;
    broadWritableHostMounts: false;
  };
  artifacts: {
    materials: readonly (typeof CUA_PRIVATE_MATERIALS)[number][];
    classification: "private";
    contentIdentity: "sha256";
    access: "owner-only";
    metadata: "bounded";
    retention: "until-target-detach-or-destroy";
    cleanupOperations: readonly (typeof CUA_ARTIFACT_CLEANUP_OPERATIONS)[number][];
    backup: "excluded";
  };
  authority: {
    fixtureScope: "synthetic-local";
    externalSideEffects: "denied";
    untrustedInputs: readonly (typeof CUA_UNTRUSTED_INPUTS)[number][];
    mayExpand: false;
  };
  verifier: CuaComponentIdentity;
}

export interface CuaFailure {
  schemaVersion: string;
  kind: "failure";
  operation: CuaOperation;
  family: CuaFailureFamily;
  retryable: boolean;
  component?: CuaCapability | "runtime" | "inference" | "policy" | "target";
}

export type CuaLifecycleRecord =
  | CuaRuntimeReadiness
  | CuaTargetAttachment
  | CuaSecurityAttestation
  | CuaTaskResult
  | CuaFailure;

export type CuaSchemaCompatibility =
  | { compatible: true; major: number }
  | { compatible: false; major: number | null; reason: string };

export function checkCuaLifecycleSchemaVersion(schemaVersion: unknown): CuaSchemaCompatibility {
  if (typeof schemaVersion !== "string") {
    return { compatible: false, major: null, reason: "schemaVersion must be a string" };
  }

  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(schemaVersion);
  if (!match) {
    return { compatible: false, major: null, reason: "schemaVersion must use major.minor.patch" };
  }

  const major = Number(match[1]);
  if (major !== SUPPORTED_CUA_LIFECYCLE_SCHEMA_MAJOR) {
    return {
      compatible: false,
      major,
      reason: `unsupported CUA lifecycle schema major ${String(major)}`,
    };
  }
  return { compatible: true, major };
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function exactSetErrors(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): string[] {
  const errors: string[] = [];
  const duplicates = duplicateValues(actual);
  if (duplicates.length > 0)
    errors.push(`${label} contains duplicate values: ${duplicates.join(", ")}`);

  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unexpected = actual.filter((value) => !expected.includes(value));
  if (missing.length > 0) errors.push(`${label} is missing: ${missing.join(", ")}`);
  if (unexpected.length > 0)
    errors.push(`${label} contains unsupported values: ${unexpected.join(", ")}`);
  return errors;
}

function requiredSetErrors(
  label: string,
  actual: readonly string[],
  required: readonly string[],
  allowed: readonly string[],
): string[] {
  const errors: string[] = [];
  const duplicates = duplicateValues(actual);
  if (duplicates.length > 0) {
    errors.push(`${label} contains duplicate values: ${duplicates.join(", ")}`);
  }

  const actualSet = new Set(actual);
  const missing = required.filter((value) => !actualSet.has(value));
  const unexpected = actual.filter((value) => !allowed.includes(value));
  if (missing.length > 0) errors.push(`${label} is missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) {
    errors.push(`${label} contains unsupported values: ${unexpected.join(", ")}`);
  }
  return errors;
}

function credentialPathErrors(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      credentialPathErrors(entry, `${path}[${String(index)}]`),
    );
  }
  if (typeof value !== "object" || value === null) return [];

  const errors: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isCredentialShapedName(key)) {
      errors.push(`${childPath} is credential-shaped and cannot enter the public CUA contract`);
    }
    errors.push(...credentialPathErrors(child, childPath));
  }
  return errors;
}

const CUA_PROVIDER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CUA_MODEL_SELECTOR =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/;
const CUA_COMPONENT_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CUA_COMPONENT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const CUA_EVIDENCE_MEDIA_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

export function getCuaComponentIdentityErrors(
  component: CuaComponentIdentity,
  path: string,
): string[] {
  const fields = [
    ["name", component.name, CUA_COMPONENT_IDENTITY],
    ["version", component.version, CUA_COMPONENT_VERSION],
    ["owner", component.owner, CUA_COMPONENT_IDENTITY],
  ] as const;
  return fields.flatMap(([field, value, pattern]) =>
    pattern.test(value) && !CUA_SENSITIVE_VALUE.test(value) && !CUA_HOST_COORDINATE.test(value)
      ? []
      : [`${path}.${field} must be a printable coordinate- and credential-free identity`],
  );
}

function recordComponentIdentityErrors(record: CuaLifecycleRecord): string[] {
  if (record.kind === "runtime-readiness") {
    return Object.entries(record.components).flatMap(([name, component]) =>
      getCuaComponentIdentityErrors(component, `components.${name}`),
    );
  }
  if (record.kind === "target-attachment") {
    if (!record.target) return [];
    return [
      ...getCuaComponentIdentityErrors(record.target.image, "target.image"),
      ...getCuaComponentIdentityErrors(record.target.serviceBundle, "target.serviceBundle"),
    ];
  }
  if (record.kind === "task-result") {
    return Object.entries(record.components).flatMap(([name, component]) =>
      getCuaComponentIdentityErrors(component, `components.${name}`),
    );
  }
  if (record.kind === "security-attestation") {
    return [
      ...Object.entries(record.bindings.components).flatMap(([name, component]) =>
        getCuaComponentIdentityErrors(component, `bindings.components.${name}`),
      ),
      ...getCuaComponentIdentityErrors(record.verifier, "verifier"),
    ];
  }
  return [];
}

export function getCuaCoordinateFreeSelectorErrors(value: string, path: string): string[] {
  return CUA_MODEL_SELECTOR.test(value) &&
    !CUA_SENSITIVE_VALUE.test(value) &&
    !CUA_HOST_COORDINATE.test(value)
    ? []
    : [`${path} must be a printable coordinate- and credential-free selector`];
}

function inferenceIdentityErrors(inference: CuaInferenceIdentity): string[] {
  const errors: string[] = [];
  if (
    !CUA_PROVIDER_IDENTITY.test(inference.provider) ||
    CUA_SENSITIVE_VALUE.test(inference.provider) ||
    CUA_HOST_COORDINATE.test(inference.provider)
  ) {
    errors.push("inference.provider must be a printable credential-free identity");
  }
  if (getCuaCoordinateFreeSelectorErrors(inference.model, "inference.model").length > 0) {
    errors.push("inference.model must be a printable coordinate-free model selector");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(inference.routeDigest)) {
    errors.push("inference.routeDigest must be a sha256 digest");
  }
  return errors;
}

function publicIdentifierErrors(value: string, path: string): string[] {
  return CUA_COMPONENT_IDENTITY.test(value) &&
    !CUA_SENSITIVE_VALUE.test(value) &&
    !CUA_HOST_COORDINATE.test(value)
    ? []
    : [`${path} must be a printable coordinate- and credential-free identity`];
}

function capabilityProtocolErrors(
  capabilities: readonly CuaCapabilityIdentity[],
  path: string,
): string[] {
  return capabilities.flatMap((capability, index) =>
    CUA_COMPONENT_VERSION.test(capability.protocolVersion) &&
    !CUA_SENSITIVE_VALUE.test(capability.protocolVersion) &&
    !CUA_HOST_COORDINATE.test(capability.protocolVersion)
      ? []
      : [
          `${path}[${String(index)}].protocolVersion must be a printable coordinate- and credential-free identity`,
        ],
  );
}

function evidenceMediaTypeErrors(
  evidence: readonly CuaEvidenceReference[],
  path: string,
): string[] {
  return evidence.flatMap((entry, index) => {
    if (entry.mediaType === undefined) return [];
    return CUA_EVIDENCE_MEDIA_TYPE.test(entry.mediaType) &&
      !CUA_SENSITIVE_VALUE.test(entry.mediaType) &&
      !CUA_HOST_COORDINATE.test(entry.mediaType)
      ? []
      : [
          `${path}[${String(index)}].mediaType must be a printable coordinate- and credential-free media type`,
        ];
  });
}

/**
 * Validate cross-field invariants that JSON Schema cannot express without
 * coupling public records to array order or private runtime state.
 */
export function getCuaLifecycleSemanticErrors(record: CuaLifecycleRecord): string[] {
  const errors = [...credentialPathErrors(record), ...recordComponentIdentityErrors(record)];
  const compatibility = checkCuaLifecycleSchemaVersion(record.schemaVersion);
  if (!compatibility.compatible) errors.push(compatibility.reason);

  if (record.kind === "runtime-readiness") {
    errors.push(
      ...publicIdentifierErrors(record.agent, "agent"),
      ...inferenceIdentityErrors(record.inference),
      ...exactSetErrors("requiredCapabilities", record.requiredCapabilities, CUA_CAPABILITIES),
      ...exactSetErrors("targetOperations", record.targetOperations, CUA_TARGET_OPERATIONS),
      ...exactSetErrors("taskOperations", record.taskOperations, CUA_TASK_OPERATIONS),
      ...exactSetErrors("securityOperations", record.securityOperations, CUA_SECURITY_OPERATIONS),
    );
    if (record.status === "candidate" && record.qualification?.state !== "candidate") {
      errors.push("candidate readiness requires candidate qualification identity");
    }
    if (record.status === "available" && record.qualification?.state !== "qualified") {
      errors.push("available readiness requires qualified evidence identity");
    }
    if (
      (record.status === "unavailable" || record.status === "incompatible") &&
      record.qualification !== null
    ) {
      errors.push(`${record.status} readiness cannot carry qualification authority`);
    }
  }

  if (record.kind === "task-result") errors.push(...inferenceIdentityErrors(record.inference));

  if (record.kind === "target-attachment") {
    if (record.status === "detached") {
      if (record.target !== null) errors.push("a detached target must clear its public projection");
      if (record.activeTask !== null) errors.push("a detached target cannot report an active task");
      return errors;
    }
    if (record.runtimeReadinessDigest === null) {
      errors.push(`${record.status} target status requires a runtime-readiness identity`);
    }
    if (record.target === null) {
      errors.push(`${record.status} target status requires an immutable target projection`);
      return errors;
    }

    const capabilityIds = record.target.capabilities.map((capability) => capability.id);
    errors.push(...exactSetErrors("target.capabilities", capabilityIds, CUA_CAPABILITIES));
    errors.push(
      ...capabilityProtocolErrors(record.target.capabilities, "target.capabilities"),
      ...getCuaCoordinateFreeSelectorErrors(record.target.platform, "target.platform"),
    );
    if (
      record.status === "attached" &&
      record.target.capabilities.some((capability) => capability.health !== "healthy")
    ) {
      errors.push(
        "an attached target requires healthy browser, computer, and terminal capabilities",
      );
    }
  }

  if (record.kind === "task-result") {
    errors.push(
      ...publicIdentifierErrors(record.taskId, "taskId"),
      ...evidenceMediaTypeErrors(record.evidence, "evidence"),
      ...capabilityProtocolErrors(record.capabilities, "capabilities"),
      ...record.verification.checkIds.flatMap((checkId, index) =>
        publicIdentifierErrors(checkId, `verification.checkIds[${String(index)}]`),
      ),
      ...exactSetErrors(
        "capabilities",
        record.capabilities.map((capability) => capability.id),
        ["browser"],
      ),
    );

    const receiptCapabilities = record.receipts.map((receipt) => receipt.capability);
    const duplicateCapabilities = duplicateValues(receiptCapabilities);
    if (duplicateCapabilities.length > 0) {
      errors.push(`receipts contains duplicate capabilities: ${duplicateCapabilities.join(", ")}`);
    }

    const evidenceDigests = record.evidence.map((entry) => entry.digest);
    const duplicateEvidence = duplicateValues(evidenceDigests);
    if (duplicateEvidence.length > 0) {
      errors.push(`evidence contains duplicate digests: ${duplicateEvidence.join(", ")}`);
    }
    const evidenceSet = new Set(evidenceDigests);
    if (!evidenceSet.has(record.agentResult.resultDigest)) {
      errors.push(
        `agentResult references unknown evidence digest ${record.agentResult.resultDigest}`,
      );
    }
    for (const digest of record.verification.evidenceDigests) {
      if (!evidenceSet.has(digest)) {
        errors.push(`verification references unknown evidence digest ${digest}`);
      }
    }
    for (const receipt of record.receipts) {
      for (const digest of receipt.evidenceDigests) {
        if (!evidenceSet.has(digest)) {
          errors.push(`receipt ${receipt.capability} references unknown evidence digest ${digest}`);
        }
      }
    }

    if (
      record.status === "succeeded" &&
      (record.agentResult.status !== "succeeded" || record.verification.status !== "passed")
    ) {
      errors.push("a succeeded task requires a succeeded agent result and passed verification");
    }
    if (record.status === "succeeded") {
      errors.push(...exactSetErrors("receipts", receiptCapabilities, ["browser"]));
      if (record.receipts.some((receipt) => receipt.status !== "completed")) {
        errors.push("a succeeded task requires every capability receipt to be completed");
      }
      for (const receipt of record.receipts) {
        if (receipt.evidenceDigests.length === 0) {
          errors.push(`a succeeded task requires ${receipt.capability} receipt evidence`);
        }
      }
      if (record.verification.checkIds.length === 0) {
        errors.push("a succeeded task requires at least one independent verification check");
      }
      if (record.verification.evidenceDigests.length === 0) {
        errors.push("a succeeded task requires independent verification evidence");
      } else if (
        record.verification.evidenceDigests.every(
          (verificationDigest) => verificationDigest === record.agentResult.resultDigest,
        )
      ) {
        errors.push("verification evidence must be independent from the agent result");
      }
    }
    if (
      record.status === "failed" &&
      record.agentResult.status === "succeeded" &&
      record.verification.status === "passed"
    ) {
      errors.push(
        "a failed task cannot contain both a succeeded agent result and passed verification",
      );
    }
    if ((record.status === "cancelled") !== (record.agentResult.status === "cancelled")) {
      errors.push("task and agent result cancellation status must match");
    }
  }

  if (record.kind === "security-attestation") {
    errors.push(
      ...inferenceIdentityErrors(record.bindings.inference),
      ...capabilityProtocolErrors(record.bindings.capabilities, "bindings.capabilities"),
      ...exactSetErrors(
        "bindings.capabilities",
        record.bindings.capabilities.map(({ id }) => id),
        CUA_CAPABILITIES,
      ),
      ...exactSetErrors("network.targetServices", record.network.targetServices, CUA_CAPABILITIES),
      ...exactSetErrors(
        "network.deniedDestinations",
        record.network.deniedDestinations,
        CUA_DENIED_DESTINATIONS,
      ),
      ...exactSetErrors(
        "materialBoundary.excludedFrom",
        record.materialBoundary.excludedFrom,
        CUA_MATERIAL_EXCLUSIONS,
      ),
      ...exactSetErrors(
        "artifacts.cleanupOperations",
        record.artifacts.cleanupOperations,
        CUA_ARTIFACT_CLEANUP_OPERATIONS,
      ),
      ...exactSetErrors("artifacts.materials", record.artifacts.materials, CUA_PRIVATE_MATERIALS),
      ...exactSetErrors(
        "authority.untrustedInputs",
        record.authority.untrustedInputs,
        CUA_UNTRUSTED_INPUTS,
      ),
    );
  }

  return errors;
}
