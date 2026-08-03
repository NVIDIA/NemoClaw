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
  type CuaCapability,
  type CuaFailure,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
} from "./contract";
import { parseCuaSecurityAttestation } from "./schema";

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

export interface CuaSecurityLifecycleDeps {
  load: () => SandboxRegistry;
  save: (registry: SandboxRegistry) => void;
  withLock: <T>(fn: () => T) => T;
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
    | "target_unreachable"
    | "policy_invalid",
  retryable: boolean,
  component: "runtime" | "policy" | "target",
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
        : record.family === "lifecycle_unavailable" || record.family === "runtime_unavailable"
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
  if (input.operation === "security.verify" && sandbox?.cuaSecurityAttestation) {
    delete sandbox.cuaSecurityAttestation;
    deps.save(registry);
  }
  return result(record);
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
): boolean {
  return (
    attestation.status === "enforced" &&
    attestation.bindings.targetIdentityDigest === target.identityDigest &&
    isDeepStrictEqual(attestation.bindings.components, expectedComponents(runtime, target)) &&
    isDeepStrictEqual(attestation.bindings.inference, runtime.inference) &&
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
): CuaSecurityAttestation | CuaFailure {
  if (!input.adapter) {
    return failure(input.operation, "lifecycle_unavailable", false, "policy");
  }
  try {
    return input.adapter.execute({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "security-adapter-request",
      operation: "security.verify",
      sandboxName: input.sandboxName,
      runtime,
      target,
    });
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
  const registry = deps.load();
  const sandbox = registry.sandboxes[input.sandboxName];
  if (!sandbox) {
    return result(failure(input.operation, "validation_failed", false, "target"));
  }

  const runtime = sandbox.cuaRuntimeReadiness;
  if (!runtime) {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "lifecycle_unavailable", false, "runtime"),
    );
  }
  if (runtime.status === "incompatible") {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "runtime_incompatible", false, "runtime"),
    );
  }
  if (runtime.status !== "available") {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "runtime_unavailable", true, "runtime"),
    );
  }

  const target = sandbox.cuaTarget;
  if (!target?.target || target.status !== "attached") {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "target_unreachable", true, "target"),
    );
  }

  if (input.operation === "security.status") {
    const current = sandbox.cuaSecurityAttestation;
    if (!current || !cuaSecurityAttestationMatches(current, runtime, target.target)) {
      return result(failure(input.operation, "policy_invalid", false, "policy"));
    }
    return result(current);
  }

  const adapterResult = invokeAdapter(input, runtime, target);
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
  if (!cuaSecurityAttestationMatches(attestation, runtime, target.target)) {
    return failClosed(
      input,
      registry,
      deps,
      failure(input.operation, "policy_invalid", false, "policy"),
    );
  }

  sandbox.cuaSecurityAttestation = structuredClone(attestation);
  deps.save(registry);
  return result(sandbox.cuaSecurityAttestation);
}

export function executeCuaSecurityLifecycle(
  input: CuaSecurityLifecycleInput,
  deps: CuaSecurityLifecycleDeps = defaultDeps,
): CuaSecurityLifecycleResult {
  return deps.withLock(() => executeLocked(input, deps));
}
