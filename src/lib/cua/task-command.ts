// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import {
  type CuaTaskMode,
  type CuaTaskOperation,
  ProcessCuaTaskAdapter,
} from "../adapters/cua-task";
import { readBoundedRegularFile } from "./bounded-file";
import { type CuaCommandRouteLockDeps, withCuaCommandRouteLock } from "./command-route-lock";
import {
  CUA_DEFERRED_TASK_OPERATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_TASK_OPERATIONS,
  type CuaFailure,
  type CuaTargetAttachment,
  type CuaTaskResult,
} from "./contract";
import { isCuaFrameworkEnabled } from "./feature";
import { resolveCuaQualificationArtifactRunner } from "./qualification-artifact-runner";
import { getCuaReconciliationAdapterDigest } from "./reconciliation";
import { getCuaAdapterBindings } from "./runtime-manifest";
import {
  CUA_TASK_EXIT_CODES,
  type CuaTaskLifecycleInput,
  type CuaTaskLifecycleResult,
  executeCuaTaskLifecycle,
} from "./task-lifecycle";

export type CuaTaskCommandOperation =
  | CuaTaskOperation
  | (typeof CUA_DEFERRED_TASK_OPERATIONS)[number];

const MAX_TASK_INPUT_BYTES = 64 * 1024;

export interface CuaTaskCommandInput {
  operation: CuaTaskCommandOperation;
  sandboxName: string;
  taskId: string;
  adapterPath?: string;
  mode?: CuaTaskMode;
  inputPath?: string;
}

function validationFailure(operation: CuaTaskCommandOperation): CuaTaskLifecycleResult {
  const record: CuaFailure = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family: "validation_failed",
    retryable: false,
  };
  return { record, exitCode: CUA_TASK_EXIT_CODES.validation };
}

function runtimeFailure(operation: CuaTaskCommandOperation): CuaTaskLifecycleResult {
  const record: CuaFailure = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family: "runtime_unavailable",
    retryable: false,
    component: "runtime",
  };
  return { record, exitCode: CUA_TASK_EXIT_CODES.unavailable };
}

function lifecycleFailure(operation: CuaTaskCommandOperation): CuaTaskLifecycleResult {
  const record: CuaFailure = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family: "lifecycle_unavailable",
    retryable: false,
    component: "runtime",
  };
  return { record, exitCode: CUA_TASK_EXIT_CODES.unavailable };
}

export interface CuaTaskCommandDeps extends CuaCommandRouteLockDeps {
  isFrameworkEnabled?: typeof isCuaFrameworkEnabled;
  readPrivateInput?: typeof readPrivateTaskInput;
  getAdapterBindings?: typeof getCuaAdapterBindings;
  resolveQualificationArtifactRunner?: typeof resolveCuaQualificationArtifactRunner;
  executeLifecycle?: (
    input: CuaTaskLifecycleInput,
  ) => CuaTaskLifecycleResult | Promise<CuaTaskLifecycleResult>;
}

function readPrivateTaskInput(filePath: string): string {
  const contents = readBoundedRegularFile(filePath, {
    label: "CUA task input",
    minBytes: 1,
    maxBytes: MAX_TASK_INPUT_BYTES,
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(contents);
}

export async function executeCuaTaskCommand(
  input: CuaTaskCommandInput,
  deps: CuaTaskCommandDeps = {},
): Promise<CuaTaskLifecycleResult> {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return lifecycleFailure(input.operation);
  }
  if (!(CUA_TASK_OPERATIONS as readonly string[]).includes(input.operation)) {
    return lifecycleFailure(input.operation);
  }
  const operation = input.operation as CuaTaskOperation;
  let privateInput;
  try {
    privateInput = input.inputPath
      ? (deps.readPrivateInput ?? readPrivateTaskInput)(input.inputPath)
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
        let adapter: ProcessCuaTaskAdapter | undefined;
        if (input.adapterPath) {
          try {
            let executable = input.adapterPath;
            let expectedDigest: string;
            if (entry?.cuaReconciliation) {
              const retainedDigest = getCuaReconciliationAdapterDigest(entry, "task");
              if (!retainedDigest) return runtimeFailure(operation);
              expectedDigest = retainedDigest;
            } else {
              const binding = (deps.getAdapterBindings ?? getCuaAdapterBindings)().task;
              if (input.adapterPath !== binding.path) return validationFailure(operation);
              executable = binding.path;
              expectedDigest = binding.digest;
            }
            const qualificationArtifactRunner = (
              deps.resolveQualificationArtifactRunner ?? resolveCuaQualificationArtifactRunner
            )();
            adapter = new ProcessCuaTaskAdapter(executable, {
              expectedDigest,
              ...(qualificationArtifactRunner ? { qualificationArtifactRunner } : {}),
            });
          } catch {
            return runtimeFailure(operation);
          }
        }
        return await (deps.executeLifecycle ?? executeCuaTaskLifecycle)({
          operation,
          sandboxName: input.sandboxName,
          taskId: input.taskId,
          ...(adapter ? { adapter } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          ...(privateInput ? { input: privateInput } : {}),
        });
      },
      deps,
    );
  } catch {
    return runtimeFailure(operation);
  }
}

export interface RenderedCuaTaskResult {
  exitCode: number;
  output?: CuaTargetAttachment | CuaTaskResult | CuaFailure;
  message?: string;
  error?: string;
}

function successMessage(
  operation: CuaTaskCommandOperation,
  record: CuaTargetAttachment | CuaTaskResult,
): string {
  if (record.kind === "task-result") {
    return `CUA task ${record.taskId}: ${record.status}`;
  }
  const task = record.activeTask;
  return `CUA ${operation.replace(".", " ")}: ${task?.taskId ?? "unknown"} ${task?.status ?? "unknown"}`;
}

export function renderCuaTaskResult(
  operation: CuaTaskCommandOperation,
  lifecycleResult: CuaTaskLifecycleResult,
  jsonEnabled: boolean,
): RenderedCuaTaskResult {
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
