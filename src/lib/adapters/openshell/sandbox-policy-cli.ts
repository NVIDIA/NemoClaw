// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseOpenShellPolicy } from "../../policy/merge";
import { captureOpenshellCommand } from "./client";
import { openshellNotFoundDiagnosticLines, tryResolveOpenshellBinary } from "./command-argv";
import { type OpenShellSandboxError, type OpenShellSandboxResult } from "./sandbox-observer";
import {
  type OpenShellSandboxPolicyRead,
  type OpenShellSandboxPolicyReader,
  type ReadOpenShellSandboxPolicyRequest,
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

export type CapturePolicyCommand = (
  args: string[],
  options: {
    ignoreError: true;
    includeStderr: true;
    includeStreams: true;
    timeout: number;
  },
) => CapturedPolicyCommandResult | Promise<CapturedPolicyCommandResult>;

export type CliOpenShellSandboxPolicyReaderDeps = Readonly<{
  capture: CapturePolicyCommand;
  defaultTimeoutMs?: number;
}>;

export type CliOpenShellSandboxPolicyReadResult = Readonly<{
  result: OpenShellSandboxResult<OpenShellSandboxPolicyRead>;
  displayOutput: string;
}>;

export type CliOpenShellSandboxPolicyRead = (
  request: ReadOpenShellSandboxPolicyRequest,
) => Promise<CliOpenShellSandboxPolicyReadResult>;

const ANSI_RE = /\x1b\[[0-9;]*m/gu;
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

function stripAnsi(value = ""): string {
  return String(value).replace(ANSI_RE, "");
}

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

function metadataRevision(metadata: string, field: "Active" | "Version"): number | null {
  const raw = metadata.match(new RegExp(`^${field}:\\s*(\\d+)\\s*$`, "imu"))?.[1];
  if (!raw) return null;
  const revision = Number.parseInt(raw, 10);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function parsePolicyRead(
  request: ReadOpenShellSandboxPolicyRequest,
  displayOutput: string,
): OpenShellSandboxResult<OpenShellSandboxPolicyRead> {
  try {
    const normalized = stripAnsi(displayOutput);
    const parsed = parseOpenShellPolicy(normalized);
    const metadata = metadataSection(normalized);
    return {
      ok: true,
      value: {
        scope: request.scope,
        document: parsed.yamlBody,
        reportedRevision: metadataRevision(metadata, "Version"),
        appliedRevision: metadataRevision(metadata, "Active"),
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

export function createCliOpenShellSandboxPolicyRead(
  deps: CliOpenShellSandboxPolicyReaderDeps,
): CliOpenShellSandboxPolicyRead {
  return async (request) => {
    const targetArgs = request.target.kind === "named" ? ["-g", request.target.gatewayName] : [];
    const captured = await deps.capture(
      request.scope === "base"
        ? ["policy", "get", ...targetArgs, "--base", request.sandboxName]
        : ["policy", "get", ...targetArgs, "--full", request.sandboxName],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        timeout: request.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_POLICY_READ_TIMEOUT_MS,
      },
    );
    const displayOutput = (captured.stdout ?? captured.output ?? "").trim();
    const commandFailure = classifyCommandFailure(captured);
    if (commandFailure) {
      return { result: { ok: false, error: commandFailure }, displayOutput: "" };
    }
    return { result: parsePolicyRead(request, displayOutput), displayOutput };
  };
}

export function createCliOpenShellSandboxPolicyReader(
  deps: CliOpenShellSandboxPolicyReaderDeps,
): OpenShellSandboxPolicyReader {
  const read = createCliOpenShellSandboxPolicyRead(deps);
  return {
    readSandboxPolicy: async (request) => (await read(request)).result,
  };
}

export const readCliOpenShellSandboxPolicy = createCliOpenShellSandboxPolicyRead({
  capture: capturePolicyWithRunner,
});
