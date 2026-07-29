// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaFailure,
  type CuaFailureFamily,
  type CuaTargetAttachment,
} from "../cua/contract";
import { type CuaTargetManifest, parseCuaLifecycleRecord } from "../cua/schema";

export type CuaTargetAdapterOperation =
  | "target.attach"
  | "target.health"
  | "target.detach"
  | "target.reset"
  | "target.destroy";

export interface CuaTargetAdapterRequest {
  schemaVersion: typeof CUA_LIFECYCLE_SCHEMA_VERSION;
  kind: "target-adapter-request";
  operation: CuaTargetAdapterOperation;
  sandboxName: string;
  manifest: CuaTargetManifest | null;
  current: CuaTargetAttachment;
}

export type CuaTargetAdapterResult = CuaTargetAttachment | CuaFailure;

export interface CuaTargetAdapter {
  execute(request: CuaTargetAdapterRequest): CuaTargetAdapterResult;
}

export class CuaTargetAdapterInvocationError extends Error {
  constructor(
    message: string,
    readonly family: CuaFailureFamily,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CuaTargetAdapterInvocationError";
  }
}

export interface ProcessCuaTargetAdapterOptions {
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
    throw new CuaTargetAdapterInvocationError(
      "the CUA target adapter path must be absolute",
      "validation_failed",
      false,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(executable);
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    throw new CuaTargetAdapterInvocationError(
      "the CUA target adapter is unavailable",
      "lifecycle_unavailable",
      false,
    );
  }
  if (!stat.isFile()) {
    throw new CuaTargetAdapterInvocationError(
      "the CUA target adapter is unavailable",
      "lifecycle_unavailable",
      false,
    );
  }
}

function parseAdapterResult(
  stdout: string,
  operation: CuaTargetAdapterOperation,
  processStatus: number | null,
): CuaTargetAdapterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CuaTargetAdapterInvocationError(
      "the CUA target adapter returned invalid JSON",
      "validation_failed",
      false,
    );
  }
  let record;
  try {
    record = parseCuaLifecycleRecord(parsed);
  } catch {
    throw new CuaTargetAdapterInvocationError(
      "the CUA target adapter returned an invalid lifecycle record",
      "validation_failed",
      false,
    );
  }
  if (record.kind !== "target-attachment" && record.kind !== "failure") {
    throw new CuaTargetAdapterInvocationError(
      "the CUA target adapter returned an unsupported record",
      "validation_failed",
      false,
    );
  }
  if (record.kind === "failure") {
    if (record.operation !== operation) {
      throw new CuaTargetAdapterInvocationError(
        "the CUA target adapter returned a failure for another operation",
        "validation_failed",
        false,
      );
    }
    return record;
  }
  if (processStatus !== 0) {
    throw new CuaTargetAdapterInvocationError(
      "the CUA target adapter exited unsuccessfully without a failure record",
      "target_unreachable",
      true,
    );
  }
  return record;
}

/**
 * Invoke one explicit CUA target adapter without a shell.
 *
 * The adapter receives target requests on stdin and returns only checked-in
 * lifecycle records on stdout. Adapter stderr is never copied into public
 * output because it can contain target-private diagnostics.
 */
export class ProcessCuaTargetAdapter implements CuaTargetAdapter {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;

  constructor(
    readonly executable: string,
    options: ProcessCuaTargetAdapterOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  execute(request: CuaTargetAdapterRequest): CuaTargetAdapterResult {
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
      throw new CuaTargetAdapterInvocationError(
        timedOut ? "the CUA target adapter timed out" : "the CUA target adapter failed",
        timedOut ? "target_unreachable" : "lifecycle_unavailable",
        timedOut,
      );
    }
    return parseAdapterResult(result.stdout, request.operation, result.status);
  }
}
