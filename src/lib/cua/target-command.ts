// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ProcessCuaTargetAdapter } from "../adapters/cua-target";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaFailure,
  type CuaTargetAttachment,
} from "./contract";
import {
  CUA_TARGET_EXIT_CODES,
  type CuaTargetLifecycleOperation,
  type CuaTargetLifecycleResult,
  executeCuaTargetLifecycle,
  readCuaTargetManifest,
} from "./target-lifecycle";

export interface CuaTargetCommandInput {
  operation: CuaTargetLifecycleOperation;
  sandboxName: string;
  adapterPath?: string;
  manifestPath?: string;
}

function validationFailure(operation: CuaTargetLifecycleOperation): CuaTargetLifecycleResult {
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

export function executeCuaTargetCommand(input: CuaTargetCommandInput): CuaTargetLifecycleResult {
  let manifest;
  try {
    manifest = input.manifestPath ? readCuaTargetManifest(input.manifestPath) : undefined;
  } catch {
    return validationFailure(input.operation);
  }
  const adapter = input.adapterPath ? new ProcessCuaTargetAdapter(input.adapterPath) : undefined;
  return executeCuaTargetLifecycle({
    operation: input.operation,
    sandboxName: input.sandboxName,
    ...(adapter ? { adapter } : {}),
    ...(manifest ? { manifest } : {}),
  });
}

function successMessage(
  operation: CuaTargetLifecycleOperation,
  record: CuaTargetAttachment,
): string {
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
  operation: CuaTargetLifecycleOperation,
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
