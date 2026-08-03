// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import {
  type CuaTaskMode,
  type CuaTaskOperation,
  ProcessCuaTaskAdapter,
} from "../adapters/cua-task";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaFailure,
  type CuaTargetAttachment,
  type CuaTaskEvidenceIndex,
  type CuaTaskResult,
} from "./contract";
import {
  CUA_TASK_EXIT_CODES,
  type CuaTaskLifecycleResult,
  executeCuaTaskLifecycle,
} from "./task-lifecycle";

const MAX_TASK_INPUT_BYTES = 64 * 1024;

export interface CuaTaskCommandInput {
  operation: CuaTaskOperation;
  sandboxName: string;
  taskId: string;
  adapterPath?: string;
  mode?: CuaTaskMode;
  inputPath?: string;
}

function validationFailure(operation: CuaTaskOperation): CuaTaskLifecycleResult {
  const record: CuaFailure = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "failure",
    operation,
    family: "validation_failed",
    retryable: false,
  };
  return { record, exitCode: CUA_TASK_EXIT_CODES.validation };
}

function readPrivateTaskInput(filePath: string): string {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TASK_INPUT_BYTES) {
      throw new Error("CUA task input must be a non-empty file no larger than 64 KiB");
    }
    const contents = fs.readFileSync(descriptor);
    if (contents.byteLength === 0 || contents.byteLength > MAX_TASK_INPUT_BYTES) {
      throw new Error("CUA task input must be a non-empty file no larger than 64 KiB");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function executeCuaTaskCommand(input: CuaTaskCommandInput): CuaTaskLifecycleResult {
  let privateInput;
  try {
    privateInput = input.inputPath ? readPrivateTaskInput(input.inputPath) : undefined;
  } catch {
    return validationFailure(input.operation);
  }
  const adapter = input.adapterPath ? new ProcessCuaTaskAdapter(input.adapterPath) : undefined;
  return executeCuaTaskLifecycle({
    operation: input.operation,
    sandboxName: input.sandboxName,
    taskId: input.taskId,
    ...(adapter ? { adapter } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(privateInput ? { input: privateInput } : {}),
  });
}

export interface RenderedCuaTaskResult {
  exitCode: number;
  output?: CuaTargetAttachment | CuaTaskEvidenceIndex | CuaTaskResult | CuaFailure;
  message?: string;
  error?: string;
}

function successMessage(
  operation: CuaTaskOperation,
  record: CuaTargetAttachment | CuaTaskEvidenceIndex | CuaTaskResult,
): string {
  if (record.kind === "task-result") {
    return `CUA task ${record.taskId}: ${record.status}`;
  }
  if (record.kind === "task-evidence-index") {
    return `CUA task ${record.taskId} ${record.category}: ${String(record.evidence.length)} private evidence reference(s)`;
  }
  const task = record.activeTask;
  return `CUA ${operation.replace(".", " ")}: ${task?.taskId ?? "unknown"} ${task?.status ?? "unknown"}`;
}

export function renderCuaTaskResult(
  operation: CuaTaskOperation,
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
