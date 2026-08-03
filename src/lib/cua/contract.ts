// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isCredentialShapedName } from "../security/credential-env.js";

export const CUA_LIFECYCLE_SCHEMA_VERSION = "1.0.0" as const;
export const SUPPORTED_CUA_LIFECYCLE_SCHEMA_MAJOR = 1;

export const CUA_CAPABILITIES = ["browser", "computer", "terminal"] as const;
export type CuaCapability = (typeof CUA_CAPABILITIES)[number];

export const CUA_TARGET_OPERATIONS = [
  "target.attach",
  "target.status",
  "target.health",
  "target.detach",
  "target.reset",
  "target.destroy",
] as const;

export const CUA_REQUIRED_TASK_OPERATIONS = [
  "task.start",
  "task.status",
  "task.result",
  "task.events",
  "task.logs",
  "task.plans",
  "task.cancel",
] as const;

export const CUA_OPTIONAL_TASK_OPERATIONS = ["task.pause", "task.guide", "task.respond"] as const;

export const CUA_TASK_OPERATIONS = [
  ...CUA_REQUIRED_TASK_OPERATIONS,
  ...CUA_OPTIONAL_TASK_OPERATIONS,
] as const;

export const CUA_SECURITY_OPERATIONS = ["security.status", "security.verify"] as const;

export const CUA_OPERATIONS = [
  ...CUA_TARGET_OPERATIONS,
  ...CUA_TASK_OPERATIONS,
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
  mode: "standalone";
  status: "available" | "unavailable" | "incompatible";
  components: {
    runtime: CuaComponentIdentity;
    sandboxImage: CuaComponentIdentity;
    policy: CuaComponentIdentity;
    taskProtocol: CuaComponentIdentity;
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
}

export interface CuaTargetAttachment {
  schemaVersion: string;
  kind: "target-attachment";
  status: "attached" | "detached" | "unreachable" | "incompatible" | "replaced";
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

export interface CuaTaskEvidenceIndex {
  schemaVersion: string;
  kind: "task-evidence-index";
  taskId: string;
  category: "events" | "logs" | "plans";
  targetIdentityDigest: string;
  evidence: readonly CuaEvidenceReference[];
}

export interface CuaTaskResult {
  schemaVersion: string;
  kind: "task-result";
  taskId: string;
  status: "succeeded" | "failed" | "cancelled";
  targetIdentityDigest: string;
  components: {
    runtime: CuaComponentIdentity;
    sandboxImage: CuaComponentIdentity;
    targetImage: CuaComponentIdentity;
    serviceBundle: CuaComponentIdentity;
    policy: CuaComponentIdentity;
    taskProtocol: CuaComponentIdentity;
  };
  inference: CuaInferenceIdentity;
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

export const CUA_ARTIFACT_CLEANUP_OPERATIONS = ["target.reset", "target.destroy"] as const;

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
    targetIdentityDigest: string;
    components: CuaTaskResult["components"];
    inference: CuaInferenceIdentity;
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
    retention: "until-target-reset-or-destroy";
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
  | CuaTaskEvidenceIndex
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

/**
 * Validate cross-field invariants that JSON Schema cannot express without
 * coupling public records to array order or private runtime state.
 */
export function getCuaLifecycleSemanticErrors(record: CuaLifecycleRecord): string[] {
  const errors = credentialPathErrors(record);
  const compatibility = checkCuaLifecycleSchemaVersion(record.schemaVersion);
  if (!compatibility.compatible) errors.push(compatibility.reason);

  if (record.kind === "runtime-readiness") {
    errors.push(
      ...exactSetErrors("requiredCapabilities", record.requiredCapabilities, CUA_CAPABILITIES),
      ...exactSetErrors("targetOperations", record.targetOperations, CUA_TARGET_OPERATIONS),
      ...requiredSetErrors(
        "taskOperations",
        record.taskOperations,
        CUA_REQUIRED_TASK_OPERATIONS,
        CUA_TASK_OPERATIONS,
      ),
    );
  }

  if (record.kind === "target-attachment") {
    if (record.status === "detached") {
      if (record.target !== null) errors.push("a detached target must clear its public projection");
      if (record.activeTask !== null) errors.push("a detached target cannot report an active task");
      return errors;
    }
    if (record.target === null) {
      errors.push(`${record.status} target status requires an immutable target projection`);
      return errors;
    }

    const capabilityIds = record.target.capabilities.map((capability) => capability.id);
    errors.push(...exactSetErrors("target.capabilities", capabilityIds, CUA_CAPABILITIES));
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
      ...exactSetErrors(
        "capabilities",
        record.capabilities.map((capability) => capability.id),
        CUA_CAPABILITIES,
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

  if (record.kind === "task-evidence-index") {
    const duplicateEvidence = duplicateValues(record.evidence.map((entry) => entry.digest));
    if (duplicateEvidence.length > 0) {
      errors.push(`evidence contains duplicate digests: ${duplicateEvidence.join(", ")}`);
    }
  }

  return errors;
}
