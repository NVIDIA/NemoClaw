// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { once } from "node:events";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { spawnExitCode } from "../../core/process-exit";
import { HERMES_LIFECYCLE_DEFINITION } from "../../domain/lifecycle/hermes-definition";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { createTempSshConfig, type TempSshConfig } from "../../sandbox/temp-ssh-config";
import { isValidName } from "../../sandbox-name-contract";
import { isSshTransportFailure } from "../../state/ssh-transport";
import { resolveOpenshellBinaryOrNull } from "./resolve-shared";
import { buildOpenShellRuntimeSelectionEnv } from "./runtime-selection";
import { OPENSHELL_DEFAULT_WORKSPACE } from "./sandbox-ssh-host";
import {
  HERMES_ACP_EXECUTABLE,
  type HermesAcpSshFailureKind,
  type HermesAcpSshOutcome,
  type HermesAcpSshRequest,
  type HermesAcpSshTransport,
} from "./hermes-acp-ssh";

const ACP_SDK_VERSION = "0.9.0";
const ACP_SETUP_TIMEOUT_MS = 30_000;
const SSH_CONFIG_MAX_BYTES = 1024 * 1024;
const PROBE_MAX_BYTES = 4 * 1024;
const SSH_KILL_GRACE_MS = 1_000;
const SUPPORTED_HOST_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);

const HERMES_ACP_COMPATIBILITY_PROBE = [
  "set -eu",
  `test -x ${HERMES_ACP_EXECUTABLE}`,
  '/opt/hermes/.venv/bin/python -c \'import importlib.metadata as m; print(m.version("hermes-agent")); print(m.version("agent-client-protocol"))\'',
].join("; ");

type SignalName = "SIGINT" | "SIGTERM";

type ProcessSignalSource = Readonly<{
  add(signal: SignalName, listener: () => void): void;
  remove(signal: SignalName, listener: () => void): void;
}>;

type OpenShellCaptureResult = Readonly<{
  error?: Error;
  output: string;
  status: number | null;
  stderr?: string;
  stdout?: string;
}>;

type CaptureOpenShell = (
  args: string[],
  options: Readonly<{
    env: NodeJS.ProcessEnv;
    ignoreError: true;
    includeStreams: true;
    maxBuffer: number;
    openshellBinary: string;
    replaceEnv: true;
    timeout: number;
  }>,
) => OpenShellCaptureResult;

type OpenShellVersionProbe = (
  binary: string,
  options: Readonly<{
    env: NodeJS.ProcessEnv;
    ignoreError: true;
    maxBuffer: number;
    replaceEnv: true;
    timeout: number;
  }>,
) => string | null;
type SpawnSsh = (
  binary: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type CliHermesAcpSshTransportDeps = Readonly<{
  access?: (file: string) => void;
  captureOpenShell?: CaptureOpenShell;
  createTempConfig?: (contents: string, prefix: string) => TempSshConfig;
  openshellVersion?: OpenShellVersionProbe;
  platform?: NodeJS.Platform;
  resolveOpenshell?: () => string | null;
  signalSource?: ProcessSignalSource;
  spawnSsh?: SpawnSsh;
  sshBinary?: string;
}>;

const processSignals: ProcessSignalSource = {
  add: (signal, listener) => process.on(signal, listener),
  remove: (signal, listener) => process.off(signal, listener),
};

function failure(
  kind: HermesAcpSshFailureKind,
  message: string,
  exitCode: number,
): HermesAcpSshOutcome {
  return { kind: "failed", error: { kind, message }, exitCode };
}

function validateRequest(request: HermesAcpSshRequest): void {
  if (!isValidName(request.gatewayName)) throw new Error("Invalid OpenShell gateway name");
  if (!isValidName(request.sandboxName)) throw new Error("Invalid OpenShell sandbox name");
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
  ) {
    throw new Error("ACP timeout must be a positive safe integer");
  }
  assertNoOpenShellGatewayEndpointOverride();
}

function assertEnvironmentSafe(environment: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(environment)) {
    if (!name || name.includes("\0") || value?.includes("\0")) {
      throw new Error("OpenShell subprocess environment is invalid");
    }
  }
}

function shellEscape(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9./_-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validatedSshHost(
  config: string,
  openshellBinary: string,
  request: HermesAcpSshRequest,
): string | null {
  const host = `openshell-${request.sandboxName}.${OPENSHELL_DEFAULT_WORKSPACE}`;
  const expected = new Map<string, string>([
    ["host", host],
    ["user", "sandbox"],
    ["stricthostkeychecking", "no"],
    ["userknownhostsfile", "/dev/null"],
    ["globalknownhostsfile", "/dev/null"],
    ["loglevel", "ERROR"],
    ["serveraliveinterval", "15"],
    ["serveralivecountmax", "3"],
    [
      "proxycommand",
      `${shellEscape(openshellBinary)} ssh-proxy --gateway-name ${request.gatewayName} --name ${request.sandboxName} --workspace ${OPENSHELL_DEFAULT_WORKSPACE}`,
    ],
  ]);
  const seen = new Set<string>();
  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.search(/\s/u);
    if (separator <= 0) return null;
    const directive = trimmed.slice(0, separator).toLowerCase();
    const value = trimmed.slice(separator).trim();
    if (seen.has(directive) || expected.get(directive) !== value) return null;
    seen.add(directive);
  }
  return seen.size === expected.size ? host : null;
}

function sshArgs(configFile: string, host: string, command: string): string[] {
  if (!path.isAbsolute(configFile)) throw new Error("SSH configuration path must be absolute");
  if (!isValidName(host.replace(/^openshell-/u, "").replace(/\.default$/u, ""))) {
    throw new Error("OpenShell SSH host is invalid");
  }
  return [
    "-F",
    configFile,
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
    host,
    command,
  ];
}

export function buildHermesAcpProbeSshArgs(configFile: string, host: string): string[] {
  return sshArgs(configFile, host, HERMES_ACP_COMPATIBILITY_PROBE);
}

export function buildHermesAcpSessionSshArgs(configFile: string, host: string): string[] {
  return sshArgs(configFile, host, HERMES_ACP_EXECUTABLE);
}

function signalChildTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}> {
  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      resolve({ status, signal, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
}

async function safeDiagnosticWrite(stream: NodeJS.WritableStream, message: string): Promise<void> {
  try {
    if (stream.write(message)) return;
    await once(stream, "drain");
  } catch {
    // The diagnostic consumer disconnected.
  }
}

async function runProbe(
  child: ChildProcessWithoutNullStreams,
  expectedOutput: string,
  request: HermesAcpSshRequest,
  signalSource: ProcessSignalSource,
): Promise<HermesAcpSshOutcome | null> {
  let stopKind: "cancelled" | "timeout" | null = null;
  let requestedSignal: NodeJS.Signals | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (kind: "cancelled" | "timeout", signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null || stopKind) return;
    stopKind = kind;
    signalChildTree(child, signal);
    killTimer = setTimeout(() => signalChildTree(child, "SIGKILL"), SSH_KILL_GRACE_MS);
  };
  const onTerm = () => {
    requestedSignal = "SIGTERM";
    terminate("cancelled", "SIGTERM");
  };
  const onInt = () => {
    requestedSignal = "SIGINT";
    terminate("cancelled", "SIGINT");
  };
  const onAbort = () => terminate("cancelled");
  signalSource.add("SIGTERM", onTerm);
  signalSource.add("SIGINT", onInt);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  const timeout = setTimeout(() => terminate("timeout"), ACP_SETUP_TIMEOUT_MS);
  child.stdin.end();
  let output = Buffer.alloc(0);
  let outputOverflow = false;
  child.stdout.on("data", (chunk: Buffer | string) => {
    if (outputOverflow) return;
    const next = Buffer.concat([output, Buffer.from(chunk)]);
    if (next.length > PROBE_MAX_BYTES) {
      outputOverflow = true;
      output = Buffer.alloc(0);
      signalChildTree(child, "SIGTERM");
      return;
    }
    output = next;
  });
  child.stderr.resume();
  const result = await waitForClose(child);
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  signalSource.remove("SIGTERM", onTerm);
  signalSource.remove("SIGINT", onInt);
  request.signal?.removeEventListener("abort", onAbort);
  if (stopKind === "timeout") {
    return failure("timeout", "The Hermes ACP compatibility probe timed out.", 124);
  }
  if (stopKind === "cancelled") {
    return failure(
      "cancelled",
      "The Hermes ACP compatibility probe was cancelled.",
      requestedSignal === "SIGTERM" ? 143 : 130,
    );
  }
  if (outputOverflow) {
    return failure("incompatible", "The sandbox returned an invalid ACP compatibility result.", 78);
  }
  if (isSshTransportFailure(result)) {
    return failure("transport", "OpenShell SSH could not reach the selected sandbox.", 255);
  }
  if (result.status !== 0 || output.toString("utf8").trim() !== expectedOutput) {
    return failure(
      "incompatible",
      "The selected sandbox does not provide the supported Hermes ACP runtime.",
      78,
    );
  }
  return null;
}

async function runSession(
  child: ChildProcessWithoutNullStreams,
  request: HermesAcpSshRequest,
  signalSource: ProcessSignalSource,
): Promise<HermesAcpSshOutcome> {
  let stopKind: HermesAcpSshFailureKind | null = null;
  let requestedSignal: NodeJS.Signals | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let hadDiagnostics = false;

  const terminate = (kind: HermesAcpSshFailureKind, signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null || stopKind) return;
    stopKind = kind;
    signalChildTree(child, signal);
    killTimer = setTimeout(() => signalChildTree(child, "SIGKILL"), SSH_KILL_GRACE_MS);
  };
  const onTerm = () => {
    requestedSignal = "SIGTERM";
    terminate("cancelled", "SIGTERM");
  };
  const onInt = () => {
    requestedSignal = "SIGINT";
    terminate("cancelled", "SIGINT");
  };
  const onAbort = () => terminate("cancelled");
  const onInputAborted = () => terminate("client_disconnect");
  const onOutputClose = () => {
    if (!request.streams.output.writableEnded) terminate("client_disconnect");
  };

  signalSource.add("SIGTERM", onTerm);
  signalSource.add("SIGINT", onInt);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  request.streams.input.once("aborted", onInputAborted);
  request.streams.output.once("close", onOutputClose);
  child.stderr.on("data", () => {
    hadDiagnostics = true;
  });
  child.stderr.resume();
  if (request.timeoutMs !== undefined) {
    timeout = setTimeout(() => terminate("timeout"), request.timeoutMs);
  }

  const input = pipeline(request.streams.input, child.stdin).catch(() => {
    terminate("client_disconnect");
  });
  const output = pipeline(child.stdout, request.streams.output, { end: false }).catch(() => {
    terminate("client_disconnect");
  });
  const result = await waitForClose(child);
  await Promise.allSettled([input, output]);

  if (timeout) clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  signalSource.remove("SIGTERM", onTerm);
  signalSource.remove("SIGINT", onInt);
  request.signal?.removeEventListener("abort", onAbort);
  request.streams.input.off("aborted", onInputAborted);
  request.streams.output.off("close", onOutputClose);

  if (hadDiagnostics && (result.status !== 0 || result.error)) {
    await safeDiagnosticWrite(
      request.streams.diagnostics,
      "nemoclaw-acp: the remote adapter reported diagnostic output.\n",
    );
  }
  if (stopKind === "timeout") return failure("timeout", "The ACP session timed out.", 124);
  if (stopKind === "client_disconnect") {
    return failure("client_disconnect", "The ACP client disconnected.", 1);
  }
  if (stopKind === "cancelled") {
    return failure(
      "cancelled",
      "The ACP session was cancelled.",
      requestedSignal === "SIGINT" ? 130 : 143,
    );
  }
  if (isSshTransportFailure(result)) {
    return failure("transport", "The OpenShell SSH session failed.", 255);
  }
  if (result.error) return failure("invocation", "The SSH client could not start.", 1);
  return {
    kind: "completed",
    exitCode: spawnExitCode(result),
    ...(result.signal ? { signal: result.signal } : {}),
  };
}

function defaultSshSpawner(
  binary: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(binary, [...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function assertExecutable(file: string): void {
  accessSync(file, constants.X_OK);
}

function buildRuntimeEnv(gatewayName: string): NodeJS.ProcessEnv {
  const baseEnvironment: Record<string, string> = {};
  for (const name of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CURL_CA_BUNDLE",
    "XDG_CONFIG_HOME",
  ]) {
    const value = process.env[name];
    if (value !== undefined) baseEnvironment[name] = value;
  }
  const environment = buildOpenShellRuntimeSelectionEnv(baseEnvironment, {
    gatewayName,
    workspace: OPENSHELL_DEFAULT_WORKSPACE,
  });
  assertEnvironmentSafe(environment);
  return environment;
}

function captureConfig(
  binary: string,
  request: HermesAcpSshRequest,
  environment: NodeJS.ProcessEnv,
  capture: CaptureOpenShell,
): string | null {
  const options = {
    env: environment,
    ignoreError: true,
    includeStreams: true,
    maxBuffer: SSH_CONFIG_MAX_BYTES,
    openshellBinary: binary,
    replaceEnv: true,
    timeout: ACP_SETUP_TIMEOUT_MS,
  } as const;
  const sandbox = capture(
    ["sandbox", "get", "-g", request.gatewayName, request.sandboxName],
    options,
  );
  if (sandbox.status !== 0 || sandbox.error) return null;
  const result = capture(
    ["sandbox", "ssh-config", "-g", request.gatewayName, request.sandboxName],
    options,
  );
  return result.status === 0 && !result.error && result.output.trim() ? result.output : null;
}

function parseExactVersion(output: string): string | null {
  const matches = [...output.matchAll(/(?:^|[^0-9.])(\d+\.\d+\.\d+)(?![0-9.])/gu)]
    .map((match) => match[1])
    .filter((version): version is string => version !== undefined);
  const versions = [...new Set(matches)];
  return versions.length === 1 ? (versions[0] ?? null) : null;
}

function captureOpenShell(
  args: string[],
  options: Parameters<CaptureOpenShell>[1],
): OpenShellCaptureResult {
  const result = spawnSync(options.openshellBinary, args, {
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    output: stdout,
    stdout,
    stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function installedOpenShellVersion(
  binary: string,
  options: Parameters<OpenShellVersionProbe>[1],
  capture: CaptureOpenShell,
): string | null {
  const result = capture(["--version"], {
    ...options,
    includeStreams: true,
    openshellBinary: binary,
  });
  return result.status === 0 && !result.error
    ? parseExactVersion(`${result.stdout ?? result.output}\n${result.stderr ?? ""}`)
    : null;
}

function resolveBinaries(
  deps: CliHermesAcpSshTransportDeps,
  environment: NodeJS.ProcessEnv,
): Readonly<{ openshell: string; ssh: string }> | null {
  if (!SUPPORTED_HOST_PLATFORMS.has(deps.platform ?? process.platform)) return null;
  const openshell = (deps.resolveOpenshell ?? resolveOpenshellBinaryOrNull)();
  const ssh = deps.sshBinary ?? "/usr/bin/ssh";
  if (!openshell || !path.isAbsolute(openshell) || !path.isAbsolute(ssh)) return null;
  try {
    (deps.access ?? assertExecutable)(openshell);
    (deps.access ?? assertExecutable)(ssh);
  } catch {
    return null;
  }
  const versionOptions = {
    env: environment,
    ignoreError: true,
    maxBuffer: PROBE_MAX_BYTES,
    replaceEnv: true,
    timeout: ACP_SETUP_TIMEOUT_MS,
  } as const;
  const result = deps.openshellVersion
    ? deps.openshellVersion(openshell, versionOptions)
    : installedOpenShellVersion(
        openshell,
        versionOptions,
        deps.captureOpenShell ?? captureOpenShell,
      );
  return result === HERMES_LIFECYCLE_DEFINITION.openshellVersion ? { openshell, ssh } : null;
}

/** Create the OpenShell CLI implementation of the Hermes ACP SSH boundary. */
export function createCliHermesAcpSshTransport(
  deps: CliHermesAcpSshTransportDeps = {},
): HermesAcpSshTransport {
  return {
    async run(request) {
      validateRequest(request);
      const environment = buildRuntimeEnv(request.gatewayName);
      const binaries = resolveBinaries(deps, environment);
      if (!binaries) {
        return failure(
          "unavailable",
          `Hermes ACP requires OpenShell ${HERMES_LIFECYCLE_DEFINITION.openshellVersion} and the system SSH client.`,
          69,
        );
      }
      const config = captureConfig(
        binaries.openshell,
        request,
        environment,
        deps.captureOpenShell ?? captureOpenShell,
      );
      if (!config) {
        return failure(
          "transport",
          "OpenShell could not prepare SSH for the selected sandbox.",
          255,
        );
      }
      const host = validatedSshHost(config, binaries.openshell, request);
      if (!host) {
        return failure("transport", "OpenShell returned an invalid SSH target.", 255);
      }

      const temporary = (deps.createTempConfig ?? createTempSshConfig)(config, "nemoclaw-acp-ssh-");
      const spawnChild = deps.spawnSsh ?? defaultSshSpawner;
      const spawnOptions: SpawnOptionsWithoutStdio = {
        detached: (deps.platform ?? process.platform) !== "win32",
        env: environment,
      };
      try {
        let probe: ChildProcessWithoutNullStreams;
        try {
          probe = spawnChild(
            binaries.ssh,
            buildHermesAcpProbeSshArgs(temporary.file, host),
            spawnOptions,
          );
        } catch {
          return failure("invocation", "The SSH client could not start.", 1);
        }
        const expected = `${HERMES_LIFECYCLE_DEFINITION.agentVersion}\n${ACP_SDK_VERSION}`;
        const probeFailure = await runProbe(
          probe,
          expected,
          request,
          deps.signalSource ?? processSignals,
        );
        if (probeFailure) return probeFailure;

        let session: ChildProcessWithoutNullStreams;
        try {
          session = spawnChild(
            binaries.ssh,
            buildHermesAcpSessionSshArgs(temporary.file, host),
            spawnOptions,
          );
        } catch {
          return failure("invocation", "The SSH client could not start.", 1);
        }
        request.onSessionStarted?.();
        return await runSession(session, request, deps.signalSource ?? processSignals);
      } finally {
        temporary.cleanup();
      }
    },
  };
}
