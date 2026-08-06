// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import {
  type CuaSecurityAdapter,
  CuaSecurityAdapterInvocationError,
} from "../adapters/cua-security";
import { withLock } from "../state/registry/lock";
import { load, save } from "../state/registry/persistence";
import type { SandboxRegistry } from "../state/registry/types";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaAppliedPolicyIdentity,
  type CuaCapability,
  type CuaFailure,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  getCuaRuntimeReadinessDigest,
} from "./contract";
import { isCuaFrameworkEnabled } from "./feature";
import {
  assertCuaLifecycleReadinessUnchanged,
  assertCuaLiveAppliedPolicyUnchanged,
  type CuaLifecycleReadinessDeps,
  requireCuaLifecycleReadiness,
  requireCuaLiveAppliedPolicy,
} from "./lifecycle-readiness";
import { executeCuaLifecycleRegistryTransaction } from "./lifecycle-registry-transaction";
import {
  beginCuaSideEffectReconciliation,
  cuaReconciliationAllowsOperation,
  isCuaReconciliationSideEffectOperation,
  quarantineCuaAuthority,
} from "./reconciliation";
import { parseCuaLifecycleRecord, parseCuaSecurityAttestation } from "./schema";

export type CuaSecurityOperation = "security.status" | "security.verify";

export interface CuaSecurityLifecycleInput {
  operation: CuaSecurityOperation;
  sandboxName: string;
  adapter?: CuaSecurityAdapter;
}

export interface CuaSecurityLifecycleResult {
  record: CuaSecurityAttestation | CuaFailure;
  exitCode: number;
}

export interface CuaSecurityLifecycleDeps extends CuaLifecycleReadinessDeps {
  load: () => SandboxRegistry;
  save: (registry: SandboxRegistry) => void;
  withLock: <T>(fn: () => T) => T;
  isFrameworkEnabled?: () => boolean;
  requireRuntimeReadiness?: typeof requireCuaLifecycleReadiness;
  checkpoint?: () => boolean;
}

const defaultDeps: CuaSecurityLifecycleDeps = { load, save, withLock };

export const CUA_SECURITY_EXIT_CODES = {
  success: 0,
  validation: 2,
  unavailable: 4,
  security: 5,
} as const;

function failure(
  operation: CuaSecurityOperation,
  family:
    | "validation_failed"
    | "lifecycle_unavailable"
    | "runtime_unavailable"
    | "runtime_incompatible"
    | "inference_unavailable"
    | "target_unreachable"
    | "policy_invalid",
  retryable: boolean,
  component: "runtime" | "inference" | "policy" | "target",
): CuaFailure {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family,
    retryable,
    component,
  };
}

function result(record: CuaSecurityAttestation | CuaFailure): CuaSecurityLifecycleResult {
  const exitCode =
    record.kind !== "failure"
      ? CUA_SECURITY_EXIT_CODES.success
      : record.family === "validation_failed"
        ? CUA_SECURITY_EXIT_CODES.validation
        : record.family === "lifecycle_unavailable" ||
            record.family === "runtime_unavailable" ||
            record.family === "inference_unavailable"
          ? CUA_SECURITY_EXIT_CODES.unavailable
          : CUA_SECURITY_EXIT_CODES.security;
  return { record, exitCode };
}

function failClosed(
  input: CuaSecurityLifecycleInput,
  registry: SandboxRegistry,
  deps: CuaSecurityLifecycleDeps,
  record: CuaFailure,
): CuaSecurityLifecycleResult {
  const sandbox = registry.sandboxes[input.sandboxName];
  if (input.operation === "security.verify" && sandbox) {
    if (clearPolicyBoundState(sandbox)) deps.save(registry);
  }
  return result(record);
}

function clearPolicyBoundState(sandbox: SandboxRegistry["sandboxes"][string]): boolean {
  let changed = false;
  if (sandbox.cuaSecurityAttestation !== undefined) {
    delete sandbox.cuaSecurityAttestation;
    changed = true;
  }
  if (sandbox.cuaTaskResults !== undefined) {
    delete sandbox.cuaTaskResults;
    changed = true;
  }
  return changed;
}

function capabilityIdentities(
  target: NonNullable<CuaTargetAttachment["target"]>,
): Array<{ id: CuaCapability; protocolVersion: string }> {
  return target.capabilities
    .map(({ id, protocolVersion }) => ({ id, protocolVersion }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function expectedComponents(
  runtime: CuaRuntimeReadiness,
  target: NonNullable<CuaTargetAttachment["target"]>,
): CuaSecurityAttestation["bindings"]["components"] {
  return {
    openshell: runtime.components.openshell,
    runtime: runtime.components.runtime,
    sandboxImage: runtime.components.sandboxImage,
    targetImage: target.image,
    serviceBundle: target.serviceBundle,
    policy: runtime.components.policy,
    taskProtocol: runtime.components.taskProtocol,
  };
}

export function cuaSecurityAttestationMatches(
  attestation: CuaSecurityAttestation,
  runtime: CuaRuntimeReadiness,
  target: NonNullable<CuaTargetAttachment["target"]>,
  appliedPolicy: CuaAppliedPolicyIdentity,
): boolean {
  return (
    attestation.status === "enforced" &&
    attestation.bindings.runtimeReadinessDigest === getCuaRuntimeReadinessDigest(runtime) &&
    attestation.bindings.targetIdentityDigest === target.identityDigest &&
    isDeepStrictEqual(attestation.verifier, runtime.components.securityVerifier) &&
    isDeepStrictEqual(attestation.bindings.components, expectedComponents(runtime, target)) &&
    isDeepStrictEqual(attestation.bindings.inference, runtime.inference) &&
    isDeepStrictEqual(attestation.bindings.appliedPolicy, appliedPolicy) &&
    isDeepStrictEqual(
      [...attestation.bindings.capabilities].sort((left, right) => left.id.localeCompare(right.id)),
      capabilityIdentities(target),
    )
  );
}

function invokeAdapter(
  input: CuaSecurityLifecycleInput,
  runtime: CuaRuntimeReadiness,
  target: CuaTargetAttachment,
  appliedPolicy: CuaAppliedPolicyIdentity,
): CuaSecurityAttestation | CuaFailure {
  if (!input.adapter) {
    return failure(input.operation, "lifecycle_unavailable", false, "policy");
  }
  try {
    const record = parseCuaLifecycleRecord(
      input.adapter.execute({
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "security-adapter-request",
        operation: "security.verify",
        sandboxName: input.sandboxName,
        appliedPolicy,
        runtime,
        target,
      }),
    );
    if (record.kind !== "security-attestation" && record.kind !== "failure") {
      return failure(input.operation, "validation_failed", false, "policy");
    }
    return record;
  } catch (error) {
    if (error instanceof CuaSecurityAdapterInvocationError) {
      return failure(input.operation, "policy_invalid", error.retryable, "policy");
    }
    return failure(input.operation, "policy_invalid", false, "policy");
  }
}

function executeLocked(
  input: CuaSecurityLifecycleInput,
  deps: CuaSecurityLifecycleDeps,
): CuaSecurityLifecycleResult {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return result(failure(input.operation, "lifecycle_unavailable", false, "runtime"));
  }
  const registry = deps.load();
  const sandbox = registry.sandboxes[input.sandboxName];
  if (!sandbox) {
    return result(failure(input.operation, "validation_failed", false, "target"));
  }
  if (
    sandbox.cuaReconciliation &&
    !cuaReconciliationAllowsOperation(sandbox.cuaReconciliation, input.operation)
  ) {
    return result(failure(input.operation, "lifecycle_unavailable", false, "runtime"));
  }

  const storedReadiness = sandbox.cuaRuntimeReadiness;
  if (!storedReadiness) {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "lifecycle_unavailable", false, "runtime"),
    );
  }
  if (
    (sandbox.provider !== undefined && sandbox.provider !== storedReadiness.inference.provider) ||
    (sandbox.model !== undefined && sandbox.model !== storedReadiness.inference.model)
  ) {
    quarantineCuaAuthority(sandbox, "inference-change");
    deps.save(registry);
    return result(failure(input.operation, "inference_unavailable", false, "inference"));
  }

  let runtime;
  try {
    runtime = (deps.requireRuntimeReadiness ?? requireCuaLifecycleReadiness)(sandbox, deps);
  } catch {
    quarantineCuaAuthority(sandbox, "readiness-change");
    deps.save(registry);
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "runtime_unavailable", false, "runtime"),
    );
  }
  if (runtime.status === "incompatible") {
    quarantineCuaAuthority(sandbox, "readiness-change");
    deps.save(registry);
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "runtime_incompatible", false, "runtime"),
    );
  }
  if (runtime.status !== "available" && runtime.status !== "candidate") {
    quarantineCuaAuthority(sandbox, "readiness-change");
    deps.save(registry);
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "runtime_unavailable", true, "runtime"),
    );
  }
  if (!runtime.securityOperations.includes(input.operation)) {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "lifecycle_unavailable", false, "runtime"),
    );
  }
  const runtimeReadinessDigest = getCuaRuntimeReadinessDigest(runtime);
  const target = sandbox.cuaTarget;
  if (
    !target?.target ||
    target.status !== "attached" ||
    target.runtimeReadinessDigest !== runtimeReadinessDigest
  ) {
    quarantineCuaAuthority(sandbox, "runtime-authority-change");
    deps.save(registry);
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "target_unreachable", true, "target"),
    );
  }

  let appliedPolicy: CuaAppliedPolicyIdentity;
  try {
    appliedPolicy = requireCuaLiveAppliedPolicy(sandbox, deps);
  } catch {
    clearPolicyBoundState(sandbox);
    quarantineCuaAuthority(sandbox, "policy-change");
    deps.save(registry);
    return result(failure(input.operation, "policy_invalid", false, "policy"));
  }

  const currentAttestation = sandbox.cuaSecurityAttestation;
  const currentAttestationMatches =
    currentAttestation !== undefined &&
    cuaSecurityAttestationMatches(currentAttestation, runtime, target.target, appliedPolicy);
  if (
    target.activeTask &&
    (!currentAttestationMatches ||
      !isDeepStrictEqual(target.activeTask.appliedPolicy, appliedPolicy))
  ) {
    clearPolicyBoundState(sandbox);
    quarantineCuaAuthority(sandbox, "policy-change");
    deps.save(registry);
    return result(failure(input.operation, "policy_invalid", false, "policy"));
  }

  if (input.operation === "security.status") {
    const current = sandbox.cuaSecurityAttestation;
    if (
      !current ||
      !cuaSecurityAttestationMatches(current, runtime, target.target, appliedPolicy)
    ) {
      if (clearPolicyBoundState(sandbox)) deps.save(registry);
      return result(failure(input.operation, "policy_invalid", false, "policy"));
    }
    return result(current);
  }

  if (isCuaReconciliationSideEffectOperation(input.operation)) {
    beginCuaSideEffectReconciliation(sandbox, input.operation, null, undefined, appliedPolicy);
    deps.save(registry);
    if (!deps.checkpoint?.()) {
      return result(failure(input.operation, "runtime_unavailable", false, "runtime"));
    }
  }

  const adapterResult = invokeAdapter(input, runtime, target, appliedPolicy);
  try {
    assertCuaLifecycleReadinessUnchanged(
      sandbox,
      runtimeReadinessDigest,
      deps,
      deps.requireRuntimeReadiness ?? requireCuaLifecycleReadiness,
    );
  } catch {
    quarantineCuaAuthority(sandbox, "readiness-change");
    deps.save(registry);
    return result(failure(input.operation, "runtime_unavailable", false, "runtime"));
  }
  try {
    assertCuaLiveAppliedPolicyUnchanged(sandbox, appliedPolicy, deps);
  } catch {
    clearPolicyBoundState(sandbox);
    quarantineCuaAuthority(sandbox, "policy-change");
    deps.save(registry);
    return result(failure(input.operation, "policy_invalid", false, "policy"));
  }
  if (adapterResult.kind === "failure") {
    if (adapterResult.operation !== input.operation || adapterResult.family !== "policy_invalid") {
      return failClosed(
        input,
        registry,
        deps,
        failure(input.operation, "validation_failed", false, "policy"),
      );
    }
    return failClosed(input, registry, deps, adapterResult);
  }

  let attestation: CuaSecurityAttestation;
  try {
    attestation = parseCuaSecurityAttestation(adapterResult);
  } catch {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "policy_invalid", false, "policy"),
    );
  }
  if (!cuaSecurityAttestationMatches(attestation, runtime, target.target, appliedPolicy)) {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "policy_invalid", false, "policy"),
    );
  }

  sandbox.cuaSecurityAttestation = structuredClone(attestation);
  if (
    sandbox.cuaTarget?.activeTask &&
    !isDeepStrictEqual(sandbox.cuaTarget.activeTask.appliedPolicy, appliedPolicy)
  ) {
    delete sandbox.cuaSecurityAttestation;
    quarantineCuaAuthority(sandbox, "policy-change");
    deps.save(registry);
    return result(failure(input.operation, "policy_invalid", false, "policy"));
  }
  delete sandbox.cuaTaskResults;
  delete sandbox.cuaReconciliation;
  deps.save(registry);
  return result(sandbox.cuaSecurityAttestation);
}

export function executeCuaSecurityLifecycle(
  input: CuaSecurityLifecycleInput,
  deps: CuaSecurityLifecycleDeps = defaultDeps,
): CuaSecurityLifecycleResult {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return result(failure(input.operation, "lifecycle_unavailable", false, "runtime"));
  }
  return executeCuaLifecycleRegistryTransaction({
    sandboxName: input.sandboxName,
    deps,
    execute: (working) =>
      executeLocked(input, {
        ...deps,
        ...working,
        isFrameworkEnabled: () => true,
      }),
    conflict: () => result(failure(input.operation, "runtime_unavailable", false, "runtime")),
  });
}
