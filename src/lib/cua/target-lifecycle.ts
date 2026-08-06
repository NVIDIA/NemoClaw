// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type {
  CuaTargetAdapter,
  CuaTargetAdapterOperation,
  CuaTargetAdapterResult,
} from "../adapters/cua-target";
import { CuaTargetAdapterInvocationError } from "../adapters/cua-target";
import { withLock } from "../state/registry/lock";
import { load, save } from "../state/registry/persistence";
import type { SandboxRegistry } from "../state/registry/types";
import { readBoundedRegularFile } from "./bounded-file";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaAppliedPolicyIdentity,
  type CuaCapability,
  type CuaComponentIdentity,
  type CuaFailure,
  type CuaFailureFamily,
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
  recordCuaReconciliationObservation,
} from "./reconciliation";
import { getCuaTargetArtifactBindings } from "./runtime-manifest";
import { type CuaTargetManifest, parseCuaLifecycleRecord, parseCuaTargetManifest } from "./schema";
import { cuaSecurityAttestationMatches } from "./security-lifecycle";

export type CuaTargetLifecycleOperation = CuaTargetAdapterOperation | "target.status";

export interface CuaTargetLifecycleInput {
  operation: CuaTargetLifecycleOperation;
  sandboxName: string;
  adapter?: CuaTargetAdapter;
  manifest?: CuaTargetManifest;
}

export interface CuaTargetLifecycleResult {
  record: CuaTargetAttachment | CuaFailure;
  exitCode: number;
}

export interface CuaTargetLifecycleDeps extends CuaLifecycleReadinessDeps {
  load: () => SandboxRegistry;
  save: (registry: SandboxRegistry) => void;
  withLock: <T>(fn: () => T) => T;
  isFrameworkEnabled?: () => boolean;
  requireRuntimeReadiness?: typeof requireCuaLifecycleReadiness;
  getRuntimeTargetAuthority?: (env: NodeJS.ProcessEnv) => CuaRuntimeTargetAuthority;
  checkpoint?: () => boolean;
}

export interface CuaRuntimeTargetAuthority {
  platform: string;
  image: CuaComponentIdentity;
  serviceBundle: CuaComponentIdentity;
}

const defaultDeps: CuaTargetLifecycleDeps = { load, save, withLock };

const MAX_TARGET_MANIFEST_BYTES = 64 * 1024;

export const CUA_TARGET_EXIT_CODES = {
  success: 0,
  validation: 2,
  conflict: 3,
  unavailable: 4,
  target: 5,
} as const;

export function detachedCuaTarget(
  runtimeReadinessDigest: string | null = null,
): CuaTargetAttachment {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-attachment",
    status: "detached",
    runtimeReadinessDigest,
    target: null,
    activeTask: null,
  };
}

function failure(
  operation: CuaTargetLifecycleOperation,
  family: CuaFailureFamily,
  retryable: boolean,
  component?: CuaCapability | "inference" | "policy" | "runtime" | "target",
): CuaFailure {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family,
    retryable,
    ...(component ? { component } : {}),
  };
}

function exitCodeFor(family: CuaFailureFamily): number {
  if (family === "validation_failed") return CUA_TARGET_EXIT_CODES.validation;
  if (family === "target_conflict" || family === "task_conflict") {
    return CUA_TARGET_EXIT_CODES.conflict;
  }
  if (family === "lifecycle_unavailable" || family === "runtime_unavailable") {
    return CUA_TARGET_EXIT_CODES.unavailable;
  }
  return CUA_TARGET_EXIT_CODES.target;
}

function result(record: CuaTargetAttachment | CuaFailure): CuaTargetLifecycleResult {
  return {
    record,
    exitCode:
      record.kind === "failure" ? exitCodeFor(record.family) : CUA_TARGET_EXIT_CODES.success,
  };
}

function failed(
  operation: CuaTargetLifecycleOperation,
  family: CuaFailureFamily,
  retryable: boolean,
  component?: CuaCapability | "inference" | "policy" | "runtime" | "target",
): CuaTargetLifecycleResult {
  return result(failure(operation, family, retryable, component));
}

function capabilityProtocols(
  target: NonNullable<CuaTargetAttachment["target"]>,
): Array<{ id: CuaCapability; protocolVersion: string }> {
  return target.capabilities
    .map(({ id, protocolVersion }) => ({ id, protocolVersion }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function manifestProtocols(
  manifest: CuaTargetManifest,
): Array<{ id: CuaCapability; protocolVersion: string }> {
  return [...manifest.capabilities].sort((left, right) => left.id.localeCompare(right.id));
}

function targetMatchesManifest(
  target: NonNullable<CuaTargetAttachment["target"]>,
  manifest: CuaTargetManifest,
): boolean {
  return (
    target.identityDigest === manifest.identityDigest &&
    target.platform === manifest.platform &&
    isDeepStrictEqual(target.image, manifest.image) &&
    isDeepStrictEqual(target.serviceBundle, manifest.serviceBundle) &&
    isDeepStrictEqual(capabilityProtocols(target), manifestProtocols(manifest))
  );
}

function targetComponentsMatch(
  observed: NonNullable<CuaTargetAttachment["target"]>,
  current: NonNullable<CuaTargetAttachment["target"]>,
): boolean {
  return (
    observed.platform === current.platform &&
    isDeepStrictEqual(observed.image, current.image) &&
    isDeepStrictEqual(observed.serviceBundle, current.serviceBundle) &&
    isDeepStrictEqual(capabilityProtocols(observed), capabilityProtocols(current))
  );
}

function targetMatchesRuntimeAuthority(
  target: Pick<NonNullable<CuaTargetAttachment["target"]>, "platform" | "image" | "serviceBundle">,
  authority: CuaRuntimeTargetAuthority,
): boolean {
  return (
    target.platform === authority.platform &&
    isDeepStrictEqual(target.image, authority.image) &&
    isDeepStrictEqual(target.serviceBundle, authority.serviceBundle)
  );
}

function firstUnhealthyCapability(
  target: NonNullable<CuaTargetAttachment["target"]>,
): CuaCapability | undefined {
  return target.capabilities.find((capability) => capability.health !== "healthy")?.id;
}

function persistFailureState(
  registry: SandboxRegistry,
  sandboxName: string,
  current: CuaTargetAttachment,
  failureRecord: CuaFailure,
): boolean {
  const status =
    failureRecord.family === "target_replaced"
      ? "replaced"
      : failureRecord.family === "target_incompatible"
        ? "incompatible"
        : failureRecord.family === "target_unreachable" ||
            failureRecord.family === "capability_unhealthy"
          ? "unreachable"
          : null;
  if (!status || !current.target) return false;
  const sandbox = registry.sandboxes[sandboxName];
  if (!sandbox) return false;
  sandbox.cuaTarget = { ...current, status };
  delete sandbox.cuaSecurityAttestation;
  delete sandbox.cuaTaskResults;
  return true;
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

function validateAdapterTarget(
  operation: CuaTargetAdapterOperation,
  adapterResult: CuaTargetAdapterResult,
  allowDetachedHealth = false,
): CuaTargetAttachment | CuaFailure {
  if (adapterResult.kind === "failure") return adapterResult;
  const expectsDetached = operation === "target.detach" || operation === "target.destroy";
  if (expectsDetached) {
    if (
      adapterResult.status !== "detached" ||
      adapterResult.target !== null ||
      adapterResult.activeTask !== null
    ) {
      return failure(operation, "validation_failed", false, "target");
    }
    return adapterResult;
  }
  if (
    adapterResult.target === null ||
    (operation !== "target.health" && adapterResult.status !== "attached") ||
    (operation === "target.health" &&
      adapterResult.status === "detached" &&
      !allowDetachedHealth) ||
    (operation === "target.attach" && adapterResult.activeTask !== null)
  ) {
    return failure(operation, "validation_failed", false, "target");
  }
  return adapterResult;
}

function invokeAdapter(
  input: CuaTargetLifecycleInput,
  current: CuaTargetAttachment,
): CuaTargetAdapterResult {
  if (input.operation === "target.status" || !input.adapter) {
    return failure(input.operation, "lifecycle_unavailable", false, "target");
  }
  try {
    const record = parseCuaLifecycleRecord(
      input.adapter.execute({
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "target-adapter-request",
        operation: input.operation,
        sandboxName: input.sandboxName,
        manifest: input.manifest ?? null,
        current,
      }),
    );
    if (record.kind !== "target-attachment" && record.kind !== "failure") {
      return failure(input.operation, "validation_failed", false, "target");
    }
    return record;
  } catch (error) {
    if (error instanceof CuaTargetAdapterInvocationError) {
      return failure(input.operation, error.family, error.retryable, "target");
    }
    return failure(input.operation, "lifecycle_unavailable", false, "target");
  }
}

function executeLocked(
  input: CuaTargetLifecycleInput,
  deps: CuaTargetLifecycleDeps,
): CuaTargetLifecycleResult {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }
  const registry = deps.load();
  const sandbox = registry.sandboxes[input.sandboxName];
  if (!sandbox) return failed(input.operation, "validation_failed", false, "target");
  const priorReconciliation = sandbox.cuaReconciliation
    ? structuredClone(sandbox.cuaReconciliation)
    : undefined;
  if (
    priorReconciliation &&
    !cuaReconciliationAllowsOperation(priorReconciliation, input.operation)
  ) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }

  const storedReadiness = sandbox.cuaRuntimeReadiness;
  if (!storedReadiness) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  }
  const reconciliationMode = priorReconciliation !== undefined;
  const storedReadinessDigest = getCuaRuntimeReadinessDigest(storedReadiness);
  if (
    reconciliationMode &&
    priorReconciliation.runtimeReadinessDigest !== null &&
    priorReconciliation.runtimeReadinessDigest !== storedReadinessDigest
  ) {
    return failed(input.operation, "runtime_unavailable", false, "runtime");
  }
  if (
    !reconciliationMode &&
    ((sandbox.provider !== undefined && sandbox.provider !== storedReadiness.inference.provider) ||
      (sandbox.model !== undefined && sandbox.model !== storedReadiness.inference.model))
  ) {
    quarantineCuaAuthority(sandbox, "inference-change");
    deps.save(registry);
    return failed(input.operation, "inference_unavailable", false, "inference");
  }

  let readiness = storedReadiness;
  if (!reconciliationMode) {
    try {
      readiness = (deps.requireRuntimeReadiness ?? requireCuaLifecycleReadiness)(sandbox, deps);
    } catch {
      quarantineCuaAuthority(sandbox, "readiness-change");
      deps.save(registry);
      return failed(input.operation, "runtime_unavailable", false, "runtime");
    }
  }
  if (readiness.status === "incompatible") {
    return failed(input.operation, "runtime_incompatible", false, "runtime");
  }
  if (readiness.status !== "available" && readiness.status !== "candidate") {
    return failed(input.operation, "runtime_unavailable", true, "runtime");
  }

  let targetAuthority: CuaRuntimeTargetAuthority | undefined;
  if (!reconciliationMode) {
    try {
      targetAuthority = (deps.getRuntimeTargetAuthority ?? getCuaTargetArtifactBindings)(
        deps.env ?? process.env,
      );
    } catch {
      quarantineCuaAuthority(sandbox, "runtime-authority-change");
      deps.save(registry);
      return failed(input.operation, "runtime_unavailable", false, "runtime");
    }
  }

  const runtimeReadinessDigest = getCuaRuntimeReadinessDigest(readiness);
  let current = sandbox.cuaTarget ?? detachedCuaTarget(runtimeReadinessDigest);
  let retainedAppliedPolicy: CuaAppliedPolicyIdentity | undefined;
  if (current.runtimeReadinessDigest !== runtimeReadinessDigest) {
    quarantineCuaAuthority(sandbox, "readiness-change");
    deps.save(registry);
    return failed(input.operation, "runtime_unavailable", false, "runtime");
  }
  if (
    !reconciliationMode &&
    current.target &&
    targetAuthority &&
    !targetMatchesRuntimeAuthority(current.target, targetAuthority)
  ) {
    quarantineCuaAuthority(sandbox, "runtime-authority-change");
    deps.save(registry);
    return failed(input.operation, "target_incompatible", false, "target");
  }
  if (
    !reconciliationMode &&
    current.target &&
    (current.activeTask !== null ||
      sandbox.cuaSecurityAttestation !== undefined ||
      sandbox.cuaTaskResults !== undefined)
  ) {
    let policyBoundStateMatches = false;
    try {
      const appliedPolicy = requireCuaLiveAppliedPolicy(sandbox, deps);
      policyBoundStateMatches =
        sandbox.cuaSecurityAttestation !== undefined &&
        cuaSecurityAttestationMatches(
          sandbox.cuaSecurityAttestation,
          readiness,
          current.target,
          appliedPolicy,
        ) &&
        (!current.activeTask ||
          isDeepStrictEqual(current.activeTask.appliedPolicy, appliedPolicy)) &&
        (sandbox.cuaTaskResults ?? []).every((entry) =>
          isDeepStrictEqual(entry.appliedPolicy, appliedPolicy),
        );
      if (policyBoundStateMatches) retainedAppliedPolicy = appliedPolicy;
    } catch {
      policyBoundStateMatches = false;
    }
    if (!policyBoundStateMatches) {
      clearPolicyBoundState(sandbox);
      quarantineCuaAuthority(sandbox, "policy-change");
      deps.save(registry);
      return failed(input.operation, "policy_invalid", false, "policy");
    }
  }
  if (!reconciliationMode && input.operation === "target.health" && !retainedAppliedPolicy) {
    try {
      retainedAppliedPolicy = requireCuaLiveAppliedPolicy(sandbox, deps);
    } catch {
      clearPolicyBoundState(sandbox);
      quarantineCuaAuthority(sandbox, "policy-change");
      deps.save(registry);
      return failed(input.operation, "policy_invalid", false, "policy");
    }
  }
  if (input.operation === "target.status") return result(current);

  if (!input.adapter) {
    return failed(input.operation, "lifecycle_unavailable", false, "target");
  }

  if (input.operation === "target.attach") {
    if (current.status !== "detached" || current.target !== null) {
      return failed(input.operation, "target_conflict", false, "target");
    }
    if (!input.manifest) return failed(input.operation, "validation_failed", false, "target");
    if (!targetAuthority || !targetMatchesRuntimeAuthority(input.manifest, targetAuthority)) {
      return failed(input.operation, "target_incompatible", false, "target");
    }
  } else if (current.status === "detached" || current.target === null) {
    if (
      priorReconciliation &&
      (input.operation === "target.health" || input.operation === "target.destroy")
    ) {
      // A timed-out attach can leave the durable local projection detached even
      // though the sandbox-scoped adapter created an external target. Probe and
      // clean that exact uncertainty instead of treating the local row as proof.
    } else {
      if (input.operation === "target.detach" || input.operation === "target.destroy") {
        if (sandbox.cuaSecurityAttestation || sandbox.cuaTaskResults) {
          delete sandbox.cuaSecurityAttestation;
          delete sandbox.cuaTaskResults;
          deps.save(registry);
        }
        return result(current);
      }
      return failed(input.operation, "target_unreachable", false, "target");
    }
  }

  if (
    current.activeTask &&
    (input.operation === "target.detach" || input.operation === "target.destroy")
  ) {
    return failed(input.operation, "task_conflict", false, "target");
  }

  if (isCuaReconciliationSideEffectOperation(input.operation)) {
    if (!sandbox.cuaTarget) sandbox.cuaTarget = structuredClone(current);
    beginCuaSideEffectReconciliation(sandbox, input.operation);
    deps.save(registry);
    if (!deps.checkpoint?.()) {
      return failed(input.operation, "runtime_unavailable", false, "runtime");
    }
  }

  const adapterResult = invokeAdapter(input, current);
  if (!reconciliationMode) {
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
      return failed(input.operation, "runtime_unavailable", false, "runtime");
    }
    if (input.operation === "target.health" && retainedAppliedPolicy) {
      try {
        assertCuaLiveAppliedPolicyUnchanged(sandbox, retainedAppliedPolicy, deps);
      } catch {
        clearPolicyBoundState(sandbox);
        quarantineCuaAuthority(sandbox, "policy-change");
        deps.save(registry);
        return failed(input.operation, "policy_invalid", false, "policy");
      }
    }
  }
  const checked = validateAdapterTarget(input.operation, adapterResult, reconciliationMode);
  if (checked.kind === "failure") {
    if (persistFailureState(registry, input.sandboxName, current, checked)) {
      deps.save(registry);
    }
    return result(checked);
  }
  if (checked.runtimeReadinessDigest !== runtimeReadinessDigest) {
    return failed(input.operation, "validation_failed", false, "runtime");
  }

  if (input.operation === "target.health" && checked.status === "detached") {
    recordCuaReconciliationObservation(sandbox, "target.health", checked);
    delete sandbox.cuaSecurityAttestation;
    delete sandbox.cuaTaskResults;
    deps.save(registry);
    return result(checked);
  }

  if (input.operation === "target.detach" || input.operation === "target.destroy") {
    sandbox.cuaTarget = detachedCuaTarget(runtimeReadinessDigest);
    delete sandbox.cuaSecurityAttestation;
    delete sandbox.cuaTaskResults;
    delete sandbox.cuaReconciliation;
    deps.save(registry);
    return result(sandbox.cuaTarget);
  }

  const observed = checked.target;
  if (!observed) return failed(input.operation, "validation_failed", false, "target");
  if (
    !reconciliationMode &&
    (!targetAuthority || !targetMatchesRuntimeAuthority(observed, targetAuthority))
  ) {
    if (input.operation !== "target.attach") {
      const incompatible = { ...checked, status: "incompatible" as const };
      if (input.operation === "target.health") {
        quarantineCuaAuthority(sandbox, "runtime-authority-change");
        recordCuaReconciliationObservation(
          sandbox,
          "target.health",
          incompatible,
          current.activeTask?.taskId ?? null,
        );
      }
      delete sandbox.cuaSecurityAttestation;
      delete sandbox.cuaTaskResults;
      deps.save(registry);
    }
    return failed(input.operation, "target_incompatible", false, "target");
  }

  if (input.operation === "target.attach") {
    if (!input.manifest || !targetMatchesManifest(observed, input.manifest)) {
      return failed(input.operation, "target_incompatible", false, "target");
    }
  } else if (current.target) {
    if (!targetComponentsMatch(observed, current.target)) {
      if (input.operation === "target.health") {
        const incompatible = { ...checked, status: "incompatible" as const };
        quarantineCuaAuthority(sandbox, "runtime-authority-change");
        recordCuaReconciliationObservation(
          sandbox,
          "target.health",
          incompatible,
          current.activeTask?.taskId ?? null,
        );
        delete sandbox.cuaSecurityAttestation;
        delete sandbox.cuaTaskResults;
        deps.save(registry);
      }
      return failed(input.operation, "target_incompatible", false, "target");
    }
    if (
      input.operation === "target.health" &&
      observed.identityDigest !== current.target.identityDigest
    ) {
      const replaced = { ...checked, status: "replaced" as const };
      quarantineCuaAuthority(sandbox, "runtime-authority-change");
      recordCuaReconciliationObservation(
        sandbox,
        "target.health",
        replaced,
        current.activeTask?.taskId ?? null,
      );
      delete sandbox.cuaSecurityAttestation;
      delete sandbox.cuaTaskResults;
      deps.save(registry);
      return failed(input.operation, "target_replaced", false, "target");
    }
  }

  const unhealthy = firstUnhealthyCapability(observed);
  if (unhealthy) {
    if (input.operation !== "target.attach") {
      const unreachable = { ...checked, status: "unreachable" as const };
      if (input.operation === "target.health") {
        if (priorReconciliation || unreachable.activeTask || current.activeTask) {
          recordCuaReconciliationObservation(
            sandbox,
            "target.health",
            unreachable,
            current.activeTask?.taskId ?? null,
          );
        } else {
          sandbox.cuaTarget = unreachable;
        }
      }
      delete sandbox.cuaSecurityAttestation;
      delete sandbox.cuaTaskResults;
      deps.save(registry);
    }
    return failed(input.operation, "capability_unhealthy", true, unhealthy);
  }

  const attached = { ...checked, status: "attached" as const };
  const observedTaskDiffers =
    input.operation === "target.health" &&
    (current.activeTask?.taskId !== attached.activeTask?.taskId ||
      (current.activeTask !== null &&
        attached.activeTask !== null &&
        !isDeepStrictEqual(current.activeTask.appliedPolicy, attached.activeTask.appliedPolicy)));
  sandbox.cuaTarget = attached;
  if (input.operation === "target.attach") {
    delete sandbox.cuaSecurityAttestation;
    delete sandbox.cuaTaskResults;
    delete sandbox.cuaReconciliation;
  } else if (input.operation === "target.health" && (priorReconciliation || observedTaskDiffers)) {
    recordCuaReconciliationObservation(
      sandbox,
      "target.health",
      sandbox.cuaTarget,
      current.activeTask?.taskId ?? null,
    );
  }
  deps.save(registry);
  return result(sandbox.cuaTarget);
}

export function executeCuaTargetLifecycle(
  input: CuaTargetLifecycleInput,
  deps: CuaTargetLifecycleDeps = defaultDeps,
): CuaTargetLifecycleResult {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return failed(input.operation, "lifecycle_unavailable", false, "runtime");
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
    conflict: () => failed(input.operation, "runtime_unavailable", false, "runtime"),
  });
}

export function readCuaTargetManifest(filePath: string): CuaTargetManifest {
  const contents = readBoundedRegularFile(filePath, {
    label: "CUA target manifest",
    minBytes: 1,
    maxBytes: MAX_TARGET_MANIFEST_BYTES,
  });
  return parseCuaTargetManifest(JSON.parse(contents.toString("utf8")));
}
