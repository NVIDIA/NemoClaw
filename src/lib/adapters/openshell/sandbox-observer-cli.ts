// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ListOpenShellSandboxesRequest,
  type LookupOpenShellSandboxRequest,
  type OpenShellGatewayTarget,
  type OpenShellSandboxError,
  type OpenShellSandboxInventory,
  type OpenShellSandboxLookup,
  type OpenShellSandboxObservation,
  type OpenShellSandboxObserver,
  type OpenShellSandboxResult,
} from "./sandbox-observer";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

const ANSI_RE = /\x1b\[[0-9;]*m/gu;

const READY_PHASES = new Set(["Ready", "Running"]);
const TERMINAL_PHASES = new Set([
  "CrashLoopBackOff",
  "Error",
  "Evicted",
  "Failed",
  "ImagePullBackOff",
  "Unknown",
]);
const KNOWN_PHASES = new Set([
  ...READY_PHASES,
  ...TERMINAL_PHASES,
  "Creating",
  "Deleting",
  "NotReady",
  "Pending",
  "Provisioning",
  "Terminating",
]);
const CANONICAL_PHASES = new Map(
  [...KNOWN_PHASES].map((phase) => [phase.toLowerCase(), phase] as const),
);

function isOpenShellSandboxSchemaMismatch(output: string): boolean {
  return (
    /invalid wire type/iu.test(output) || /proto(?:buf)?(?: decode| schema| wire)/iu.test(output)
  );
}

export type CapturedSandboxCommandResult = Readonly<{
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
}>;

export type CaptureSandboxCommand = (
  args: string[],
  options: {
    ignoreError: true;
    includeStderr: true;
    includeStreams: true;
    timeout: number;
  },
) => CapturedSandboxCommandResult | Promise<CapturedSandboxCommandResult>;

export type CliOpenShellSandboxObserverDeps = Readonly<{
  capture: CaptureSandboxCommand;
  defaultTimeoutMs?: number;
}>;

export type CliOpenShellSandboxLookupResult = Readonly<{
  result: OpenShellSandboxResult<OpenShellSandboxLookup>;
  displayOutput: string;
}>;

export type CliOpenShellSandboxLookup = (
  request: LookupOpenShellSandboxRequest,
) => Promise<CliOpenShellSandboxLookupResult>;

function readinessForPhase(phase: string | null): OpenShellSandboxObservation["readiness"] {
  if (phase && READY_PHASES.has(phase)) return "ready";
  if (phase && TERMINAL_PHASES.has(phase)) return "terminal";
  return "not_ready";
}

export function stripOpenShellCliAnsi(value = ""): string {
  return String(value).replace(ANSI_RE, "");
}

function observation(name: string, phase: string | null): OpenShellSandboxObservation {
  return { name, phase, readiness: readinessForPhase(phase) };
}

function isNonSandboxRow(line: string, firstColumn: string): boolean {
  return (
    firstColumn === "NAME" ||
    line === "No sandboxes found" ||
    line === "No sandboxes found." ||
    /^Error:/iu.test(line) ||
    isOpenShellSandboxSchemaMismatch(line)
  );
}

export function parseCliOpenShellSandboxInventory(output: string): OpenShellSandboxInventory {
  const sandboxes: OpenShellSandboxObservation[] = [];
  for (const rawLine of stripOpenShellCliAnsi(output).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/u);
    const name = columns[0];
    if (!name || isNonSandboxRow(line, name)) continue;
    let phase: string | null = null;
    for (const column of columns.slice(1)) {
      phase = CANONICAL_PHASES.get(column.toLowerCase()) ?? phase;
    }
    sandboxes.push(observation(name, phase));
  }
  return { sandboxes };
}

function parseCliOpenShellSandboxPhase(output: string): string | null {
  const match = stripOpenShellCliAnsi(output).match(/^\s*Phase:\s+(\S+)/mu);
  const phase = match?.[1] ?? null;
  return phase ? (CANONICAL_PHASES.get(phase.toLowerCase()) ?? phase) : null;
}

function targetArgs(
  command: "get" | "list",
  target: OpenShellGatewayTarget,
  sandboxName?: string,
): string[] {
  const args = ["sandbox", command];
  if (target.kind === "named") args.push("-g", target.gatewayName);
  if (sandboxName) args.push(sandboxName);
  return args;
}

function commandOutput(result: CapturedSandboxCommandResult): string {
  return `${result.stderr ?? ""}\n${result.stdout ?? result.output ?? ""}`.trim();
}

function successfulCommandOutput(result: CapturedSandboxCommandResult): string {
  return stripOpenShellCliAnsi(result.stdout ?? result.output);
}

export function classifyCliOpenShellCommandError(
  result: CapturedSandboxCommandResult,
): OpenShellSandboxError | null {
  const output = stripOpenShellCliAnsi(commandOutput(result));
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ETIMEDOUT") {
    return { kind: "timeout", message: "OpenShell sandbox observation timed out." };
  }
  if (isOpenShellSandboxSchemaMismatch(output)) {
    return {
      kind: "schema",
      message: "The OpenShell CLI and gateway sandbox schemas do not match.",
    };
  }
  if (
    /\b(?:authentication failed|unauthorized|forbidden|permission denied|requires admin privileges|missing gateway auth token|device identity required|invalid token|expired token)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "authentication",
      message: "OpenShell could not authenticate the sandbox observation.",
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
    /\b(?:connection refused|client error \(connect\)|tcp connect error|transport error|connection reset|connection aborted|connection closed|no active gateway|no gateway configured|unknown gateway)\b|status:\s*disconnected/iu.test(
      output,
    )
  ) {
    return {
      kind: "transport",
      reason: "unreachable",
      message: "OpenShell could not reach the selected gateway.",
    };
  }
  if (result.status !== 0) {
    return {
      kind: "command",
      reason: result.status === 2 ? "invalid_request" : "failed",
      message: "The OpenShell sandbox observation failed.",
    };
  }
  return null;
}

function isMissingSandboxOutput(output: string): boolean {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox has no spec/iu.test(
    stripOpenShellCliAnsi(output),
  );
}

function success<T>(value: T): OpenShellSandboxResult<T> {
  return { ok: true, value };
}

function failure<T>(error: OpenShellSandboxError): OpenShellSandboxResult<T> {
  return { ok: false, error };
}

/**
 * CLI-only compatibility lookup for the legacy status display. Presence and
 * phase decisions must use `result`; `displayOutput` remains a CLI-only
 * presentation compatibility path.
 */
export function createCliOpenShellSandboxLookup(
  deps: Pick<CliOpenShellSandboxObserverDeps, "capture" | "defaultTimeoutMs">,
): CliOpenShellSandboxLookup {
  return async (request) => {
    const result = await deps.capture(targetArgs("get", request.target, request.sandboxName), {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: request.timeoutMs ?? deps.defaultTimeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS,
    });
    const output = commandOutput(result);
    const error = classifyCliOpenShellCommandError(result);
    if (error && error.kind !== "command") {
      return { result: failure(error), displayOutput: "" };
    }
    if (result.status !== 0 && isMissingSandboxOutput(output)) {
      return { result: success({ state: "missing" }), displayOutput: "" };
    }
    if (error) return { result: failure(error), displayOutput: "" };
    const displayOutput = successfulCommandOutput(result).trim();
    return {
      result: success({
        state: "present",
        sandbox: observation(request.sandboxName, parseCliOpenShellSandboxPhase(displayOutput)),
      }),
      displayOutput,
    };
  };
}

export function createCliOpenShellSandboxObserver(
  deps: CliOpenShellSandboxObserverDeps,
): OpenShellSandboxObserver {
  const capture = deps.capture;

  const listSandboxes = async (
    request: ListOpenShellSandboxesRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxInventory>> => {
    const result = await capture(targetArgs("list", request.target), {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: request.timeoutMs ?? deps.defaultTimeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS,
    });
    const error = classifyCliOpenShellCommandError(result);
    if (error) return failure(error);
    return success(parseCliOpenShellSandboxInventory(successfulCommandOutput(result)));
  };

  return { listSandboxes };
}
