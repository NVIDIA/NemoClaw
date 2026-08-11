// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isCredentialShapedName } from "../security/credential-env.js";
import {
  CUA_DOMAIN_COORDINATE,
  CUA_HOST_COORDINATE,
  CUA_SENSITIVE_VALUE,
  canonicalJsonSha256,
} from "./shared-primitives";

export const CUA_LIFECYCLE_SCHEMA_VERSION = "1.0.0" as const;
export const SUPPORTED_CUA_LIFECYCLE_SCHEMA_MAJOR = 1;

export const CUA_CAPABILITIES = ["browser", "computer", "terminal"] as const;
export type CuaCapability = (typeof CUA_CAPABILITIES)[number];

/** Later cumulative slices add operations only when their dispatch routes exist. */
export const CUA_TARGET_OPERATIONS = [] as const;
export const CUA_SECURITY_OPERATIONS = [] as const;
export const CUA_TASK_OPERATIONS = [] as const;

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

export interface CuaCapabilityIdentity {
  id: CuaCapability;
  protocolVersion: string;
}

export interface CuaRuntimeReadiness {
  schemaVersion: typeof CUA_LIFECYCLE_SCHEMA_VERSION;
  kind: "runtime-readiness";
  agent: "nemocua";
  mode: "standalone";
  status: "candidate" | "unavailable" | "incompatible";
  sourceRevision: string;
  sourceClean: true;
  runtimeManifestDigest: string;
  providerAuthorityDigest: string;
  qualification: {
    state: "candidate";
    environmentDigest: string;
    bundleReceiptDigest: string;
  } | null;
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
  appliedPolicy: CuaAppliedPolicyIdentity;
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
  targetOperations: readonly [];
  securityOperations: readonly [];
  taskOperations: readonly [];
}

export type CuaLifecycleRecord = CuaRuntimeReadiness;

/** Content identity used to reject state replay across readiness changes. */
export function getCuaRuntimeReadinessDigest(readiness: CuaRuntimeReadiness): string {
  return `sha256:${canonicalJsonSha256(readiness)}`;
}

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
  if (duplicates.length > 0) {
    errors.push(`${label} contains duplicate values: ${duplicates.join(", ")}`);
  }
  const unexpected = actual.filter((value) => !expected.includes(value));
  const missing = expected.filter((value) => !actual.includes(value));
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
      errors.push(
        `${childPath} is credential-shaped and cannot enter the credential-free CUA contract`,
      );
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
    CUA_HOST_COORDINATE.test(inference.provider) ||
    CUA_DOMAIN_COORDINATE.test(inference.provider)
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

/** Validate the Slice 1 invariants that JSON Schema cannot express. */
export function getCuaLifecycleSemanticErrors(record: CuaRuntimeReadiness): string[] {
  const errors = [...credentialPathErrors(record), ...inferenceIdentityErrors(record.inference)];
  const compatibility = checkCuaLifecycleSchemaVersion(record.schemaVersion);
  if (!compatibility.compatible) errors.push(compatibility.reason);
  for (const [name, component] of Object.entries(record.components)) {
    errors.push(...getCuaComponentIdentityErrors(component, `components.${name}`));
  }
  errors.push(
    ...exactSetErrors("requiredCapabilities", record.requiredCapabilities, CUA_CAPABILITIES),
    ...exactSetErrors("targetOperations", record.targetOperations, CUA_TARGET_OPERATIONS),
    ...exactSetErrors("securityOperations", record.securityOperations, CUA_SECURITY_OPERATIONS),
    ...exactSetErrors("taskOperations", record.taskOperations, CUA_TASK_OPERATIONS),
  );
  if (record.status === "candidate" && record.qualification?.state !== "candidate") {
    errors.push("candidate readiness requires candidate qualification identity");
  }
  if (
    (record.status === "unavailable" || record.status === "incompatible") &&
    record.qualification !== null
  ) {
    errors.push(`${record.status} readiness cannot carry qualification authority`);
  }
  return errors;
}
