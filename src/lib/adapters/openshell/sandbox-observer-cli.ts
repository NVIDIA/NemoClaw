// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleepMsAsync } from "node:timers/promises";

import {
  type ListOpenShellSandboxesRequest,
  type LookupOpenShellSandboxRequest,
  type OpenShellGatewayTarget,
  type OpenShellSandboxError,
  type OpenShellSandboxInventory,
  type OpenShellSandboxLookup,
  type OpenShellSandboxObservation,
  type OpenShellSandboxObserver,
  type OpenShellSandboxReadinessWait,
  type OpenShellSandboxResult,
  type WaitForOpenShellSandboxReadyRequest,
} from "./sandbox-observer";

export { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
export type {
  OpenShellGatewayTarget,
  OpenShellSandboxError,
  OpenShellSandboxInventory,
  OpenShellSandboxLookup,
  OpenShellSandboxObservation,
  OpenShellSandboxObserver,
  OpenShellSandboxReadiness,
  OpenShellSandboxReadinessWait,
  OpenShellSandboxResult,
} from "./sandbox-observer";

const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const DEFAULT_SANDBOX_OBSERVATION_TIMEOUT_MS = 15_000;

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
  now?: () => number;
  sleep?: (ms: number) => void | Promise<void>;
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
    const phaseColumns = columns.slice(1);
    const phase = phaseColumns.includes("NotReady")
      ? "NotReady"
      : (phaseColumns.find((column) => KNOWN_PHASES.has(column)) ?? null);
    sandboxes.push(observation(name, phase));
  }
  return { sandboxes };
}

function parseCliOpenShellSandboxPhase(output: string): string | null {
  const match = stripOpenShellCliAnsi(output).match(/^\s*Phase:\s+(\S+)/mu);
  return match?.[1] ?? null;
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

function commandError(result: CapturedSandboxCommandResult): OpenShellSandboxError | null {
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
    /\b(?:authentication failed|unauthorized|forbidden|permission denied|missing gateway auth token|device identity required|invalid token|expired token)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "authentication",
      message: "OpenShell could not authenticate the sandbox observation.",
    };
  }
  if (
    /\b(?:connection refused|client error \(connect\)|tcp connect error|transport error|connection reset|connection aborted|connection closed|no active gateway|no gateway configured|handshake verification failed)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "transport",
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
      timeout: request.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_SANDBOX_OBSERVATION_TIMEOUT_MS,
    });
    const output = commandOutput(result);
    const error = commandError(result);
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
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepMsAsync;
  const cliLookup = createCliOpenShellSandboxLookup(deps);

  const listSandboxes = async (
    request: ListOpenShellSandboxesRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxInventory>> => {
    const result = await capture(targetArgs("list", request.target), {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: request.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_SANDBOX_OBSERVATION_TIMEOUT_MS,
    });
    const error = commandError(result);
    if (error) return failure(error);
    return success(parseCliOpenShellSandboxInventory(successfulCommandOutput(result)));
  };

  const lookupSandbox = async (
    request: LookupOpenShellSandboxRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxLookup>> => {
    return (await cliLookup(request)).result;
  };

  const waitForSandboxReady = async (
    request: WaitForOpenShellSandboxReadyRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxReadinessWait>> => {
    const timeoutMs = Math.max(0, request.timeoutMs);
    const pollIntervalMs = Math.max(0, request.pollIntervalMs ?? 250);
    const stableReadyObservations = Math.max(1, Math.round(request.stableReadyObservations ?? 1));
    const errorPhaseDebounceObservations = Math.max(
      1,
      Math.round(request.errorPhaseDebounceObservations ?? 1),
    );
    const deadline = now() + timeoutMs;
    let observations = 0;
    let consecutiveReady = 0;
    let consecutiveError = 0;
    let lastObservation: OpenShellSandboxObservation | null = null;

    while (now() < deadline) {
      const remainingMs = Math.max(1, deadline - now());
      const listed = await listSandboxes({
        target: request.target,
        timeoutMs: remainingMs,
      });
      if (!listed.ok) return listed;
      observations += 1;
      const current =
        listed.value.sandboxes.find((sandbox) => sandbox.name === request.sandboxName) ?? null;
      lastObservation = current;

      if (current?.readiness === "ready") {
        consecutiveReady += 1;
        consecutiveError = 0;
        if (consecutiveReady >= stableReadyObservations) {
          return success({ state: "ready", sandbox: current, observations });
        }
      } else {
        consecutiveReady = 0;
        if (current?.readiness === "terminal") {
          consecutiveError = current.phase === "Error" ? consecutiveError + 1 : 0;
          if (current.phase !== "Error" || consecutiveError >= errorPhaseDebounceObservations) {
            return success({ state: "terminal", sandbox: current, observations });
          }
        } else {
          consecutiveError = 0;
        }
      }

      const remainingAfterObservationMs = deadline - now();
      if (remainingAfterObservationMs <= 0) break;
      await sleep(Math.min(pollIntervalMs, remainingAfterObservationMs));
    }

    return success({ state: "timeout", lastObservation, observations });
  };

  return { listSandboxes, lookupSandbox, waitForSandboxReady };
}
