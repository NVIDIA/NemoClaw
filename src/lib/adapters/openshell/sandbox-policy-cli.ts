// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildOpenShellSandboxPolicyInspectionArgs,
  buildOpenShellSandboxPolicyReadArgs,
  buildOpenShellSandboxPolicyRevisionReadArgs,
  parseOpenShellPolicy,
  parseSandboxPolicyMetadata,
  type OpenShellPolicyInspection,
} from "../../policy/merge";
import { captureOpenshellCommand, stripAnsi } from "./client";
import { openshellNotFoundDiagnosticLines, tryResolveOpenshellBinary } from "./command-argv";
import { type OpenShellSandboxError, type OpenShellSandboxResult } from "./sandbox-observer";
import {
  type InspectOpenShellSandboxPolicyRequest,
  type OpenShellSandboxPolicyRevisionRead,
  type OpenShellSandboxPolicyRead,
  type OpenShellSandboxPolicyReader,
  type ReadOpenShellSandboxPolicyRequest,
  type ReadOpenShellSandboxPolicyRevisionRequest,
  type SyncOpenShellSandboxPolicyReader,
} from "./sandbox-policy";

export { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
export type { OpenShellSandboxPolicyReader } from "./sandbox-policy";

export type CapturedPolicyCommandResult = Readonly<{
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
}>;

export type PolicyCaptureOptions = Readonly<{
  ignoreError: true;
  includeStderr: true;
  includeStreams: true;
  timeout: number;
}>;

export type CapturePolicyCommand = (
  args: string[],
  options: PolicyCaptureOptions,
) => CapturedPolicyCommandResult | Promise<CapturedPolicyCommandResult>;

export type SyncCapturePolicyCommand = (
  args: string[],
  options: PolicyCaptureOptions,
) => CapturedPolicyCommandResult;

export type CliOpenShellSandboxPolicyReaderDeps = Readonly<{
  capture: CapturePolicyCommand;
  defaultTimeoutMs?: number;
}>;

export type SyncCliOpenShellSandboxPolicyReaderDeps = Readonly<{
  capture: SyncCapturePolicyCommand;
  defaultTimeoutMs?: number;
}>;

export type CliOpenShellSandboxPolicyReadResult = Readonly<{
  result: OpenShellSandboxResult<OpenShellSandboxPolicyRead>;
  displayOutput: string;
}>;

export type CliOpenShellSandboxPolicyRead = (
  request: ReadOpenShellSandboxPolicyRequest,
) => Promise<CliOpenShellSandboxPolicyReadResult>;

const DEFAULT_POLICY_READ_TIMEOUT_MS = 15_000;

const capturePolicyWithRunner: CapturePolicyCommand = (args, options) => {
  const executable = tryResolveOpenshellBinary();
  if (!executable) {
    return {
      status: null,
      output: "",
      error: Object.assign(new Error("OpenShell binary not found"), { code: "ENOENT" }),
    };
  }
  return captureOpenshellCommand(executable, args, options);
};

function diagnostic(result: CapturedPolicyCommandResult): string {
  return stripAnsi(result.stderr?.trim() ? result.stderr : (result.output ?? ""));
}

function classifyCommandFailure(result: CapturedPolicyCommandResult): OpenShellSandboxError | null {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT") {
    return {
      kind: "command",
      reason: "failed",
      message: openshellNotFoundDiagnosticLines().join("\n"),
    };
  }
  if (errorCode === "ETIMEDOUT") {
    return { kind: "timeout", message: "The OpenShell sandbox policy read timed out." };
  }
  if (result.status === 0 && !result.error) return null;

  const output = diagnostic(result);
  if (
    /invalid wire type/iu.test(output) ||
    /proto(?:buf)?(?: decode| schema| wire)/iu.test(output)
  ) {
    return {
      kind: "schema",
      message: "The OpenShell CLI and gateway policy schemas do not match.",
    };
  }
  if (
    /\b(?:authentication failed|unauthorized|forbidden|permission denied|missing gateway auth token|device identity required|invalid token|expired token)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "authentication",
      message: "OpenShell could not authenticate the sandbox policy read.",
    };
  }
  if (/\bhandshake verification failed\b/iu.test(output)) {
    return {
      kind: "transport",
      reason: "identity_mismatch",
      message: "The selected OpenShell gateway identity does not match the recorded identity.",
    };
  }
  if (
    /\b(?:connection refused|client error \(connect\)|tcp connect error|transport error|connection reset|connection aborted|connection closed|no active gateway|no gateway configured)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "transport",
      reason: "unreachable",
      message: "OpenShell could not reach the selected gateway.",
    };
  }
  return {
    kind: "command",
    reason: result.status === 2 ? "invalid_request" : "failed",
    message: "The OpenShell sandbox policy read failed.",
  };
}

function metadataSection(output: string): string {
  const separator = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/u.exec(output);
  return separator ? output.slice(0, separator.index) : "";
}

function activeRevision(metadata: string): number | null {
  const raw = metadata.match(/^Active:\s*(\d+)\s*$/imu)?.[1];
  if (!raw) return null;
  const revision = Number.parseInt(raw, 10);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function parsePolicyRead(
  displayOutput: string,
): OpenShellSandboxResult<OpenShellSandboxPolicyRead> {
  try {
    const normalized = stripAnsi(displayOutput);
    const parsed = parseOpenShellPolicy(normalized);
    const metadata = metadataSection(normalized);
    return {
      ok: true,
      value: {
        document: parsed.yamlBody,
        appliedRevision: activeRevision(metadata),
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        kind: "schema",
        message: "OpenShell returned an invalid sandbox policy document.",
      },
    };
  }
}

function parsePolicyInspection(
  request: InspectOpenShellSandboxPolicyRequest,
  displayOutput: string,
): OpenShellSandboxResult<OpenShellPolicyInspection> {
  try {
    return {
      ok: true,
      value: parseSandboxPolicyMetadata(stripAnsi(displayOutput), request.sandboxName),
    };
  } catch {
    return {
      ok: false,
      error: {
        kind: "schema",
        message: "OpenShell returned invalid sandbox policy metadata.",
      },
    };
  }
}

function parsePolicyRevision(
  request: ReadOpenShellSandboxPolicyRevisionRequest,
  displayOutput: string,
): OpenShellSandboxResult<OpenShellSandboxPolicyRevisionRead> {
  try {
    return {
      ok: true,
      value: {
        document: parseOpenShellPolicy(stripAnsi(displayOutput)).yamlBody,
        revision: request.revision,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        kind: "schema",
        message: "OpenShell returned an invalid sandbox policy revision document.",
      },
    };
  }
}

function policyReadArgs(request: ReadOpenShellSandboxPolicyRequest): string[] {
  return buildOpenShellSandboxPolicyReadArgs({
    sandboxName: request.sandboxName,
    ...(request.target.kind === "named" ? { gatewayName: request.target.gatewayName } : {}),
    scope: request.scope,
  });
}

function policyInspectionArgs(request: InspectOpenShellSandboxPolicyRequest): string[] {
  return buildOpenShellSandboxPolicyInspectionArgs({
    sandboxName: request.sandboxName,
    ...(request.target.kind === "named" ? { gatewayName: request.target.gatewayName } : {}),
  });
}

function policyRevisionArgs(request: ReadOpenShellSandboxPolicyRevisionRequest): string[] {
  return buildOpenShellSandboxPolicyRevisionReadArgs({
    sandboxName: request.sandboxName,
    ...(request.target.kind === "named" ? { gatewayName: request.target.gatewayName } : {}),
    revision: request.revision,
  });
}

function captureOptions(timeoutMs: number | undefined, defaultTimeoutMs: number | undefined) {
  return {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    timeout: timeoutMs ?? defaultTimeoutMs ?? DEFAULT_POLICY_READ_TIMEOUT_MS,
  } as const;
}

function capturedOutput(captured: CapturedPolicyCommandResult): string {
  return (captured.stdout ?? captured.output ?? "").trim();
}

function capturedPolicyRead(
  captured: CapturedPolicyCommandResult,
): CliOpenShellSandboxPolicyReadResult {
  const displayOutput = capturedOutput(captured);
  const commandFailure = classifyCommandFailure(captured);
  if (commandFailure) {
    return { result: { ok: false, error: commandFailure }, displayOutput: "" };
  }
  return { result: parsePolicyRead(displayOutput), displayOutput };
}

function capturedPolicyInspection(
  request: InspectOpenShellSandboxPolicyRequest,
  captured: CapturedPolicyCommandResult,
): OpenShellSandboxResult<OpenShellPolicyInspection> {
  const commandFailure = classifyCommandFailure(captured);
  return commandFailure
    ? { ok: false, error: commandFailure }
    : parsePolicyInspection(request, capturedOutput(captured));
}

function invalidRevision(): OpenShellSandboxResult<OpenShellSandboxPolicyRevisionRead> {
  return {
    ok: false,
    error: {
      kind: "command",
      reason: "invalid_request",
      message: "The requested OpenShell sandbox policy revision is invalid.",
    },
  };
}

function capturedPolicyRevision(
  request: ReadOpenShellSandboxPolicyRevisionRequest,
  captured: CapturedPolicyCommandResult,
): OpenShellSandboxResult<OpenShellSandboxPolicyRevisionRead> {
  const commandFailure = classifyCommandFailure(captured);
  return commandFailure
    ? { ok: false, error: commandFailure }
    : parsePolicyRevision(request, capturedOutput(captured));
}

export function createCliOpenShellSandboxPolicyRead(
  deps: CliOpenShellSandboxPolicyReaderDeps,
): CliOpenShellSandboxPolicyRead {
  return async (request) => {
    const captured = await deps.capture(policyReadArgs(request), {
      ...captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
    });
    return capturedPolicyRead(captured);
  };
}

export function createCliOpenShellSandboxPolicyReader(
  deps: CliOpenShellSandboxPolicyReaderDeps,
): OpenShellSandboxPolicyReader {
  const read = createCliOpenShellSandboxPolicyRead(deps);
  return {
    readSandboxPolicy: async (request) => (await read(request)).result,
    inspectSandboxPolicy: async (request) =>
      capturedPolicyInspection(
        request,
        await deps.capture(
          policyInspectionArgs(request),
          captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
        ),
      ),
    readSandboxPolicyRevision: async (request) =>
      !Number.isSafeInteger(request.revision) || request.revision < 1
        ? invalidRevision()
        : capturedPolicyRevision(
            request,
            await deps.capture(
              policyRevisionArgs(request),
              captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
            ),
          ),
  };
}

/** Create a synchronous typed reader for existing transactional callers. */
export function createSyncCliOpenShellSandboxPolicyReader(
  deps: SyncCliOpenShellSandboxPolicyReaderDeps,
): SyncOpenShellSandboxPolicyReader {
  return {
    readSandboxPolicy: (request) =>
      capturedPolicyRead(
        deps.capture(policyReadArgs(request), {
          ...captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
        }),
      ).result,
    inspectSandboxPolicy: (request) =>
      capturedPolicyInspection(
        request,
        deps.capture(
          policyInspectionArgs(request),
          captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
        ),
      ),
    readSandboxPolicyRevision: (request) =>
      !Number.isSafeInteger(request.revision) || request.revision < 1
        ? invalidRevision()
        : capturedPolicyRevision(
            request,
            deps.capture(
              policyRevisionArgs(request),
              captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
            ),
          ),
  };
}

export const readCliOpenShellSandboxPolicy = createCliOpenShellSandboxPolicyRead({
  capture: capturePolicyWithRunner,
});
