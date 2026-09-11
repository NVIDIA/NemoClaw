// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { readFile, readdir, readlink, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { isValidName } from "../../name-validation";
import {
  captureOpenshellCommandAsyncResult,
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "./command-execution";
import {
  type OpenShellForwardAdapter,
  type OpenShellForwardError,
  type OpenShellForwardIdentity,
  type OpenShellForwardObservation,
  type OpenShellForwardReleaseResult,
  type OpenShellForwardRuntimeError,
  type OpenShellForwardStartResult,
  type OpenShellLegacyForwardRetirementResult,
  type ObserveOpenShellForwardsRequest,
  type RetireLegacyOpenShellForwardRequest,
  type StartOpenShellForwardRequest,
  type VerifyOpenShellForwardReleaseRequest,
} from "./forward";
import { buildOpenShellSubprocessEnv } from "./resolve-shared";

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_PROC_WORK_LIMIT = 50_000;
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;

const TERMINAL_SGR_RE = /(?:\x1B\[|\x9B)[0-9;]*m/gu;
const TERMINAL_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

const VALIDATION_ERROR = Object.freeze({
  kind: "validation",
  message: "The OpenShell forward request is invalid.",
} as const satisfies OpenShellForwardError);
const AUTHORITY_ERROR = Object.freeze({
  kind: "authority",
  message: "NemoClaw could not prove current OpenShell forward authority.",
} as const satisfies OpenShellForwardError);
const AUTHENTICATION_ERROR = Object.freeze({
  kind: "authentication",
  message: "OpenShell authentication failed.",
} as const satisfies OpenShellForwardError);
const SCHEMA_ERROR = Object.freeze({
  kind: "schema",
  message: "OpenShell returned an invalid forward response.",
} as const satisfies OpenShellForwardError);
const TIMEOUT_ERROR = Object.freeze({
  kind: "timeout",
  message: "The OpenShell forward operation timed out.",
} as const satisfies OpenShellForwardError);
const TRANSPORT_ERROR = Object.freeze({
  kind: "transport",
  message: "The OpenShell forward transport failed.",
} as const satisfies OpenShellForwardError);
const COMMAND_ERROR = Object.freeze({
  kind: "command",
  message: "The OpenShell forward command failed.",
} as const satisfies OpenShellForwardError);
const OWNERSHIP_ERROR = Object.freeze({
  kind: "ownership",
  message: "NemoClaw could not prove OpenShell forward ownership.",
} as const satisfies OpenShellForwardError);
const CLEANUP_ERROR = Object.freeze({
  kind: "cleanup",
  message: "NemoClaw could not prove OpenShell forward cleanup.",
} as const satisfies OpenShellForwardError);

export type CliOpenShellForwardCommandResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  error?: Error;
  timedOut?: boolean;
}>;

export type CliOpenShellForwardCommandRunner = (
  executable: string,
  args: readonly string[],
  options: Readonly<{
    environment: NodeJS.ProcessEnv;
    outputLimitBytes: number;
    timeoutMs: number;
  }>,
) => Promise<CliOpenShellForwardCommandResult>;

export interface CliOpenShellForwardChild {
  readonly exitCode: number | null;
  readonly pid?: number;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export type CliOpenShellForwardInspection =
  | Readonly<{ state: "unbound" }>
  | Readonly<{ state: "owned"; pid: number }>
  | Readonly<{ state: "foreign"; pids: readonly number[] }>
  | Readonly<{ state: "indeterminate" }>;

export type CliOpenShellLegacyForwardInspection =
  | Readonly<{ state: "owned"; pid: number }>
  | Readonly<{ state: "not_owned" }>
  | Readonly<{ state: "indeterminate" }>;

export type CliOpenShellForwardPortInspection =
  | Readonly<{ state: "bound" }>
  | Readonly<{ state: "unbound" }>
  | Readonly<{ state: "indeterminate"; error: OpenShellForwardRuntimeError }>;

export type CliOpenShellForwardPortProbe = (
  forward: OpenShellForwardIdentity,
  timeoutMs: number,
) => Promise<CliOpenShellForwardPortInspection>;

export type CliOpenShellForwardAdapterDeps = Readonly<{
  executable: string;
  environment?: NodeJS.ProcessEnv;
  inspect?: (
    forward: OpenShellForwardIdentity,
    expectedPid: number | undefined,
    timeoutMs: number,
  ) => Promise<CliOpenShellForwardInspection>;
  inspectLegacy?: (
    forward: OpenShellForwardIdentity,
    expectedPid: number,
    timeoutMs: number,
  ) => Promise<CliOpenShellLegacyForwardInspection>;
  now?: () => number;
  platform?: NodeJS.Platform;
  pollIntervalMs?: number;
  procRoot?: string;
  procWorkLimit?: number;
  probePort?: CliOpenShellForwardPortProbe;
  hostProbe?: CliOpenShellForwardCommandRunner;
  run?: CliOpenShellForwardCommandRunner;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  spawn?: (
    executable: string,
    args: readonly string[],
    options: Readonly<{
      detached: true;
      environment: NodeJS.ProcessEnv;
      shell: false;
      stdio: "ignore";
    }>,
  ) => CliOpenShellForwardChild;
  terminate?: (child: CliOpenShellForwardChild, timeoutMs: number) => Promise<boolean>;
}>;

export type CliOpenShellLegacyForwardRow = Readonly<{
  sandboxName: string;
  bind: "127.0.0.1" | "0.0.0.0";
  port: number;
  pid: number;
  status: "running" | "dead";
}>;

export type CliOpenShellForwardListParseResult =
  | Readonly<{ ok: true; rows: readonly CliOpenShellLegacyForwardRow[] }>
  | Readonly<{ ok: false; error: OpenShellForwardRuntimeError }>;

function stripTerminalFormatting(value: string): string | null {
  const stripped = value.replace(TERMINAL_SGR_RE, "");
  return TERMINAL_CONTROL_RE.test(stripped) ? null : stripped;
}

/** Parse the complete OpenShell 0.0.116 legacy forward table. */
export function parseCliOpenShellForwardList(
  stdout: string,
  stderr: string,
): CliOpenShellForwardListParseResult {
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > DEFAULT_OUTPUT_LIMIT_BYTES) {
    return { ok: false, error: SCHEMA_ERROR };
  }
  const cleanStdout = stripTerminalFormatting(stdout);
  const cleanStderr = stripTerminalFormatting(stderr);
  if (cleanStdout === null || cleanStderr === null) return { ok: false, error: SCHEMA_ERROR };
  const output = cleanStdout.trim();
  const diagnostic = cleanStderr.trim();
  if (!output && diagnostic === "No active forwards.") return { ok: true, rows: [] };
  if (!output || diagnostic) return { ok: false, error: SCHEMA_ERROR };

  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  if (lines.some((line) => line.length === 0)) return { ok: false, error: SCHEMA_ERROR };
  if (lines.shift()?.split(/\s+/u).join(" ") !== "SANDBOX BIND PORT PID STATUS") {
    return { ok: false, error: SCHEMA_ERROR };
  }
  if (lines.length === 0) return { ok: false, error: SCHEMA_ERROR };
  const rows: CliOpenShellLegacyForwardRow[] = [];
  const occupiedPorts = new Set<number>();
  for (const line of lines) {
    const columns = line.split(/\s+/u);
    if (columns.length !== 5) return { ok: false, error: SCHEMA_ERROR };
    const [sandboxName, bind, portText, pidText, status] = columns;
    const port = Number(portText);
    const pid = Number(pidText);
    if (
      !sandboxName ||
      !isValidName(sandboxName) ||
      (bind !== "127.0.0.1" && bind !== "0.0.0.0") ||
      !/^[1-9]\d*$/u.test(portText ?? "") ||
      !Number.isSafeInteger(port) ||
      port > 65_535 ||
      !/^[1-9]\d*$/u.test(pidText ?? "") ||
      !Number.isSafeInteger(pid) ||
      (status !== "running" && status !== "dead") ||
      occupiedPorts.has(port)
    ) {
      return { ok: false, error: SCHEMA_ERROR };
    }
    occupiedPorts.add(port);
    rows.push({ sandboxName, bind, port, pid, status });
  }
  return { ok: true, rows };
}

/** Build the gateway-scoped legacy forward-list command. */
export function buildCliOpenShellForwardListArgs(forward: OpenShellForwardIdentity): string[] {
  return ["forward", "list", "--gateway", forward.gatewayName, "--workspace", forward.workspace];
}

/** Build the direct ForwardTcp command without a shell. */
export function buildCliOpenShellForwardServiceArgs(forward: OpenShellForwardIdentity): string[] {
  return [
    "--gateway",
    forward.gatewayName,
    "--workspace",
    forward.workspace,
    "forward",
    "service",
    forward.sandboxName,
    "--target-port",
    String(forward.port),
    "--target-host",
    "127.0.0.1",
    "--local",
    `${forward.localHost}:${String(forward.port)}`,
  ];
}

/** Build the authority-scoped legacy stop command. */
export function buildCliOpenShellLegacyForwardStopArgs(
  forward: OpenShellForwardIdentity,
): string[] {
  return [
    "forward",
    "stop",
    String(forward.port),
    forward.sandboxName,
    "--gateway",
    forward.gatewayName,
    "--workspace",
    forward.workspace,
  ];
}

function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function isCanonicalNemoClawGatewayName(value: string): boolean {
  if (value === "nemoclaw") return true;
  const match = /^nemoclaw-([1-9]\d{0,4})$/u.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 && port !== 8_080;
}

function validForward(forward: OpenShellForwardIdentity): boolean {
  return (
    isCanonicalNemoClawGatewayName(forward.gatewayName) &&
    isValidName(forward.workspace) &&
    isValidName(forward.sandboxName) &&
    (forward.localHost === "127.0.0.1" || forward.localHost === "0.0.0.0") &&
    isPort(forward.port)
  );
}

function validTimeout(timeoutMs: number | undefined): boolean {
  return (
    timeoutMs === undefined ||
    (Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_TIMER_TIMEOUT_MS)
  );
}

function sameScope(forwards: readonly OpenShellForwardIdentity[]): boolean {
  const [first] = forwards;
  return (
    first === undefined ||
    forwards.every(
      (forward) =>
        forward.gatewayName === first.gatewayName && forward.workspace === first.workspace,
    )
  );
}

function validBatch(
  forwards: readonly OpenShellForwardIdentity[],
  timeoutMs: number | undefined,
): boolean {
  return (
    validTimeout(timeoutMs) &&
    sameScope(forwards) &&
    forwards.every(validForward) &&
    new Set(forwards.map((forward) => forward.port)).size === forwards.length
  );
}

function snapshotForward(forward: OpenShellForwardIdentity): OpenShellForwardIdentity {
  return Object.freeze({
    gatewayName: forward.gatewayName,
    workspace: forward.workspace,
    sandboxName: forward.sandboxName,
    localHost: forward.localHost,
    port: forward.port,
  });
}

function snapshotForwards(
  forwards: readonly OpenShellForwardIdentity[],
): readonly OpenShellForwardIdentity[] {
  return Object.freeze(forwards.map(snapshotForward));
}

function indeterminate(
  forward: OpenShellForwardIdentity,
  error: OpenShellForwardRuntimeError,
): Extract<
  OpenShellForwardObservation,
  Readonly<{ state: "indeterminate"; forward: OpenShellForwardIdentity }>
> {
  return { state: "indeterminate", forward, error };
}

function allIndeterminate(
  forwards: readonly OpenShellForwardIdentity[],
  error: OpenShellForwardRuntimeError,
): readonly OpenShellForwardObservation[] {
  return forwards.map((forward) => indeterminate(forward, error));
}

function invalidObservations(count: number): readonly OpenShellForwardObservation[] {
  return Array.from({ length: count }, () => ({
    state: "indeterminate" as const,
    error: VALIDATION_ERROR,
  }));
}

function commandError(
  result: CliOpenShellForwardCommandResult,
): OpenShellForwardRuntimeError | null {
  if (
    result.timedOut ||
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  ) {
    return TIMEOUT_ERROR;
  }
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || errorCode === "ENOBUFS") {
    return SCHEMA_ERROR;
  }
  if (errorCode === "ENOENT" || errorCode === "EACCES") return TRANSPORT_ERROR;
  if (!result.signal && result.status === 0 && !result.error) return null;
  const output = `${result.stderr}\n${result.stdout}`;
  if (/invalid wire type|proto(?:buf)?(?: decode| schema| wire)/iu.test(output)) {
    return SCHEMA_ERROR;
  }
  if (
    /\b(?:authentication failed|unauthorized|forbidden|permission denied|missing gateway auth token|device identity required|invalid token|expired token)\b/iu.test(
      output,
    )
  ) {
    return AUTHENTICATION_ERROR;
  }
  if (result.signal || result.status === null || result.error) return TRANSPORT_ERROR;
  return COMMAND_ERROR;
}

function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv | null {
  const sourceConfigHome = source.XDG_CONFIG_HOME;
  const configHome = sourceConfigHome?.trim();
  if (
    sourceConfigHome !== undefined &&
    sourceConfigHome !== "" &&
    (sourceConfigHome !== configHome || !path.isAbsolute(configHome) || configHome.includes("\0"))
  ) {
    return null;
  }
  const environment = buildOpenShellSubprocessEnv(source);
  if (environment.XDG_CONFIG_HOME === "") delete environment.XDG_CONFIG_HOME;
  return environment;
}

async function defaultRun(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    environment: NodeJS.ProcessEnv;
    outputLimitBytes: number;
    timeoutMs: number;
  }>,
): Promise<CliOpenShellForwardCommandResult> {
  const result = await captureOpenshellCommandAsyncResult(executable, args, {
    environment: options.environment,
    outputLimitBytes: options.outputLimitBytes,
    timeoutKillSignal: "SIGKILL",
    timeoutMilliseconds: options.timeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

type PidInspection = Readonly<{ ok: true; pids: readonly number[] }> | Readonly<{ ok: false }>;

async function runPidProbe(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  run: CliOpenShellForwardCommandRunner,
): Promise<CliOpenShellForwardCommandResult> {
  return run(executable, args, {
    environment,
    outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
    timeoutMs,
  });
}

function parseListenerPids(output: string): number[] | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.some((line) => !/^[1-9]\d*$/u.test(line))) return null;
  const pids = [...new Set(lines.map(Number))];
  return pids.every((pid) => Number.isSafeInteger(pid)) ? pids : null;
}

function parseDarwinProcessImage(output: string, expectedPid: number): string | null {
  if (Buffer.byteLength(output) > DEFAULT_OUTPUT_LIMIT_BYTES) return null;
  const lines = output.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== `p${String(expectedPid)}` || lines.length < 3 || lines.length % 2 !== 1) {
    return null;
  }
  const imagePaths: string[] = [];
  for (let index = 1; index < lines.length; index += 2) {
    const descriptor = lines[index];
    const name = lines[index + 1];
    if (descriptor !== "ftxt" || !name?.startsWith("n/")) return null;
    const imagePath = name.slice(1);
    if (!path.isAbsolute(imagePath) || imagePath.includes("\0")) return null;
    imagePaths.push(imagePath);
  }
  return new Set(imagePaths).size === imagePaths.length ? (imagePaths[0] ?? null) : null;
}

async function lsofListenerPids(
  port: number,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  run: CliOpenShellForwardCommandRunner,
): Promise<PidInspection | "unavailable"> {
  const result = await runPidProbe(
    platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
    [`-ti4TCP:${String(port)}`, "-sTCP:LISTEN"],
    environment,
    timeoutMs,
    run,
  );
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "unavailable";
  if (
    result.status === 1 &&
    !result.timedOut &&
    !result.error &&
    !result.stdout.trim() &&
    !result.stderr.trim()
  ) {
    return { ok: true, pids: [] };
  }
  if (
    result.status !== 0 ||
    result.timedOut ||
    result.error ||
    result.signal ||
    result.stderr.trim()
  ) {
    return { ok: false };
  }
  const pids = parseListenerPids(result.stdout);
  return pids === null || pids.length === 0 ? { ok: false } : { ok: true, pids };
}

async function linuxListenerPids(
  port: number,
  procRoot: string,
  workLimit: number,
  timeoutMs: number,
): Promise<PidInspection> {
  if (
    !Number.isSafeInteger(workLimit) ||
    workLimit < 1 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return { ok: false };
  }
  const deadline = performance.now() + timeoutMs;
  const bounded = async <T>(operation: () => Promise<T>) => {
    const available = deadline - performance.now();
    if (available <= 0) return { state: "timeout" } as const;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation().then(
          (value) => ({ state: "value", value }) as const,
          (error: unknown) => ({ state: "error", error }) as const,
        ),
        new Promise<{ readonly state: "timeout" }>((resolve) => {
          timeout = setTimeout(() => resolve({ state: "timeout" }), available);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const portSuffix = `:${port.toString(16).padStart(4, "0").toUpperCase()}`;
  const tcpRead = await bounded(() => readFile(path.join(procRoot, "net", "tcp"), "utf8"));
  if (tcpRead.state !== "value") return { ok: false };
  if (Buffer.byteLength(tcpRead.value) > DEFAULT_OUTPUT_LIMIT_BYTES) return { ok: false };
  const tcpLines = tcpRead.value.split(/\r?\n/u).filter((line) => line.trim());
  const header = tcpLines.shift()?.trim().split(/\s+/u);
  const expectedHeader = [
    "sl",
    "local_address",
    "rem_address",
    "st",
    "tx_queue",
    "rx_queue",
    "tr",
    "tm->when",
    "retrnsmt",
    "uid",
    "timeout",
    "inode",
  ];
  if (!header || expectedHeader.some((field, index) => header[index] !== field)) {
    return { ok: false };
  }
  const socketInodes = new Set<string>();
  for (const line of tcpLines) {
    const fields = line.trim().split(/\s+/u);
    if (
      !/^\d+:$/u.test(fields[0] ?? "") ||
      !/^[0-9A-F]{8}:[0-9A-F]{4}$/iu.test(fields[1] ?? "") ||
      !/^[0-9A-F]{8}:[0-9A-F]{4}$/iu.test(fields[2] ?? "") ||
      !/^[0-9A-F]{2}$/iu.test(fields[3] ?? "") ||
      !/^[0-9A-F]{8}:[0-9A-F]{8}$/iu.test(fields[4] ?? "") ||
      !/^[0-9A-F]{2}:[0-9A-F]{8}$/iu.test(fields[5] ?? "") ||
      !/^[0-9A-F]{8}$/iu.test(fields[6] ?? "") ||
      !/^\d+$/u.test(fields[7] ?? "") ||
      !/^\d+$/u.test(fields[8] ?? "") ||
      !/^\d+$/u.test(fields[9] ?? "")
    ) {
      return { ok: false };
    }
    if (
      fields[3] === "0A" &&
      fields[1]?.toUpperCase().endsWith(portSuffix) &&
      /^\d+$/u.test(fields[9] ?? "")
    ) {
      socketInodes.add(fields[9]);
    }
  }
  if (socketInodes.size === 0) return { ok: true, pids: [] };

  const pids = new Set<number>();
  let inspected = 0;
  let incomplete = false;
  const rootRead = await bounded(() => readdir(procRoot, { withFileTypes: true }));
  if (rootRead.state !== "value") return { ok: false };
  const entries = rootRead.value;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue;
    if (++inspected > workLimit) return { ok: false };
    const descriptorsRead = await bounded(() => readdir(path.join(procRoot, entry.name, "fd")));
    if (descriptorsRead.state === "timeout") return { ok: false };
    if (descriptorsRead.state === "error") {
      if ((descriptorsRead.error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
      continue;
    }
    const descriptors = descriptorsRead.value;
    for (const descriptor of descriptors) {
      if (++inspected > workLimit) return { ok: false };
      const linkRead = await bounded(() =>
        readlink(path.join(procRoot, entry.name, "fd", descriptor)),
      );
      if (linkRead.state === "timeout") return { ok: false };
      if (linkRead.state === "value") {
        const link = linkRead.value;
        const match = /^socket:\[(\d+)\]$/u.exec(link);
        if (match?.[1] && socketInodes.has(match[1])) {
          pids.add(Number(entry.name));
          break;
        }
      } else if ((linkRead.error as NodeJS.ErrnoException).code !== "ENOENT") {
        incomplete = true;
      }
    }
  }
  if (incomplete || pids.size === 0) return { ok: false };
  return { ok: true, pids: [...pids] };
}

async function listenerPids(
  forward: OpenShellForwardIdentity,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  procRoot: string,
  procWorkLimit: number,
  timeoutMs: number,
  run: CliOpenShellForwardCommandRunner,
): Promise<PidInspection> {
  const lsof = await lsofListenerPids(forward.port, platform, environment, timeoutMs, run);
  if (lsof !== "unavailable" || platform !== "linux") {
    return lsof === "unavailable" ? { ok: false } : lsof;
  }
  return linuxListenerPids(forward.port, procRoot, procWorkLimit, timeoutMs);
}

async function executableMatch(
  actual: string,
  expected: string,
): Promise<"match" | "mismatch" | "indeterminate"> {
  try {
    return (await realpath(actual)) === (await realpath(expected)) ? "match" : "mismatch";
  } catch {
    return "indeterminate";
  }
}

async function processExecutableMatch(
  pid: number,
  expectedExecutable: string,
  timeoutMs: number,
  options: Readonly<{
    environment: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    procRoot: string;
    run: CliOpenShellForwardCommandRunner;
  }>,
): Promise<"match" | "mismatch" | "indeterminate"> {
  if (options.platform === "linux") {
    return executableMatch(path.join(options.procRoot, String(pid), "exe"), expectedExecutable);
  }
  if (options.platform !== "darwin") return "indeterminate";
  const image = await runPidProbe(
    "/usr/sbin/lsof",
    ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
    options.environment,
    timeoutMs,
    options.run,
  );
  if (image.status !== 0 || image.timedOut || image.error || image.signal || image.stderr.trim()) {
    return "indeterminate";
  }
  const imagePath = parseDarwinProcessImage(image.stdout, pid);
  return imagePath === null ? "indeterminate" : executableMatch(imagePath, expectedExecutable);
}

async function inspectForward(
  forward: OpenShellForwardIdentity,
  expectedPid: number | undefined,
  timeoutMs: number,
  options: Readonly<{
    environment: NodeJS.ProcessEnv;
    executable: string;
    now: () => number;
    platform: NodeJS.Platform;
    procRoot: string;
    procWorkLimit: number;
    run: CliOpenShellForwardCommandRunner;
  }>,
): Promise<CliOpenShellForwardInspection> {
  if (options.platform === "win32") return { state: "indeterminate" };
  const deadline = options.now() + timeoutMs;
  const listener = await listenerPids(
    forward,
    options.platform,
    options.environment,
    options.procRoot,
    options.procWorkLimit,
    remaining(deadline, options.now),
    options.run,
  );
  if (!listener.ok) return { state: "indeterminate" };
  if (listener.pids.length === 0) return { state: "unbound" };
  if (listener.pids.length !== 1) return { state: "indeterminate" };
  const [pid] = listener.pids;
  if (pid === undefined) return { state: "indeterminate" };
  if (options.now() >= deadline) return { state: "indeterminate" };
  let processState: "owned" | "foreign" | "indeterminate" =
    expectedPid === undefined || pid === expectedPid ? "owned" : "foreign";

  if (processState === "owned") {
    const executable = await processExecutableMatch(
      pid,
      options.executable,
      remaining(deadline, options.now),
      options,
    );
    if (executable === "indeterminate") processState = "indeterminate";
    if (executable === "mismatch") processState = "foreign";
  }

  if (processState === "owned") {
    if (options.now() >= deadline) return { state: "indeterminate" };
    const command = await runPidProbe(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "args="],
      options.environment,
      remaining(deadline, options.now),
      options.run,
    );
    if (
      command.status !== 0 ||
      command.timedOut ||
      command.error ||
      command.signal ||
      command.stderr.trim()
    ) {
      processState = "indeterminate";
    } else {
      const expectedCommand = [
        options.executable,
        ...buildCliOpenShellForwardServiceArgs(forward),
      ].join(" ");
      if (command.stdout.trim() !== expectedCommand) processState = "foreign";
    }
  }

  const stable = await listenerPids(
    forward,
    options.platform,
    options.environment,
    options.procRoot,
    options.procWorkLimit,
    remaining(deadline, options.now),
    options.run,
  );
  if (!stable.ok || stable.pids.length !== 1 || stable.pids[0] !== pid) {
    return { state: "indeterminate" };
  }
  if (options.now() >= deadline) return { state: "indeterminate" };
  if (processState === "owned") return { state: "owned", pid };
  if (processState === "foreign") return { state: "foreign", pids: [pid] };
  return { state: "indeterminate" };
}

async function inspectLegacyForward(
  forward: OpenShellForwardIdentity,
  expectedPid: number,
  timeoutMs: number,
  options: Readonly<{
    environment: NodeJS.ProcessEnv;
    now: () => number;
    platform: NodeJS.Platform;
    procRoot: string;
    procWorkLimit: number;
    run: CliOpenShellForwardCommandRunner;
  }>,
): Promise<CliOpenShellLegacyForwardInspection> {
  if (options.platform === "win32") return { state: "indeterminate" };
  const deadline = options.now() + timeoutMs;
  const inspect = () =>
    listenerPids(
      forward,
      options.platform,
      options.environment,
      options.procRoot,
      options.procWorkLimit,
      remaining(deadline, options.now),
      options.run,
    );
  const before = await inspect();
  if (!before.ok) return { state: "indeterminate" };
  if (before.pids.length !== 1 || before.pids[0] !== expectedPid) {
    return { state: "not_owned" };
  }
  if (options.now() >= deadline) return { state: "indeterminate" };
  const after = await inspect();
  if (!after.ok) return { state: "indeterminate" };
  if (options.now() >= deadline) return { state: "indeterminate" };
  return after.pids.length === 1 && after.pids[0] === expectedPid
    ? { state: "owned", pid: expectedPid }
    : { state: "not_owned" };
}

async function probePort(
  forward: OpenShellForwardIdentity,
  timeoutMs: number,
): Promise<CliOpenShellForwardPortInspection> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port: forward.port });
    const finish = (result: CliOpenShellForwardPortInspection) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(Math.max(1, timeoutMs));
    socket.once("connect", () => finish({ state: "bound" }));
    socket.once("timeout", () => finish({ state: "indeterminate", error: TIMEOUT_ERROR }));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ECONNREFUSED"
          ? { state: "unbound" }
          : { state: "indeterminate", error: TRANSPORT_ERROR },
      ),
    );
  });
}

async function processGroupHasRunnableMember(
  pid: number,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  run: CliOpenShellForwardCommandRunner,
): Promise<boolean | null> {
  const result = await runPidProbe("/bin/ps", ["-axo", "pgid=,stat="], environment, timeoutMs, run);
  if (
    result.status !== 0 ||
    result.timedOut ||
    result.error ||
    result.signal ||
    result.stderr.trim()
  ) {
    return null;
  }
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim());
  const processes = lines.map((line) => /^\s*([1-9]\d*)\s+(\S+)\s*$/u.exec(line));
  if (processes.length === 0 || processes.some((process) => process === null)) return null;
  return processes.some(
    (process) => Number(process?.[1]) === pid && !process?.[2]?.startsWith("Z"),
  );
}

function noSuchProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
}

async function terminateProcessTree(
  child: CliOpenShellForwardChild,
  timeoutMs: number,
  options: Readonly<{
    environment: NodeJS.ProcessEnv;
    now: () => number;
    platform: NodeJS.Platform;
    run: CliOpenShellForwardCommandRunner;
    signalProcess: (pid: number, signal: NodeJS.Signals) => void;
    sleep: (milliseconds: number) => Promise<void>;
  }>,
): Promise<boolean> {
  const pid = child.pid;
  if (
    options.platform === "win32" ||
    !Number.isSafeInteger(pid) ||
    Number(pid) <= 1 ||
    pid === process.pid
  ) {
    return false;
  }
  try {
    options.signalProcess(-Number(pid), "SIGKILL");
  } catch (error) {
    if (noSuchProcess(error)) return true;
    return false;
  }
  const deadline = options.now() + timeoutMs;
  do {
    const running = await processGroupHasRunnableMember(
      Number(pid),
      options.environment,
      Math.max(1, deadline - options.now()),
      options.run,
    );
    if (running === false) return true;
    if (running === null) return false;
    await options.sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(1, deadline - options.now())));
  } while (options.now() < deadline);
  return (
    (await processGroupHasRunnableMember(Number(pid), options.environment, 1, options.run)) ===
    false
  );
}

function spawnDetached(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    detached: true;
    environment: NodeJS.ProcessEnv;
    shell: false;
    stdio: "ignore";
  }>,
): CliOpenShellForwardChild {
  return spawn(executable, [...args], {
    detached: options.detached,
    env: options.environment,
    shell: options.shell,
    stdio: options.stdio,
  });
}

type CliOpenShellForwardRegistryMatch =
  | Readonly<{ state: "direct" }>
  | Readonly<{
      state: "legacy";
      relation: "exact" | "conflicting";
      row: CliOpenShellLegacyForwardRow;
    }>
  | Readonly<{ state: "indeterminate" }>;

function classifyRegistry(
  forward: OpenShellForwardIdentity,
  rows: readonly CliOpenShellLegacyForwardRow[],
): CliOpenShellForwardRegistryMatch {
  const samePort = rows.filter((row) => row.port === forward.port);
  const sameTarget = samePort.filter(
    (row) => row.sandboxName === forward.sandboxName && row.bind === forward.localHost,
  );
  if (samePort.length > 1 || sameTarget.length > 1) return { state: "indeterminate" };
  const legacy = samePort[0];
  if (!legacy) return { state: "direct" };
  return {
    state: "legacy",
    relation: sameTarget[0] === legacy ? "exact" : "conflicting",
    row: legacy,
  };
}

function classifyDirectInspection(
  forward: OpenShellForwardIdentity,
  inspection: CliOpenShellForwardInspection,
): OpenShellForwardObservation {
  if (inspection.state === "unbound") return { state: "absent", forward };
  if (inspection.state === "owned") return { state: "owned", forward };
  if (inspection.state === "foreign") return { state: "foreign", forward };
  return indeterminate(forward, OWNERSHIP_ERROR);
}

function remaining(deadline: number, now: () => number): number {
  return Math.max(1, Math.floor(deadline - now()));
}

/** Create the sole CLI-backed OpenShell forwarding implementation. */
export function createCliOpenShellForwardAdapter(
  deps: CliOpenShellForwardAdapterDeps,
): OpenShellForwardAdapter {
  const executable = deps.executable;
  const platform = deps.platform ?? process.platform;
  const sourceEnvironment = deps.environment ?? process.env;
  const environment = commandEnvironment(sourceEnvironment);
  const hostEnvironment: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  const now = deps.now ?? (() => performance.now());
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollIntervalMs =
    deps.pollIntervalMs !== undefined &&
    Number.isSafeInteger(deps.pollIntervalMs) &&
    deps.pollIntervalMs > 0 &&
    deps.pollIntervalMs <= MAX_TIMER_TIMEOUT_MS
      ? deps.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
  const run = deps.run ?? defaultRun;
  const hostProbe = deps.hostProbe ?? defaultRun;
  const portProbe = deps.probePort ?? probePort;
  const signalProcess =
    deps.signalProcess ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });
  const inspect =
    deps.inspect ??
    ((forward, expectedPid, timeoutMs) =>
      inspectForward(forward, expectedPid, timeoutMs, {
        environment: hostEnvironment,
        executable,
        now,
        platform,
        procRoot: deps.procRoot ?? "/proc",
        procWorkLimit: deps.procWorkLimit ?? DEFAULT_PROC_WORK_LIMIT,
        run: hostProbe,
      }));
  const inspectLegacy =
    deps.inspectLegacy ??
    ((forward, expectedPid, timeoutMs) =>
      inspectLegacyForward(forward, expectedPid, timeoutMs, {
        environment: hostEnvironment,
        now,
        platform,
        procRoot: deps.procRoot ?? "/proc",
        procWorkLimit: deps.procWorkLimit ?? DEFAULT_PROC_WORK_LIMIT,
        run: hostProbe,
      }));
  const spawnForward = deps.spawn ?? spawnDetached;
  const terminate =
    deps.terminate ??
    ((child, timeoutMs) =>
      terminateProcessTree(child, timeoutMs, {
        environment: hostEnvironment,
        now,
        platform,
        run: hostProbe,
        signalProcess,
        sleep,
      }));

  const runtimeValid =
    path.isAbsolute(executable) && !executable.includes("\0") && environment !== null;

  type TimedSettlement<T> =
    | Readonly<{ state: "value"; value: T }>
    | Readonly<{ state: "error"; error: unknown }>
    | Readonly<{ state: "timeout" }>;

  const settleWithin = async <T>(
    operation: () => Promise<T>,
    timeoutMs: number,
  ): Promise<TimedSettlement<T>> => {
    if (timeoutMs <= 0) return { state: "timeout" };
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      return { state: "error", error };
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending.then(
          (value) => ({ state: "value", value }) as const,
          (error: unknown) => ({ state: "error", error }) as const,
        ),
        new Promise<Readonly<{ state: "timeout" }>>((resolve) => {
          timeout = setTimeout(() => resolve({ state: "timeout" }), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const failedCommand = (error: unknown): CliOpenShellForwardCommandResult => ({
    status: null,
    stdout: "",
    stderr: "",
    error: error instanceof Error ? error : new Error("OpenShell command invocation failed"),
  });
  const runSafely = async (
    args: readonly string[],
    timeoutMs: number,
  ): Promise<CliOpenShellForwardCommandResult> => {
    const settled = await settleWithin(
      () =>
        run(executable, args, {
          environment: environment ?? {},
          outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
          timeoutMs,
        }),
      timeoutMs,
    );
    if (settled.state === "value") return settled.value;
    if (settled.state === "timeout") {
      return {
        status: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      };
    }
    return failedCommand(settled.error);
  };
  const inspectSafely = async (
    forward: OpenShellForwardIdentity,
    expectedPid: number | undefined,
    timeoutMs: number,
  ): Promise<CliOpenShellForwardInspection> => {
    const settled = await settleWithin(() => inspect(forward, expectedPid, timeoutMs), timeoutMs);
    return settled.state === "value" ? settled.value : { state: "indeterminate" };
  };
  const inspectLegacySafely = async (
    forward: OpenShellForwardIdentity,
    expectedPid: number,
    timeoutMs: number,
  ): Promise<CliOpenShellLegacyForwardInspection> => {
    const settled = await settleWithin(
      () => inspectLegacy(forward, expectedPid, timeoutMs),
      timeoutMs,
    );
    return settled.state === "value" ? settled.value : { state: "indeterminate" };
  };
  const probePortSafely = async (
    forward: OpenShellForwardIdentity,
    timeoutMs: number,
  ): Promise<CliOpenShellForwardPortInspection> => {
    const settled = await settleWithin(() => portProbe(forward, timeoutMs), timeoutMs);
    if (settled.state === "value") return settled.value;
    return {
      state: "indeterminate",
      error: settled.state === "timeout" ? TIMEOUT_ERROR : TRANSPORT_ERROR,
    };
  };
  const runFence = async (
    fence: (() => Promise<void>) | undefined,
    deadline: number,
  ): Promise<OpenShellForwardRuntimeError | null> => {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) return TIMEOUT_ERROR;
    if (!fence) return null;
    const result = await settleWithin(fence, timeoutMs);
    if (result.state === "timeout" || now() >= deadline) return TIMEOUT_ERROR;
    return result.state === "value" ? null : AUTHORITY_ERROR;
  };

  type ObservationEvidence = Readonly<{
    observations: readonly OpenShellForwardObservation[];
    legacyPids: ReadonlyMap<number, number>;
    ownedPids: ReadonlyMap<number, number>;
  }>;

  async function observeWithEvidence(
    request: ObserveOpenShellForwardsRequest,
  ): Promise<ObservationEvidence> {
    const forwards = snapshotForwards(request.forwards);
    const requestedTimeoutMs = request.timeoutMs;
    const assertCurrent = request.assertCurrent;
    const emptyEvidence = (observations: readonly OpenShellForwardObservation[]) => ({
      observations,
      legacyPids: new Map<number, number>(),
      ownedPids: new Map<number, number>(),
    });
    if (forwards.length === 0) return emptyEvidence([]);
    if (!runtimeValid || !validBatch(forwards, requestedTimeoutMs)) {
      return emptyEvidence(invalidObservations(forwards.length));
    }
    if (platform === "win32") {
      return emptyEvidence(allIndeterminate(forwards, OWNERSHIP_ERROR));
    }
    const timeoutMs = requestedTimeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS;
    const deadline = now() + timeoutMs;
    const [scope] = forwards;
    if (!scope || !environment) {
      return emptyEvidence(invalidObservations(forwards.length));
    }
    const beforeList = await runFence(assertCurrent, deadline);
    if (beforeList) return emptyEvidence(allIndeterminate(forwards, beforeList));
    const result = await runSafely(
      buildCliOpenShellForwardListArgs(scope),
      remaining(deadline, now),
    );
    const error = commandError(result);
    if (error) {
      await runFence(assertCurrent, deadline);
      return emptyEvidence(allIndeterminate(forwards, error));
    }
    const parsed = parseCliOpenShellForwardList(result.stdout, result.stderr);
    if (!parsed.ok) {
      await runFence(assertCurrent, deadline);
      return emptyEvidence(allIndeterminate(forwards, parsed.error));
    }
    const afterList = await runFence(assertCurrent, deadline);
    if (afterList) return emptyEvidence(allIndeterminate(forwards, afterList));

    const evidence = await Promise.all(
      forwards.map(async (forward) => {
        if (now() >= deadline) {
          return { observation: indeterminate(forward, TIMEOUT_ERROR) };
        }
        const registry = classifyRegistry(forward, parsed.rows);
        if (registry.state === "indeterminate") {
          return { observation: indeterminate(forward, SCHEMA_ERROR) };
        }
        if (registry.state === "legacy") {
          if (registry.row.status !== "running") {
            return { observation: indeterminate(forward, OWNERSHIP_ERROR) };
          }
          const legacy = await inspectLegacySafely(
            forward,
            registry.row.pid,
            remaining(deadline, now),
          );
          if (legacy.state !== "owned" || legacy.pid !== registry.row.pid) {
            return { observation: indeterminate(forward, OWNERSHIP_ERROR) };
          }
          return registry.relation === "exact"
            ? {
                observation: { state: "stale", forward } as const,
                legacyPid: registry.row.pid,
              }
            : { observation: { state: "foreign", forward } as const };
        }
        const direct = await inspectSafely(forward, undefined, remaining(deadline, now));
        if (direct.state === "unbound") {
          const beforeReachability = await runFence(assertCurrent, deadline);
          if (beforeReachability) {
            return { observation: indeterminate(forward, beforeReachability) };
          }
          const reachability = await probePortSafely(forward, remaining(deadline, now));
          const afterReachability = await runFence(assertCurrent, deadline);
          if (afterReachability) {
            return { observation: indeterminate(forward, afterReachability) };
          }
          if (reachability.state === "indeterminate") {
            return { observation: indeterminate(forward, reachability.error) };
          }
          return {
            observation:
              reachability.state === "unbound"
                ? ({ state: "absent", forward } as const)
                : indeterminate(forward, OWNERSHIP_ERROR),
          };
        }
        return direct.state === "owned"
          ? {
              observation: { state: "owned", forward } as const,
              ownedPid: direct.pid,
            }
          : { observation: classifyDirectInspection(forward, direct) };
      }),
    );
    const afterInspectors = await runFence(assertCurrent, deadline);
    if (afterInspectors) {
      return emptyEvidence(allIndeterminate(forwards, afterInspectors));
    }
    return {
      observations: evidence.map(({ observation }) => observation),
      legacyPids: new Map(
        evidence.flatMap((item, index) => {
          const target = forwards[index];
          return item.legacyPid === undefined || target === undefined
            ? []
            : [[target.port, item.legacyPid] as const];
        }),
      ),
      ownedPids: new Map(
        evidence.flatMap((item, index) => {
          const target = forwards[index];
          return item.ownedPid === undefined || target === undefined
            ? []
            : [[target.port, item.ownedPid] as const];
        }),
      ),
    };
  }

  async function observeForwards(
    request: ObserveOpenShellForwardsRequest,
  ): Promise<readonly OpenShellForwardObservation[]> {
    return (await observeWithEvidence(request)).observations;
  }

  type ForwardReadiness =
    | Readonly<{ state: "ready" }>
    | Readonly<{ state: "pending" }>
    | Readonly<{ state: "foreign" }>
    | Readonly<{ state: "indeterminate"; error: OpenShellForwardRuntimeError }>;

  const proveForwardReady = async (
    forward: OpenShellForwardIdentity,
    expectedPid: number,
    deadline: number,
    assertCurrent: (() => Promise<void>) | undefined,
    initialOwnerProved: boolean,
  ): Promise<ForwardReadiness> => {
    if (!initialOwnerProved) {
      const beforeOwner = await runFence(assertCurrent, deadline);
      if (beforeOwner) return { state: "indeterminate", error: beforeOwner };
      const owner = await inspectSafely(forward, expectedPid, remaining(deadline, now));
      const afterOwner = await runFence(assertCurrent, deadline);
      if (afterOwner) return { state: "indeterminate", error: afterOwner };
      if (owner.state === "foreign" || (owner.state === "owned" && owner.pid !== expectedPid)) {
        return { state: "foreign" };
      }
      if (owner.state === "unbound") return { state: "pending" };
      if (owner.state !== "owned") {
        return { state: "indeterminate", error: OWNERSHIP_ERROR };
      }
    }

    const beforeReachability = await runFence(assertCurrent, deadline);
    if (beforeReachability) return { state: "indeterminate", error: beforeReachability };
    const reachability = await probePortSafely(forward, remaining(deadline, now));
    const afterReachability = await runFence(assertCurrent, deadline);
    if (afterReachability) return { state: "indeterminate", error: afterReachability };
    if (reachability.state === "indeterminate") {
      return { state: "indeterminate", error: reachability.error };
    }
    if (reachability.state === "unbound") return { state: "pending" };

    const beforeConfirmation = await runFence(assertCurrent, deadline);
    if (beforeConfirmation) return { state: "indeterminate", error: beforeConfirmation };
    const confirmed = await inspectSafely(forward, expectedPid, remaining(deadline, now));
    const afterConfirmation = await runFence(assertCurrent, deadline);
    if (afterConfirmation) return { state: "indeterminate", error: afterConfirmation };
    if (
      confirmed.state === "foreign" ||
      (confirmed.state === "owned" && confirmed.pid !== expectedPid)
    ) {
      return { state: "foreign" };
    }
    return confirmed.state === "owned"
      ? { state: "ready" }
      : { state: "indeterminate", error: OWNERSHIP_ERROR };
  };

  async function cleanFailedStart(
    forward: OpenShellForwardIdentity,
    child: CliOpenShellForwardChild,
  ): Promise<OpenShellForwardStartResult | null> {
    const deadline = now() + DEFAULT_CLEANUP_TIMEOUT_MS;
    const termination = await settleWithin(
      () => terminate(child, remaining(deadline, now)),
      remaining(deadline, now),
    );
    const settled = termination.state === "value" && termination.value;
    if (settled) {
      const release = await verifyForwardRelease({
        forwards: [forward],
        timeoutMs: remaining(deadline, now),
      });
      if (release.state === "released") return null;
    }
    child.unref();
    return {
      state: "cleanup_uncertain",
      forward,
      effect: "possible",
      error: CLEANUP_ERROR,
    };
  }

  async function startForward(
    request: StartOpenShellForwardRequest,
  ): Promise<OpenShellForwardStartResult> {
    const forward = snapshotForward(request.forward);
    const requestedTimeoutMs = request.timeoutMs;
    const assertCurrent = request.assertCurrent;
    const timeoutMs = requestedTimeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS;
    if (!runtimeValid || !validBatch([forward], requestedTimeoutMs)) {
      return { state: "failed", effect: "none", error: VALIDATION_ERROR };
    }
    if (platform === "win32") {
      return { state: "failed", forward, effect: "none", error: OWNERSHIP_ERROR };
    }
    const deadline = now() + timeoutMs;
    const preflightEvidence = await observeWithEvidence({
      forwards: [forward],
      timeoutMs: Math.min(remaining(deadline, now), OPENSHELL_PROBE_TIMEOUT_MS),
      assertCurrent,
    });
    const [preflight] = preflightEvidence.observations;
    if (!preflight) {
      return { state: "failed", forward, effect: "none", error: OWNERSHIP_ERROR };
    }
    if (!("forward" in preflight)) {
      return { state: "failed", effect: "none", error: preflight.error };
    }
    if (preflight.state === "owned") {
      const ownedPid = preflightEvidence.ownedPids.get(forward.port);
      if (ownedPid === undefined) {
        return {
          state: "refused",
          observation: indeterminate(forward, OWNERSHIP_ERROR),
        };
      }
      const readiness = await proveForwardReady(forward, ownedPid, deadline, assertCurrent, true);
      if (readiness.state === "ready") return { state: "reused", forward };
      return {
        state: "refused",
        observation:
          readiness.state === "foreign"
            ? { state: "foreign", forward }
            : indeterminate(
                forward,
                readiness.state === "indeterminate" ? readiness.error : OWNERSHIP_ERROR,
              ),
      };
    }
    if (preflight.state !== "absent") return { state: "refused", observation: preflight };
    if (!environment || now() >= deadline) {
      return { state: "failed", forward, effect: "none", error: TIMEOUT_ERROR };
    }

    const beforeSpawn = await runFence(assertCurrent, deadline);
    if (beforeSpawn) {
      return { state: "failed", forward, effect: "none", error: beforeSpawn };
    }

    let child: CliOpenShellForwardChild;
    try {
      child = spawnForward(executable, buildCliOpenShellForwardServiceArgs(forward), {
        detached: true,
        environment,
        shell: false,
        stdio: "ignore",
      });
    } catch {
      return { state: "failed", forward, effect: "none", error: TRANSPORT_ERROR };
    }
    let childError: Error | undefined;
    const onError = (error: Error) => {
      childError = error;
    };
    try {
      child.once("error", onError);
    } catch {
      const cleanup = await cleanFailedStart(forward, child);
      return (
        cleanup ?? {
          state: "failed",
          forward,
          effect: "none",
          error: TRANSPORT_ERROR,
        }
      );
    }
    const afterSpawn = await runFence(assertCurrent, deadline);
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 1 || pid === process.pid) {
      await settleWithin(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
        remaining(deadline, now),
      );
      if (childError) {
        child.off("error", onError);
        return {
          state: "failed",
          forward,
          effect: "none",
          error: TRANSPORT_ERROR,
        };
      }
      child.unref();
      return {
        state: "cleanup_uncertain",
        forward,
        effect: "possible",
        error: CLEANUP_ERROR,
      };
    }

    const failAfterSpawn = async (
      error: OpenShellForwardRuntimeError,
      foreign: boolean,
    ): Promise<OpenShellForwardStartResult> => {
      const cleanup = await cleanFailedStart(forward, child);
      if (cleanup) return cleanup;
      child.off("error", onError);
      return foreign
        ? { state: "refused", observation: { state: "foreign", forward } }
        : { state: "failed", forward, effect: "none", error };
    };

    if (afterSpawn) return failAfterSpawn(afterSpawn, false);

    let failureError: OpenShellForwardRuntimeError = TIMEOUT_ERROR;
    let foreign = false;
    do {
      if (childError || child.exitCode !== null || child.signalCode !== null) {
        failureError = TRANSPORT_ERROR;
        break;
      }
      const readiness = await proveForwardReady(
        forward,
        Number(pid),
        deadline,
        assertCurrent,
        false,
      );
      if (readiness.state === "ready") {
        if (childError || child.exitCode !== null || child.signalCode !== null) {
          failureError = TRANSPORT_ERROR;
          break;
        }
        child.off("error", onError);
        child.unref();
        return { state: "started", forward };
      }
      if (readiness.state === "foreign") {
        foreign = true;
        break;
      }
      if (readiness.state === "indeterminate") {
        failureError = readiness.error;
        break;
      }
      const pauseMs = Math.min(pollIntervalMs, remaining(deadline, now));
      const pause = await settleWithin(() => sleep(pauseMs), remaining(deadline, now));
      if (pause.state !== "value") {
        failureError = TIMEOUT_ERROR;
        break;
      }
    } while (now() < deadline);
    return failAfterSpawn(failureError, foreign);
  }

  async function verifyForwardRelease(
    request: VerifyOpenShellForwardReleaseRequest,
  ): Promise<OpenShellForwardReleaseResult> {
    const forwards = snapshotForwards(request.forwards);
    const requestedTimeoutMs = request.timeoutMs;
    const assertCurrent = request.assertCurrent;
    if (forwards.length === 0) return { state: "released" };
    if (!validBatch(forwards, requestedTimeoutMs)) {
      return { state: "indeterminate", error: VALIDATION_ERROR };
    }
    const timeoutMs = requestedTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    const deadline = now() + timeoutMs;
    let bound: OpenShellForwardIdentity[] = [];
    do {
      const beforeProbe = await runFence(assertCurrent, deadline);
      if (beforeProbe) return { state: "indeterminate", forwards, error: beforeProbe };
      const states = await Promise.all(
        forwards.map((forward) => probePortSafely(forward, remaining(deadline, now))),
      );
      const unknown = forwards.filter((_, index) => states[index]?.state === "indeterminate");
      if (unknown.length > 0) {
        await runFence(assertCurrent, deadline);
        const firstUnknown = states.find((state) => state.state === "indeterminate");
        const unreleased = forwards.filter((_, index) => states[index]?.state !== "unbound");
        return {
          state: "indeterminate",
          forwards: unreleased,
          error: firstUnknown?.state === "indeterminate" ? firstUnknown.error : TRANSPORT_ERROR,
        };
      }
      const afterProbe = await runFence(assertCurrent, deadline);
      if (afterProbe) return { state: "indeterminate", forwards, error: afterProbe };
      bound = forwards.filter((_, index) => states[index]?.state === "bound");
      if (bound.length === 0) return { state: "released" };
      const pauseMs = Math.min(pollIntervalMs, remaining(deadline, now));
      const pause = await settleWithin(() => sleep(pauseMs), remaining(deadline, now));
      if (pause.state !== "value") {
        return { state: "indeterminate", forwards: bound, error: TIMEOUT_ERROR };
      }
    } while (now() < deadline);
    return { state: "bound", forwards: bound };
  }

  async function retireLegacyForward(
    request: RetireLegacyOpenShellForwardRequest,
  ): Promise<OpenShellLegacyForwardRetirementResult> {
    const forward = snapshotForward(request.forward);
    const requestedTimeoutMs = request.timeoutMs;
    const authorize = request.authorize;
    const assertCurrent = request.assertCurrent;
    const timeoutMs = requestedTimeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS;
    if (!runtimeValid || !validBatch([forward], requestedTimeoutMs)) {
      return { state: "failed", effect: "none", error: VALIDATION_ERROR };
    }
    const deadline = now() + timeoutMs;
    const observedEvidence = await observeWithEvidence({
      forwards: [forward],
      timeoutMs: Math.min(remaining(deadline, now), OPENSHELL_PROBE_TIMEOUT_MS),
      assertCurrent,
    });
    const [observed] = observedEvidence.observations;
    if (!observed) {
      return { state: "failed", forward, effect: "none", error: OWNERSHIP_ERROR };
    }
    if (!("forward" in observed)) {
      return { state: "failed", effect: "none", error: observed.error };
    }
    if (observed.state !== "stale") {
      return observed.state === "owned" || observed.state === "absent"
        ? { state: "not_needed", observation: observed }
        : { state: "refused", observation: observed };
    }
    const observedPid = observedEvidence.legacyPids.get(forward.port);
    if (observedPid === undefined) {
      return { state: "failed", forward, effect: "none", error: OWNERSHIP_ERROR };
    }
    const initialAuthority = await runFence(() => authorize(forward), deadline);
    if (initialAuthority) {
      return { state: "failed", forward, effect: "none", error: initialAuthority };
    }
    const confirmedEvidence = await observeWithEvidence({
      forwards: [forward],
      timeoutMs: Math.min(remaining(deadline, now), OPENSHELL_PROBE_TIMEOUT_MS),
      assertCurrent,
    });
    const [confirmed] = confirmedEvidence.observations;
    if (!confirmed) {
      return { state: "failed", forward, effect: "none", error: OWNERSHIP_ERROR };
    }
    if (!("forward" in confirmed)) {
      return { state: "failed", effect: "none", error: confirmed.error };
    }
    if (confirmed.state !== "stale") {
      return confirmed.state === "owned" || confirmed.state === "absent"
        ? { state: "not_needed", observation: confirmed }
        : { state: "refused", observation: confirmed };
    }
    if (confirmedEvidence.legacyPids.get(forward.port) !== observedPid) {
      return { state: "failed", forward, effect: "none", error: OWNERSHIP_ERROR };
    }
    if (!environment || now() >= deadline) {
      return { state: "failed", forward, effect: "none", error: TIMEOUT_ERROR };
    }
    const beforeStop = await runFence(assertCurrent, deadline);
    if (beforeStop) {
      return { state: "failed", forward, effect: "none", error: beforeStop };
    }
    const finalAuthority = await runFence(() => authorize(forward), deadline);
    if (finalAuthority) {
      return { state: "failed", forward, effect: "none", error: finalAuthority };
    }
    const finalCurrentness = await runFence(assertCurrent, deadline);
    if (finalCurrentness) {
      return { state: "failed", forward, effect: "none", error: finalCurrentness };
    }
    const result = await runSafely(
      buildCliOpenShellLegacyForwardStopArgs(forward),
      remaining(deadline, now),
    );
    const error = commandError(result);
    if (error) {
      const invocationFailure =
        (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
        (result.error as NodeJS.ErrnoException | undefined)?.code === "EACCES";
      if (invocationFailure) {
        return { state: "failed", forward, effect: "none", error };
      }
      await runFence(assertCurrent, now() + DEFAULT_RELEASE_TIMEOUT_MS);
      await observeWithEvidence({
        forwards: [forward],
        timeoutMs: DEFAULT_RELEASE_TIMEOUT_MS,
      });
      if (assertCurrent) {
        await runFence(assertCurrent, now() + DEFAULT_RELEASE_TIMEOUT_MS);
      }
      return {
        state: "mutation_uncertain",
        forward,
        effect: "possible",
        error,
      };
    }
    const afterStop = await runFence(assertCurrent, now() + DEFAULT_RELEASE_TIMEOUT_MS);
    const released = await verifyForwardRelease({
      forwards: [forward],
      timeoutMs: DEFAULT_RELEASE_TIMEOUT_MS,
    });
    const afterRelease = assertCurrent
      ? await runFence(assertCurrent, now() + DEFAULT_RELEASE_TIMEOUT_MS)
      : null;
    const lostAuthority = afterStop ?? afterRelease;
    if (lostAuthority) {
      return {
        state: "mutation_uncertain",
        forward,
        effect: "possible",
        error: lostAuthority,
      };
    }
    return released.state === "released"
      ? { state: "retired", forward }
      : {
          state: "release_unproved",
          forward,
          effect: "possible",
          error: CLEANUP_ERROR,
        };
  }

  return { observeForwards, startForward, retireLegacyForward, verifyForwardRelease };
}
