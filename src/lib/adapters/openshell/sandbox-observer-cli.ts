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
  type OpenShellSandboxReadinessProbe,
  type OpenShellSandboxResult,
} from "./sandbox-observer";
import { observeOpenShellSandboxIdentity } from "./sandbox-presence";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./command-execution";

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
  "Stopped",
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

export type CapturedOpenShellCommandResult = Readonly<{
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}>;

export type CapturedSandboxCommandResult = CapturedOpenShellCommandResult;

export type CaptureOpenShellCommand = (
  args: string[],
  options: {
    env?: Record<string, string>;
    ignoreError: true;
    includeStderr: true;
    includeStreams: true;
    replaceEnv?: true;
    timeout: number;
  },
) => CapturedOpenShellCommandResult | Promise<CapturedOpenShellCommandResult>;

export type CaptureSandboxCommand = CaptureOpenShellCommand;

export type CliOpenShellSandboxObserverDeps = Readonly<{
  capture: CaptureSandboxCommand;
  defaultTimeoutMs?: number;
  now?: () => number;
}>;

export type RunSandboxCommand = (
  args: string[],
  options: {
    ignoreError: true;
    killProcessTreeOnTimeout: true;
    killSignal: "SIGKILL";
    stdio: ["ignore", "pipe", "pipe"];
    suppressOutput: true;
    timeout: number;
  },
) => Readonly<{
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
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

function commandOutput(result: CapturedOpenShellCommandResult): string {
  const streams = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  return streams || result.output.trim();
}

function successfulCommandOutput(result: CapturedOpenShellCommandResult): string {
  return stripOpenShellCliAnsi(result.stdout ?? result.output);
}

export function classifyCliOpenShellCommandError(
  result: CapturedOpenShellCommandResult,
  messages: Readonly<{
    authentication: string;
    command: string;
    schema: string;
    timeout: string;
    unavailable?: string | (() => string);
  }> = {
    authentication: "OpenShell could not authenticate the sandbox observation.",
    command: "The OpenShell sandbox observation failed.",
    schema: "The OpenShell CLI and gateway sandbox schemas do not match.",
    timeout: "OpenShell sandbox observation timed out.",
  },
): OpenShellSandboxError | null {
  const output = stripOpenShellCliAnsi(commandOutput(result));
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT" && messages.unavailable) {
    return {
      kind: "command",
      reason: "failed",
      message:
        typeof messages.unavailable === "function" ? messages.unavailable() : messages.unavailable,
    };
  }
  if (errorCode === "ETIMEDOUT") {
    return { kind: "timeout", message: messages.timeout };
  }
  const printedError = /^\s*Error:/imu.test(output);
  if (result.status === 0 && !result.error && !printedError) return null;
  if (isOpenShellSandboxSchemaMismatch(output)) {
    return {
      kind: "schema",
      message: messages.schema,
    };
  }
  if (
    /\b(?:authentication failed|unauthorized|forbidden|permission denied|requires admin privileges|missing gateway auth token|device identity required|invalid token|expired token)\b/iu.test(
      output,
    )
  ) {
    return {
      kind: "authentication",
      message: messages.authentication,
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
  if (result.status !== 0 || result.error || printedError) {
    return {
      kind: "command",
      reason: result.status === 2 ? "invalid_request" : "failed",
      message: messages.command,
    };
  }
  return null;
}

/** Match only legacy failures that can leave a sandbox present but unreadable. */
export function isLegacyOpenShellSandboxConfigUnavailableOutput(output: string): boolean {
  const clean = stripOpenShellCliAnsi(String(output)).replace(/\r/g, "").trim();
  const structured = clean.replace(/\n\s*│\s*/g, " ");
  return (
    /^(?:error:\s*)?status:\s*Internal,\s*message:\s*["']sandbox has no spec["'](?:,\s*details:\s*\[\])?(?:,\s*metadata:\s*MetadataMap\s*\{\s*\})?$/iu.test(
      clean,
    ) ||
    /^(?:error:\s*)?(?:×\s*)?code:\s*["']Internal error["']\s*,\s*message:\s*["']sandbox has no spec["']$/iu.test(
      structured,
    ) ||
    /^(?:error:\s*)?(?:×\s*)?code:\s*'The system is not in a state required for the operation's execution'\s*,\s*message:\s*"provider '[a-z0-9][a-z0-9._-]*' not found"$/iu.test(
      structured,
    )
  );
}

/** Match only sandbox-specific absence from an owner-scoped lookup. */
export function isExplicitMissingOpenShellSandboxOutput(
  output: string,
  sandboxName: string,
): boolean {
  const clean = stripOpenShellCliAnsi(String(output)).replace(/\r/g, "").trim();
  const structured = clean.replace(/\n\s*│\s*/g, " ");
  const exactStructuredNotFound =
    /^(?:error:\s*)?(?:×\s*)?code:\s*["']Some requested entity was not found["']\s*,\s*message:\s*["']sandbox not found["']$/iu;
  const exactStatusNotFound =
    /^(?:error:\s*)?(?:×\s*)?status:\s*["']?Not\s+Found["']?\s*,\s*message:\s*["']sandbox not found["']$/iu;
  if (exactStructuredNotFound.test(structured) || exactStatusNotFound.test(structured)) return true;

  const escapedName = sandboxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namedSandbox = `(?:['"]${escapedName}['"]|${escapedName})`;
  return (
    new RegExp(
      `^(?:error:\\s*)?status:\\s*NotFound,\\s*sandbox\\s+${namedSandbox}\\s+not\\s+found[.!]?$`,
      "iu",
    ).test(clean) ||
    new RegExp(
      `^(?:error:\\s*)?sandbox\\s+${namedSandbox}\\s+(?:(?:is\\s+)?not\\s+(?:found|present)|does\\s+not\\s+exist)[.!]?$`,
      "iu",
    ).test(clean) ||
    new RegExp(`^(?:error:\\s*)?no\\s+such\\s+sandbox\\s+${namedSandbox}[.!]?$`, "iu").test(clean)
  );
}

function success<T>(value: T): OpenShellSandboxResult<T> {
  return { ok: true, value };
}

function failure<T>(error: OpenShellSandboxError): OpenShellSandboxResult<T> {
  return { ok: false, error };
}

function streamText(value: string | Buffer | null | undefined): string {
  return String(value ?? "");
}

function captureOpenShellCommandFromRunner(run: RunSandboxCommand): CaptureOpenShellCommand {
  return (args, options) => {
    const result = run(args, {
      ignoreError: true,
      killProcessTreeOnTimeout: true,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
      timeout: options.timeout,
    });
    const stdout = streamText(result.stdout);
    const stderr = streamText(result.stderr);
    return {
      status: result.status ?? null,
      output: `${stdout}\n${stderr}`.trim(),
      stdout,
      stderr,
      ...(result.error ? { error: result.error } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
    };
  };
}

/** Normalize structured runner results inside the CLI implementation. */
export function createCliOpenShellSandboxObserverFromRunner(
  run: RunSandboxCommand,
  defaultTimeoutMs?: number,
): OpenShellSandboxObserver {
  return createCliOpenShellSandboxObserver({
    capture: captureOpenShellCommandFromRunner(run),
    ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
  });
}

export function createCliOpenShellSandboxLookupFromRunner(
  run: RunSandboxCommand,
  defaultTimeoutMs?: number,
): CliOpenShellSandboxLookup {
  return createCliOpenShellSandboxLookup({
    capture: captureOpenShellCommandFromRunner(run),
    ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
  });
}

/** CLI-only fallback for legacy gateways that publish readiness through Kubernetes pod phase. */
export function createCliOpenShellLegacyPodReadinessProbe(
  deps: CliOpenShellSandboxObserverDeps,
): OpenShellSandboxReadinessProbe {
  return async (request) => {
    const gatewayArgs = request.target.kind === "named" ? ["-g", request.target.gatewayName] : [];
    const result = await deps.capture(
      [
        "doctor",
        "exec",
        ...gatewayArgs,
        "--",
        "kubectl",
        "-n",
        "openshell",
        "get",
        "pod",
        request.sandboxName,
        "-o",
        "jsonpath={.status.phase}",
      ],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        timeout: request.timeoutMs ?? deps.defaultTimeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS,
      },
    );
    const error = classifyCliOpenShellCommandError(result);
    if (error) return failure(error);
    return success(successfulCommandOutput(result).trim() === "Running" ? "ready" : "not_ready");
  };
}

/**
 * CLI-only compatibility lookup for the legacy status display. Presence and
 * phase decisions must use `result`; `displayOutput` remains a CLI-only
 * presentation compatibility path.
 */
export function createCliOpenShellSandboxLookup(
  deps: Pick<CliOpenShellSandboxObserverDeps, "capture" | "defaultTimeoutMs" | "now">,
): CliOpenShellSandboxLookup {
  return async (request) => {
    const timeout = request.timeoutMs ?? deps.defaultTimeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS;
    const now = deps.now ?? Date.now;
    const deadlineMs = now() + timeout;
    const captureOptions = {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout,
    } as const;
    const result = await deps.capture(
      targetArgs("get", request.target, request.sandboxName),
      captureOptions,
    );
    const output = commandOutput(result);
    const error = classifyCliOpenShellCommandError(result);
    if (error && error.kind !== "command") {
      return { result: failure(error), displayOutput: "" };
    }
    if (
      !result.error &&
      result.status !== null &&
      result.status !== 0 &&
      isLegacyOpenShellSandboxConfigUnavailableOutput(output)
    ) {
      const remainingTimeoutMs = Math.ceil(deadlineMs - now());
      if (remainingTimeoutMs <= 0) {
        return {
          result: failure({
            kind: "timeout",
            message: "OpenShell sandbox observation timed out.",
          }),
          displayOutput: "",
        };
      }
      const inventory = await deps.capture([...targetArgs("list", request.target), "-o", "json"], {
        ...captureOptions,
        timeout: remainingTimeoutMs,
      });
      const listed = observeOpenShellSandboxIdentity(request.sandboxName, inventory);
      if (listed.kind === "present") {
        return {
          result: success({
            state: "present",
            sandbox: observation(request.sandboxName, listed.phase),
          }),
          displayOutput: "",
        };
      }
      return {
        result: failure({
          kind: "command",
          reason: "failed",
          message:
            "OpenShell could not confirm the unreadable legacy sandbox in gateway inventory.",
        }),
        displayOutput: "",
      };
    }
    if (
      !result.error &&
      !result.signal &&
      result.status !== null &&
      result.status !== 0 &&
      isExplicitMissingOpenShellSandboxOutput(output, request.sandboxName)
    ) {
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
