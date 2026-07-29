// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CUA_TASK_OPERATIONS,
  type CuaFailure,
  type CuaFailureFamily,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
  type CuaTaskEvidenceIndex,
  type CuaTaskResult,
} from "../cua/contract";
import { parseCuaLifecycleRecord } from "../cua/schema";

export type CuaTaskOperation = (typeof CUA_TASK_OPERATIONS)[number];
export type CuaTaskMode = "interactive" | "headless";

export interface CuaTaskAdapterRequest {
  schemaVersion: typeof CUA_LIFECYCLE_SCHEMA_VERSION;
  kind: "task-adapter-request";
  operation: CuaTaskOperation;
  sandboxName: string;
  taskId: string;
  mode: CuaTaskMode | null;
  input: string | null;
  runtime: CuaRuntimeReadiness;
  target: CuaTargetAttachment;
}

export type CuaTaskAdapterResult =
  | CuaTargetAttachment
  | CuaTaskEvidenceIndex
  | CuaTaskResult
  | CuaFailure;

export interface CuaTaskAdapter {
  execute(request: CuaTaskAdapterRequest): CuaTaskAdapterResult;
}

export class CuaTaskAdapterInvocationError extends Error {
  constructor(
    message: string,
    readonly family: CuaFailureFamily,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CuaTaskAdapterInvocationError";
  }
}

export interface ProcessCuaTaskAdapterOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const ADAPTER_ENV_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
] as const;

function adapterEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ADAPTER_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function validateExecutable(executable: string): void {
  if (!path.isAbsolute(executable)) {
    throw new CuaTaskAdapterInvocationError(
      "the CUA task adapter path must be absolute",
      "validation_failed",
      false,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(executable);
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    throw new CuaTaskAdapterInvocationError(
      "the CUA task adapter is unavailable",
      "lifecycle_unavailable",
      false,
    );
  }
  if (!stat.isFile()) {
    throw new CuaTaskAdapterInvocationError(
      "the CUA task adapter is unavailable",
      "lifecycle_unavailable",
      false,
    );
  }
}

function parseAdapterResult(
  stdout: string,
  operation: CuaTaskOperation,
  processStatus: number | null,
): CuaTaskAdapterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CuaTaskAdapterInvocationError(
      "the CUA task adapter returned invalid JSON",
      "validation_failed",
      false,
    );
  }
  let record;
  try {
    record = parseCuaLifecycleRecord(parsed);
  } catch {
    throw new CuaTaskAdapterInvocationError(
      "the CUA task adapter returned an invalid lifecycle record",
      "validation_failed",
      false,
    );
  }
  if (
    record.kind !== "target-attachment" &&
    record.kind !== "task-evidence-index" &&
    record.kind !== "task-result" &&
    record.kind !== "failure"
  ) {
    throw new CuaTaskAdapterInvocationError(
      "the CUA task adapter returned an unsupported record",
      "validation_failed",
      false,
    );
  }
  if (record.kind === "failure") {
    if (record.operation !== operation) {
      throw new CuaTaskAdapterInvocationError(
        "the CUA task adapter returned a failure for another operation",
        "validation_failed",
        false,
      );
    }
    return record;
  }
  if (processStatus !== 0) {
    throw new CuaTaskAdapterInvocationError(
      "the CUA task adapter exited unsuccessfully without a failure record",
      "runtime_unavailable",
      true,
    );
  }
  return record;
}

/**
 * Invoke the explicit CUA task protocol adapter without a shell.
 *
 * Task input is private, bounded command input. It is sent only to the adapter
 * on stdin and never enters lifecycle output or canonical registry state.
 */
export class ProcessCuaTaskAdapter implements CuaTaskAdapter {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;

  constructor(
    readonly executable: string,
    options: ProcessCuaTaskAdapterOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  execute(request: CuaTaskAdapterRequest): CuaTaskAdapterResult {
    validateExecutable(this.executable);
    const result = spawnSync(this.executable, [], {
      encoding: "utf8",
      input: `${JSON.stringify(request)}\n`,
      maxBuffer: this.maxOutputBytes,
      env: adapterEnvironment(),
      shell: false,
      timeout: this.timeoutMs,
      windowsHide: true,
    });
    if (result.error) {
      const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      throw new CuaTaskAdapterInvocationError(
        timedOut ? "the CUA task adapter timed out" : "the CUA task adapter failed",
        timedOut ? "task_timeout" : "runtime_unavailable",
        timedOut,
      );
    }
    return parseAdapterResult(result.stdout, request.operation, result.status);
  }
}
