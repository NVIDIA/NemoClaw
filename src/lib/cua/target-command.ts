// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { ProcessCuaTargetAdapter } from "../adapters/cua-target";
import { type CuaCommandRouteLockDeps, withCuaCommandRouteLock } from "./command-route-lock";
import {
  CUA_DEFERRED_TARGET_OPERATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_TARGET_OPERATIONS,
  type CuaFailure,
  type CuaTargetAttachment,
} from "./contract";
import { isCuaFrameworkEnabled } from "./feature";
import { resolveCuaQualificationArtifactRunner } from "./qualification-artifact-runner";
import { getCuaReconciliationAdapterDigest } from "./reconciliation";
import { getCuaAdapterBindings } from "./runtime-manifest";
import {
  CUA_TARGET_EXIT_CODES,
  type CuaTargetLifecycleInput,
  type CuaTargetLifecycleOperation,
  type CuaTargetLifecycleResult,
  executeCuaTargetLifecycle,
  readCuaTargetManifest,
} from "./target-lifecycle";

export type CuaTargetCommandOperation =
  | CuaTargetLifecycleOperation
  | (typeof CUA_DEFERRED_TARGET_OPERATIONS)[number];

export interface CuaTargetCommandInput {
  operation: CuaTargetCommandOperation;
  sandboxName: string;
  adapterPath?: string;
  manifestPath?: string;
}

function validationFailure(operation: CuaTargetCommandOperation): CuaTargetLifecycleResult {
  const record: CuaFailure = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family: "validation_failed",
    retryable: false,
    component: "target",
  };
  return { record, exitCode: CUA_TARGET_EXIT_CODES.validation };
}

function runtimeFailure(operation: CuaTargetCommandOperation): CuaTargetLifecycleResult {
  const record: CuaFailure = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family: "runtime_unavailable",
    retryable: false,
    component: "runtime",
  };
  return { record, exitCode: CUA_TARGET_EXIT_CODES.unavailable };
}

function lifecycleFailure(operation: CuaTargetCommandOperation): CuaTargetLifecycleResult {
  const record: CuaFailure = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family: "lifecycle_unavailable",
    retryable: false,
    component: "runtime",
  };
  return { record, exitCode: CUA_TARGET_EXIT_CODES.unavailable };
}

export interface CuaTargetCommandDeps extends CuaCommandRouteLockDeps {
  isFrameworkEnabled?: typeof isCuaFrameworkEnabled;
  readManifest?: typeof readCuaTargetManifest;
  getAdapterBindings?: typeof getCuaAdapterBindings;
  resolveQualificationArtifactRunner?: typeof resolveCuaQualificationArtifactRunner;
  executeLifecycle?: (
    input: CuaTargetLifecycleInput,
  ) => CuaTargetLifecycleResult | Promise<CuaTargetLifecycleResult>;
}

export async function executeCuaTargetCommand(
  input: CuaTargetCommandInput,
  deps: CuaTargetCommandDeps = {},
): Promise<CuaTargetLifecycleResult> {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return lifecycleFailure(input.operation);
  }
  if (!(CUA_TARGET_OPERATIONS as readonly string[]).includes(input.operation)) {
    return lifecycleFailure(input.operation);
  }
  const operation = input.operation as CuaTargetLifecycleOperation;
  let manifest;
  try {
    manifest = input.manifestPath
      ? (deps.readManifest ?? readCuaTargetManifest)(input.manifestPath)
      : undefined;
  } catch {
    return validationFailure(input.operation);
  }
  if (
    input.adapterPath &&
    (!path.isAbsolute(input.adapterPath) || path.normalize(input.adapterPath) !== input.adapterPath)
  ) {
    return validationFailure(input.operation);
  }
  try {
    return await withCuaCommandRouteLock(
      input.sandboxName,
      async (entry) => {
        let adapter: ProcessCuaTargetAdapter | undefined;
        if (input.adapterPath) {
          try {
            let executable = input.adapterPath;
            let expectedDigest: string;
            if (entry?.cuaReconciliation) {
              const retainedDigest = getCuaReconciliationAdapterDigest(entry, "target");
              if (!retainedDigest) return runtimeFailure(operation);
              expectedDigest = retainedDigest;
            } else {
              const binding = (deps.getAdapterBindings ?? getCuaAdapterBindings)().target;
              if (input.adapterPath !== binding.path) return validationFailure(operation);
              executable = binding.path;
              expectedDigest = binding.digest;
            }
            const qualificationArtifactRunner = (
              deps.resolveQualificationArtifactRunner ?? resolveCuaQualificationArtifactRunner
            )();
            adapter = new ProcessCuaTargetAdapter(executable, {
              expectedDigest,
              ...(qualificationArtifactRunner ? { qualificationArtifactRunner } : {}),
            });
          } catch {
            return runtimeFailure(operation);
          }
        }
        return await (deps.executeLifecycle ?? executeCuaTargetLifecycle)({
          operation,
          sandboxName: input.sandboxName,
          ...(adapter ? { adapter } : {}),
          ...(manifest ? { manifest } : {}),
        });
      },
      deps,
    );
  } catch {
    return runtimeFailure(operation);
  }
}

function successMessage(operation: CuaTargetCommandOperation, record: CuaTargetAttachment): string {
  const action = operation.slice("target.".length);
  if (record.status === "detached") return `CUA target ${action}: detached`;
  return `CUA target ${action}: ${record.status} (${record.target?.identityDigest ?? "unknown"})`;
}

export interface RenderedCuaTargetResult {
  exitCode: number;
  output?: CuaTargetAttachment | CuaFailure;
  message?: string;
  error?: string;
}

export function renderCuaTargetResult(
  operation: CuaTargetCommandOperation,
  lifecycleResult: CuaTargetLifecycleResult,
  jsonEnabled: boolean,
): RenderedCuaTargetResult {
  if (jsonEnabled) {
    return { exitCode: lifecycleResult.exitCode, output: lifecycleResult.record };
  }
  if (lifecycleResult.record.kind === "failure") {
    return {
      exitCode: lifecycleResult.exitCode,
      error: `CUA ${operation.replace(".", " ")} failed: ${lifecycleResult.record.family}`,
    };
  }
  return {
    exitCode: lifecycleResult.exitCode,
    message: successMessage(operation, lifecycleResult.record),
  };
}
