// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertNoOpenShellGatewayEndpointOverride,
  type OpenShellGatewayEndpointEnvironment,
} from "../../openshell-gateway-endpoint-guard";
import type { CaptureOpenshellBinaryResult } from "./client";
import { captureOpenshellBinary } from "./runtime";

export interface SandboxExecRequest {
  sandboxName: string;
  command: readonly string[];
  /** Optional bytes supplied to the remote command's standard input. */
  stdin?: string | Buffer;
  /** Maximum combined raw stdout and stderr bytes retained before UTF-8 decoding. */
  maxOutputBytes?: number;
  /** End-to-end lookup and execution deadline. Zero means no deadline. */
  timeoutMs?: number;
  /** Preserve stdout bytes instead of decoding them as UTF-8. */
  stdoutEncoding?: "utf8" | "buffer";
}

export interface SandboxExecResult {
  status: number | null;
  stdout: string;
  /** Present when stdoutEncoding is `buffer`; stdout remains an empty string. */
  stdoutBytes?: Buffer;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

export interface OpenShellSandboxControl {
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
}

export type OpenShellExecRequestValidationIssue =
  | { kind: "empty-command" }
  | { kind: "too-many-arguments"; actual: number; max: number }
  | {
      kind: "assembled-command-too-large";
      actualBytes: number;
      maxBytes: number;
    }
  | { kind: "encoded-request-too-large"; actualBytes: number; maxBytes: number }
  | {
      kind: "max-output-out-of-range";
      actualBytes: number;
      minBytes: number;
      maxBytes: number;
    }
  | { kind: "timeout-out-of-range"; actualMs: number; maxMs: number }
  | {
      kind: "argument-too-large";
      index: number;
      actualBytes: number;
      maxBytes: number;
    }
  | {
      kind: "argument-control-character";
      index: number;
      character: "nul" | "lf" | "cr";
    };

export const OPENSHELL_EXEC_INVALID_ARGUMENT = "OPENSHELL_EXEC_INVALID_ARGUMENT";
export const OPENSHELL_EXEC_DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const OPENSHELL_EXEC_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** A command OpenShell v0.0.72 will reject before attempting sandbox execution. */
export class OpenShellExecRequestValidationError extends Error {
  readonly code = OPENSHELL_EXEC_INVALID_ARGUMENT;

  constructor(readonly issue: OpenShellExecRequestValidationIssue) {
    super(openShellExecRequestValidationMessage(issue));
    this.name = "OpenShellExecRequestValidationError";
  }
}

/** A transport-neutral combined stdout/stderr retention failure. */
export class OpenShellExecOutputLimitError extends Error {
  readonly code = "ENOBUFS";

  constructor(readonly maxOutputBytes: number) {
    super(`OpenShell exec output exceeded ${String(maxOutputBytes)} bytes`);
    this.name = "OpenShellExecOutputLimitError";
  }
}

type CaptureOpenShellBinary = typeof captureOpenshellBinary;

const OPENSHELL_V0072_MAX_EXEC_COMMAND_ARGS = 1024;
const OPENSHELL_V0072_MAX_EXEC_ARGUMENT_BYTES = 32 * 1024;
const OPENSHELL_V0072_MAX_ASSEMBLED_COMMAND_BYTES = 256 * 1024;
const OPENSHELL_V0072_MAX_DECODED_GRPC_MESSAGE_BYTES = 1024 * 1024;
const OPENSHELL_V0072_MAX_EXEC_TIMEOUT_SECONDS = 0xffff_ffff;
const OPENSHELL_V0072_MAX_EXEC_TIMEOUT_MS = OPENSHELL_V0072_MAX_EXEC_TIMEOUT_SECONDS * 1000;
const OPENSHELL_V0072_SANDBOX_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

function openShellExecRequestValidationMessage(issue: OpenShellExecRequestValidationIssue): string {
  switch (issue.kind) {
    case "empty-command":
      return "command is required";
    case "too-many-arguments":
      return `command array exceeds ${String(issue.max)} argument limit`;
    case "assembled-command-too-large":
      return `assembled command string exceeds ${String(issue.maxBytes)} byte limit`;
    case "encoded-request-too-large":
      return `encoded exec request exceeds ${String(issue.maxBytes)} byte limit`;
    case "max-output-out-of-range":
      return `maxOutputBytes must be a safe integer from ${String(issue.minBytes)} through ${String(issue.maxBytes)}`;
    case "timeout-out-of-range":
      return `timeoutMs must be a non-negative safe integer no greater than ${String(issue.maxMs)}`;
    case "argument-too-large":
      return `command argument ${String(issue.index)} exceeds ${String(issue.maxBytes)} byte limit`;
    case "argument-control-character":
      return issue.character === "nul"
        ? `command argument ${String(issue.index)} contains null bytes`
        : `command argument ${String(issue.index)} contains newline or carriage return characters`;
  }
}

function openShellEscapedArgumentByteLength(argument: string): number {
  const bytes = Buffer.from(argument, "utf8");
  if (bytes.length === 0) return 2;

  let safe = true;
  let singleQuotes = 0;
  for (const byte of bytes) {
    if (byte === 0x27) singleQuotes += 1;
    if (
      !(
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        byte === 0x2e ||
        byte === 0x2f ||
        byte === 0x2d ||
        byte === 0x5f
      )
    ) {
      safe = false;
    }
  }
  if (safe) return bytes.length;

  // OpenShell wraps unsafe arguments in single quotes and expands each
  // embedded quote from one byte to the five-byte '\"'\"' sequence.
  return bytes.length + 2 + singleQuotes * 4;
}

/** Match OpenShell v0.0.72's pre-dispatch command validation. */
export function validateOpenShellExecCommand(
  command: readonly string[],
): OpenShellExecRequestValidationError | null {
  if (command.length === 0) {
    return new OpenShellExecRequestValidationError({ kind: "empty-command" });
  }
  if (command.length > OPENSHELL_V0072_MAX_EXEC_COMMAND_ARGS) {
    return new OpenShellExecRequestValidationError({
      kind: "too-many-arguments",
      actual: command.length,
      max: OPENSHELL_V0072_MAX_EXEC_COMMAND_ARGS,
    });
  }

  for (const [index, argument] of command.entries()) {
    const actualBytes = Buffer.byteLength(argument, "utf8");
    if (actualBytes > OPENSHELL_V0072_MAX_EXEC_ARGUMENT_BYTES) {
      return new OpenShellExecRequestValidationError({
        kind: "argument-too-large",
        index,
        actualBytes,
        maxBytes: OPENSHELL_V0072_MAX_EXEC_ARGUMENT_BYTES,
      });
    }
    if (argument.includes("\0")) {
      return new OpenShellExecRequestValidationError({
        kind: "argument-control-character",
        index,
        character: "nul",
      });
    }
    const newlineIndex = argument.search(/[\n\r]/);
    if (newlineIndex !== -1) {
      return new OpenShellExecRequestValidationError({
        kind: "argument-control-character",
        index,
        character: argument[newlineIndex] === "\n" ? "lf" : "cr",
      });
    }
  }

  const assembledBytes =
    command.reduce((total, argument) => total + openShellEscapedArgumentByteLength(argument), 0) +
    command.length -
    1;
  if (assembledBytes > OPENSHELL_V0072_MAX_ASSEMBLED_COMMAND_BYTES) {
    return new OpenShellExecRequestValidationError({
      kind: "assembled-command-too-large",
      actualBytes: assembledBytes,
      maxBytes: OPENSHELL_V0072_MAX_ASSEMBLED_COMMAND_BYTES,
    });
  }

  return null;
}

function protobufVarintByteLength(value: number): number {
  let remaining = value;
  let bytes = 1;
  while (remaining >= 0x80) {
    remaining = Math.floor(remaining / 0x80);
    bytes += 1;
  }
  return bytes;
}

function protobufLengthDelimitedFieldByteLength(valueBytes: number): number {
  // Every ExecSandboxRequest field used here has a one-byte protobuf tag.
  return 1 + protobufVarintByteLength(valueBytes) + valueBytes;
}

function openShellExecRequestEncodedByteLength(
  request: SandboxExecRequest,
  sandboxId: string,
): number {
  let bytes = protobufLengthDelimitedFieldByteLength(Buffer.byteLength(sandboxId, "utf8"));
  for (const argument of request.command) {
    bytes += protobufLengthDelimitedFieldByteLength(Buffer.byteLength(argument, "utf8"));
  }
  if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
    const timeoutSeconds = Math.ceil(request.timeoutMs / 1000);
    bytes += 1 + protobufVarintByteLength(timeoutSeconds);
  }
  if (request.stdin !== undefined) {
    const stdinBytes = Buffer.isBuffer(request.stdin)
      ? request.stdin.length
      : Buffer.byteLength(request.stdin, "utf8");
    bytes += protobufLengthDelimitedFieldByteLength(stdinBytes);
  }
  return bytes;
}

/** Match v0.0.72's 1 MiB decoded unary gRPC request boundary. */
export function validateOpenShellExecRequest(
  request: SandboxExecRequest,
  sandboxId: string = OPENSHELL_V0072_SANDBOX_ID_PLACEHOLDER,
): OpenShellExecRequestValidationError | null {
  const commandError = validateOpenShellExecCommand(request.command);
  if (commandError) return commandError;

  if (
    request.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(request.maxOutputBytes) ||
      request.maxOutputBytes < 0 ||
      request.maxOutputBytes > OPENSHELL_EXEC_MAX_OUTPUT_BYTES)
  ) {
    return new OpenShellExecRequestValidationError({
      kind: "max-output-out-of-range",
      actualBytes: request.maxOutputBytes,
      minBytes: 0,
      maxBytes: OPENSHELL_EXEC_MAX_OUTPUT_BYTES,
    });
  }

  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 0 ||
      request.timeoutMs > OPENSHELL_V0072_MAX_EXEC_TIMEOUT_MS)
  ) {
    return new OpenShellExecRequestValidationError({
      kind: "timeout-out-of-range",
      actualMs: request.timeoutMs,
      maxMs: OPENSHELL_V0072_MAX_EXEC_TIMEOUT_MS,
    });
  }

  const actualBytes = openShellExecRequestEncodedByteLength(request, sandboxId);
  if (actualBytes > OPENSHELL_V0072_MAX_DECODED_GRPC_MESSAGE_BYTES) {
    return new OpenShellExecRequestValidationError({
      kind: "encoded-request-too-large",
      actualBytes,
      maxBytes: OPENSHELL_V0072_MAX_DECODED_GRPC_MESSAGE_BYTES,
    });
  }
  return null;
}

export function openShellExecRequestValidationFailure(
  error: OpenShellExecRequestValidationError,
): SandboxExecResult {
  return { status: null, stdout: "", stderr: "", error };
}

function isOutputLimitError(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
}

function retainCombinedOutput(
  stdout: Buffer,
  stderr: Buffer,
  maxOutputBytes: number,
): { stdout: Buffer; stderr: Buffer; truncated: boolean } {
  const retainedStdout = stdout.subarray(0, maxOutputBytes);
  const remaining = Math.max(0, maxOutputBytes - retainedStdout.length);
  const retainedStderr = stderr.subarray(0, remaining);
  return {
    stdout: retainedStdout,
    stderr: retainedStderr,
    truncated: retainedStdout.length < stdout.length || retainedStderr.length < stderr.length,
  };
}

function normalizeExecResult(
  result: CaptureOpenshellBinaryResult,
  maxOutputBytes: number,
  stdoutEncoding: SandboxExecRequest["stdoutEncoding"],
): SandboxExecResult {
  const retained = retainCombinedOutput(result.stdout, result.stderr, maxOutputBytes);
  const stdout = stdoutEncoding === "buffer" ? "" : retained.stdout.toString("utf8");
  const stderr = retained.stderr.toString("utf8");
  const stdoutBytes = stdoutEncoding === "buffer" ? { stdoutBytes: retained.stdout } : {};
  if (retained.truncated || isOutputLimitError(result.error)) {
    return {
      status: null,
      stdout,
      ...stdoutBytes,
      stderr,
      error: new OpenShellExecOutputLimitError(maxOutputBytes),
      ...(result.signal !== undefined ? { signal: result.signal } : {}),
    };
  }
  const normalized: SandboxExecResult = {
    status: result.status,
    stdout,
    ...stdoutBytes,
    stderr,
  };
  if (result.error) normalized.error = result.error;
  if (result.signal !== undefined) normalized.signal = result.signal;
  return normalized;
}

function createCliSandboxControl(
  capture: CaptureOpenShellBinary,
  gatewayName?: string,
): OpenShellSandboxControl {
  return {
    async exec(request): Promise<SandboxExecResult> {
      // v0.0.72 creates UUID sandbox ids. Reserve that exact encoded width
      // before invoking the CLI, which resolves the name to the id internally.
      const validationError = validateOpenShellExecRequest(request);
      if (validationError) return openShellExecRequestValidationFailure(validationError);

      const gatewayArgs = gatewayName ? ["--gateway", gatewayName] : [];
      const maxOutputBytes = request.maxOutputBytes ?? OPENSHELL_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
      const result = capture(
        [
          ...gatewayArgs,
          "sandbox",
          "exec",
          "--name",
          request.sandboxName,
          "--",
          ...request.command,
        ],
        {
          input: request.stdin,
          // Node treats maxBuffer=0 as unlimited. One byte is the smallest
          // bounded capture; normalize it back to the requested zero-byte cap.
          maxBuffer: maxOutputBytes === 0 ? 1 : maxOutputBytes,
          timeout: request.timeoutMs,
        },
      );
      return normalizeExecResult(result, maxOutputBytes, request.stdoutEncoding);
    },
  };
}

export function createCliOpenShellSandboxControl(
  capture: CaptureOpenShellBinary = captureOpenshellBinary,
): OpenShellSandboxControl {
  return createCliSandboxControl(capture);
}

/** Bind every CLI fallback invocation to the gateway selected by the caller. */
export function createGatewayScopedCliOpenShellSandboxControl(
  gatewayName: string,
  capture: CaptureOpenShellBinary = captureOpenshellBinary,
  env: OpenShellGatewayEndpointEnvironment = process.env,
): OpenShellSandboxControl {
  assertNoOpenShellGatewayEndpointOverride(env);
  return createCliSandboxControl(capture, gatewayName);
}

export const openShellSandboxControl = createCliOpenShellSandboxControl();
