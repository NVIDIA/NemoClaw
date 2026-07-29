// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
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
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaCapability,
  type CuaFailure,
  type CuaFailureFamily,
  type CuaTargetAttachment,
} from "./contract";
import { type CuaTargetManifest, parseCuaTargetManifest } from "./schema";

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

export interface CuaTargetLifecycleDeps {
  load: () => SandboxRegistry;
  save: (registry: SandboxRegistry) => void;
  withLock: <T>(fn: () => T) => T;
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

export function detachedCuaTarget(): CuaTargetAttachment {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-attachment",
    status: "detached",
    target: null,
    activeTask: null,
  };
}

function failure(
  operation: CuaTargetLifecycleOperation,
  family: CuaFailureFamily,
  retryable: boolean,
  component?: CuaCapability | "runtime" | "target",
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
  component?: CuaCapability | "runtime" | "target",
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
  return true;
}

function validateAdapterTarget(
  operation: CuaTargetAdapterOperation,
  adapterResult: CuaTargetAdapterResult,
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
    (operation === "target.health" && adapterResult.status === "detached")
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
    return input.adapter.execute({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "target-adapter-request",
      operation: input.operation,
      sandboxName: input.sandboxName,
      manifest: input.manifest ?? null,
      current,
    });
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
  const registry = deps.load();
  const sandbox = registry.sandboxes[input.sandboxName];
  if (!sandbox) return failed(input.operation, "validation_failed", false, "target");

  const readiness = sandbox.cuaRuntimeReadiness;
  if (!readiness) return failed(input.operation, "lifecycle_unavailable", false, "runtime");
  if (readiness.status === "incompatible") {
    return failed(input.operation, "runtime_incompatible", false, "runtime");
  }
  if (readiness.status !== "available") {
    return failed(input.operation, "runtime_unavailable", true, "runtime");
  }

  const current = sandbox.cuaTarget ?? detachedCuaTarget();
  if (input.operation === "target.status") return result(current);

  if (!input.adapter) {
    return failed(input.operation, "lifecycle_unavailable", false, "target");
  }

  if (input.operation === "target.attach") {
    if (current.status !== "detached" || current.target !== null) {
      return failed(input.operation, "target_conflict", false, "target");
    }
    if (!input.manifest) return failed(input.operation, "validation_failed", false, "target");
  } else if (current.status === "detached" || current.target === null) {
    if (input.operation === "target.detach" || input.operation === "target.destroy") {
      if (sandbox.cuaSecurityAttestation) {
        delete sandbox.cuaSecurityAttestation;
        deps.save(registry);
      }
      return result(current);
    }
    return failed(input.operation, "target_unreachable", false, "target");
  }

  if (
    current.activeTask &&
    (input.operation === "target.reset" ||
      input.operation === "target.detach" ||
      input.operation === "target.destroy")
  ) {
    return failed(input.operation, "task_conflict", false, "target");
  }

  const checked = validateAdapterTarget(input.operation, invokeAdapter(input, current));
  if (checked.kind === "failure") {
    if (persistFailureState(registry, input.sandboxName, current, checked)) {
      deps.save(registry);
    }
    return result(checked);
  }

  if (input.operation === "target.detach" || input.operation === "target.destroy") {
    sandbox.cuaTarget = detachedCuaTarget();
    delete sandbox.cuaSecurityAttestation;
    deps.save(registry);
    return result(sandbox.cuaTarget);
  }

  const observed = checked.target;
  if (!observed) return failed(input.operation, "validation_failed", false, "target");

  if (input.operation === "target.attach") {
    if (!input.manifest || !targetMatchesManifest(observed, input.manifest)) {
      return failed(input.operation, "target_incompatible", false, "target");
    }
  } else if (current.target) {
    if (!targetComponentsMatch(observed, current.target)) {
      sandbox.cuaTarget = { ...current, status: "incompatible" };
      delete sandbox.cuaSecurityAttestation;
      deps.save(registry);
      return failed(input.operation, "target_incompatible", false, "target");
    }
    if (
      input.operation === "target.health" &&
      observed.identityDigest !== current.target.identityDigest
    ) {
      sandbox.cuaTarget = { ...current, status: "replaced" };
      delete sandbox.cuaSecurityAttestation;
      deps.save(registry);
      return failed(input.operation, "target_replaced", false, "target");
    }
  }

  const unhealthy = firstUnhealthyCapability(observed);
  if (unhealthy) {
    if (input.operation !== "target.attach") {
      sandbox.cuaTarget = {
        ...current,
        status: "unreachable",
        target: observed,
      };
      delete sandbox.cuaSecurityAttestation;
      deps.save(registry);
    }
    return failed(input.operation, "capability_unhealthy", true, unhealthy);
  }

  sandbox.cuaTarget = {
    ...checked,
    status: "attached",
    activeTask: current.activeTask,
  };
  if (input.operation === "target.attach" || input.operation === "target.reset") {
    delete sandbox.cuaSecurityAttestation;
  }
  deps.save(registry);
  return result(sandbox.cuaTarget);
}

export function executeCuaTargetLifecycle(
  input: CuaTargetLifecycleInput,
  deps: CuaTargetLifecycleDeps = defaultDeps,
): CuaTargetLifecycleResult {
  return deps.withLock(() => executeLocked(input, deps));
}

export function readCuaTargetManifest(filePath: string): CuaTargetManifest {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_TARGET_MANIFEST_BYTES) {
      throw new Error("CUA target manifest must be a JSON file no larger than 64 KiB");
    }
    const contents = fs.readFileSync(descriptor);
    if (contents.byteLength > MAX_TARGET_MANIFEST_BYTES) {
      throw new Error("CUA target manifest must be a JSON file no larger than 64 KiB");
    }
    return parseCuaTargetManifest(JSON.parse(contents.toString("utf8")));
  } finally {
    fs.closeSync(descriptor);
  }
}
