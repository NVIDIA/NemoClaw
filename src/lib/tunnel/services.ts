// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { renderBox } from "../cli/banner";
import { AGENT_PRODUCT_NAME, CLI_DISPLAY_NAME, CLI_NAME } from "../cli/branding";
import { isObjectRecord } from "../core/json-types";
import { DASHBOARD_PORT } from "../core/ports";
import {
  clearPendingOllamaModelCleanup as clearDefaultPendingOllamaModelCleanup,
  unloadOllamaModels as unloadDefaultOllamaModels,
  type OllamaUnloadResult,
} from "../inference/ollama/proxy";
import type { RuntimeProviderChannelStopTransport } from "../onboard/runtime-provider/access";
import { buildSubprocessEnv } from "../subprocess-env";
import { registerTunnelOrigin } from "./allowed-origins";
import * as gatewayStop from "./gateway-stop";
import * as sandboxGatewayStop from "./sandbox-gateway-stop";

export { GATEWAY_STOP_SCRIPT } from "./gateway-stop-script";
export { stopSandboxChannels } from "./sandbox-gateway-stop";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceOptions {
  /** Sandbox name — must match the name used by start/stop/status. */
  sandboxName?: string;
  /** Dashboard port for cloudflared (default: 18789). */
  dashboardPort?: number;
  /** Repo root directory — used to locate scripts/. */
  repoDir?: string;
  /** Override PID directory (default: /tmp/nemoclaw-services-{sandbox}). */
  pidDir?: string;
  /** Injectable process operations (identity + signalling) for tests. */
  processControl?: ProcessControl;
  /** Injectable Ollama model cleanup for tests. */
  unloadOllamaModels?: () => OllamaUnloadResult | void;
  /** Whether this scoped stop owns Ollama models that require cleanup. Defaults to true. */
  cleanupOllamaModels?: boolean;
  /** Provider-owned transport for stopping the sandbox's native gateway. */
  channelStopTransport?: RuntimeProviderChannelStopTransport;
  /** Clears pending Ollama cleanup recovery after this sandbox's models unload. */
  clearPendingOllamaModelCleanup?: (sandboxName: string) => void;
  /** Cloudflare named tunnel token. Falls back to CLOUDFLARE_TUNNEL_TOKEN. */
  cloudflareTunnelToken?: string;
  /** Also release the managed host gateway port (legacy full-stop only). */
  releaseGatewayPort?: boolean;
}

export interface ServiceStatus {
  name: string;
  running: boolean;
  pid: number | null;
}

// ---------------------------------------------------------------------------
// Colour helpers — respect NO_COLOR
// ---------------------------------------------------------------------------

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const GREEN = useColor ? "\x1b[0;32m" : "";
const RED = useColor ? "\x1b[0;31m" : "";
const YELLOW = useColor ? "\x1b[1;33m" : "";
const NC = useColor ? "\x1b[0m" : "";

function info(msg: string): void {
  console.log(`${GREEN}[services]${NC} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${YELLOW}[services]${NC} ${msg}`);
}

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

function ensurePidDir(pidDir: string): void {
  if (!existsSync(pidDir)) {
    mkdirSync(pidDir, { recursive: true, mode: 0o700 });
  }
  chmodSync(pidDir, 0o700);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cloudflared state combines liveness and process identity so callers (status,
// doctor, start) agree on stopped / stale-pid-file / stale-pid-process and can
// emit a targeted remediation. Issue #2604.
// ---------------------------------------------------------------------------

export type CloudflaredState =
  | { kind: "running"; pid: number }
  | { kind: "stopped" }
  | { kind: "stale-pid-file" }
  | { kind: "stale-pid-process"; pid: number }
  | { kind: "unverified-pid-process"; pid: number };

type CommandLineCapture = (command: string, args: readonly string[]) => string;

const captureCommandLine: CommandLineCapture = (command, args) =>
  execFileSync(command, [...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });

/** Read a Windows process identity through the built-in CIM provider. */
export function readWindowsProcessCommandLine(
  pid: number,
  capture: CommandLineCapture = captureCommandLine,
): string | null {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${String(pid)}'`,
    "if ($null -eq $p) { exit 3 }",
    "@($p.Name, $p.ExecutablePath, $p.CommandLine) -join [Environment]::NewLine",
  ].join("; ");
  try {
    const commandLine = capture("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]).trim();
    return commandLine.length > 0 ? commandLine : null;
  } catch {
    return null;
  }
}

function readProcessCommandLine(pid: number): string | null {
  if (process.platform === "win32") return readWindowsProcessCommandLine(pid);
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    try {
      return captureCommandLine("ps", ["-p", String(pid), "-o", "comm=", "-o", "args="]);
    } catch {
      return null;
    }
  }
}

function commandLineNamesCloudflared(commandLine: string): boolean {
  const records = commandLine.includes("\0")
    ? commandLine.split("\0").filter(Boolean)
    : commandLine.split(/\s+/).filter(Boolean);
  const namesExecutable = (token: string | undefined, name: RegExp): boolean =>
    token !== undefined && name.test(basename(token.replaceAll("\\", "/")));
  return namesExecutable(records[0]?.trim(), /^(?:cloudflared)(?:\.exe)?$/i);
}

function commandLineMayWrapCloudflared(commandLine: string): boolean {
  const records = commandLine.includes("\0")
    ? commandLine.split("\0").filter(Boolean)
    : commandLine.split(/\s+/).filter(Boolean);
  const executableNames = records.map((token) =>
    basename(token.trim().replaceAll("\\", "/")).toLowerCase(),
  );
  let startIndex = 0;
  // `ps -o comm= -o args=` reports the executable before argv, so the first
  // name can appear twice. /proc cmdline does not include that prefix.
  if (executableNames[0] === executableNames[1]) startIndex += 1;
  if (executableNames[startIndex] === "env") startIndex += 1;

  return (
    /^(?:ba|da|z)?sh$/i.test(executableNames[startIndex] ?? "") &&
    executableNames[startIndex + 1] === "cloudflared"
  );
}

// Process operations behind a small seam so lifecycle tests can model PID
// reuse deterministically (per the tunnel adapter/fake test convention)
// instead of spawning real processes or reading /proc.
export interface ProcessControl {
  isAlive(pid: number): boolean;
  commandLine(pid: number): string | null;
  signalCloudflared(pid: number, sig: "SIGTERM" | "SIGKILL"): IdentityBoundSignalOutcome;
}

type IdentityBoundSignalOutcome = "signaled" | "not-running" | "not-cloudflared" | "unavailable";

const PIDFD_SIGNAL_SCRIPT = String.raw`
import os
import signal
import sys

if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
    print("unavailable")
    raise SystemExit(0)

pid = int(sys.argv[1])
signal_name = sys.argv[2]
try:
    pidfd = os.pidfd_open(pid)
except ProcessLookupError:
    print("not-running")
    raise SystemExit(0)
except (OSError, PermissionError):
    print("unavailable")
    raise SystemExit(0)

try:
    try:
        executable = os.readlink(f"/proc/{pid}/exe")
    except FileNotFoundError:
        print("not-running")
        raise SystemExit(0)
    except (OSError, PermissionError):
        print("unavailable")
        raise SystemExit(0)

    # Linux appends this suffix when an upgrade unlinks the running executable.
    # Its identity is uncertain, not evidence that the tunnel has stopped.
    if executable.endswith(" (deleted)"):
        print("unavailable")
        raise SystemExit(0)

    if os.path.basename(executable) != "cloudflared":
        print("not-cloudflared")
        raise SystemExit(0)

    try:
        signal.pidfd_send_signal(pidfd, getattr(signal, signal_name))
    except ProcessLookupError:
        print("not-running")
        raise SystemExit(0)
    except (OSError, PermissionError):
        print("unavailable")
        raise SystemExit(0)
    print("signaled")
finally:
    os.close(pidfd)
`;

const MACOS_AUDIT_TOKEN_SIGNAL_SCRIPT = String.raw`
ObjC.bindFunction("malloc", ["void*", ["int"]]);
ObjC.bindFunction("free", ["void", ["void*"]]);
ObjC.bindFunction("proc_pidinfo", ["int", ["int", "int", "Int64", "void*", "int"]]);
ObjC.bindFunction("proc_pidpath_audittoken", ["int", ["void*", "void*", "uint32_t"]]);
ObjC.bindFunction("proc_signal_with_audittoken", ["int", ["void*", "int"]]);

function writeUint32LittleEndian(buffer, offset, value) {
  for (let index = 0; index < 4; index += 1) {
    buffer[offset + index] = value % 256;
    value = Math.floor(value / 256);
  }
}

function readUint32LittleEndian(buffer, offset) {
  let value = 0;
  for (let index = 3; index >= 0; index -= 1) {
    value = value * 256 + buffer[offset + index];
  }
  return value;
}

function run(argv) {
  // Apple XNU defines PROC_PIDUNIQIDENTIFIERINFO as selector 17. Its 56-byte
  // result stores p_idversion at byte 32; audit_token_t stores PID and
  // pidversion at uint32 slots 5 and 7 respectively.
  const uniqueInfoSelector = 17;
  const uniqueInfoSize = 56;
  const uniqueInfoIdVersionOffset = 32;
  const auditTokenPidOffset = 20;
  const auditTokenIdVersionOffset = 28;
  const pid = Number(argv[0]);
  const signalNumber = argv[1] === "SIGKILL" ? 9 : 15;
  const uniqueInfo = $.malloc(56);
  const auditToken = $.malloc(32);
  const processPath = $.malloc(4096);

  try {
    if ($.proc_pidinfo(pid, uniqueInfoSelector, 0, uniqueInfo, uniqueInfoSize) !== uniqueInfoSize) {
      return "unavailable";
    }

    for (let index = 0; index < 32; index += 1) auditToken[index] = 0;
    writeUint32LittleEndian(auditToken, auditTokenPidOffset, pid);
    writeUint32LittleEndian(
      auditToken,
      auditTokenIdVersionOffset,
      readUint32LittleEndian(uniqueInfo, uniqueInfoIdVersionOffset),
    );

    const pathLength = $.proc_pidpath_audittoken(auditToken, processPath, 4096);
    if (pathLength <= 0) return "unavailable";

    let executablePath = "";
    for (let index = 0; index < pathLength; index += 1) {
      executablePath += String.fromCharCode(processPath[index]);
    }
    const pathParts = executablePath.split("/");
    if (pathParts[pathParts.length - 1] !== "cloudflared") return "not-cloudflared";

    const result = $.proc_signal_with_audittoken(auditToken, signalNumber);
    if (result === 0) return "signaled";
    if (result === 3) return "not-running";
    return "unavailable";
  } finally {
    $.free(uniqueInfo);
    $.free(auditToken);
    $.free(processPath);
  }
}
`;

function signalCloudflaredWithPidfd(
  pid: number,
  sig: "SIGTERM" | "SIGKILL",
): IdentityBoundSignalOutcome {
  if (process.platform !== "linux") return "unavailable";
  try {
    const result = execFileSync("python3", ["-I", "-c", PIDFD_SIGNAL_SCRIPT, String(pid), sig], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (
      result === "signaled" ||
      result === "not-running" ||
      result === "not-cloudflared" ||
      result === "unavailable"
    ) {
      return result;
    }
  } catch {
    // Never fall back to a raw PID signal when the identity-bound helper fails.
  }
  return "unavailable";
}

function signalCloudflaredWithAuditToken(
  pid: number,
  sig: "SIGTERM" | "SIGKILL",
): IdentityBoundSignalOutcome {
  if (process.platform !== "darwin") return "unavailable";
  try {
    const result = execFileSync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MACOS_AUDIT_TOKEN_SIGNAL_SCRIPT, String(pid), sig],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      },
    ).trim();
    if (
      result === "signaled" ||
      result === "not-running" ||
      result === "not-cloudflared" ||
      result === "unavailable"
    ) {
      return result;
    }
  } catch {
    // Never fall back to a raw PID signal when the identity-bound helper fails.
  }
  return "unavailable";
}

/**
 * Signal cloudflared only when the operating system exposes an identity-bound
 * process handle. Linux uses pidfd; macOS uses an audit token carrying the
 * kernel process-version identity. Hosts without either primitive fail closed.
 */
export function signalCloudflaredForPlatform(
  pid: number,
  sig: "SIGTERM" | "SIGKILL",
  platform: NodeJS.Platform = process.platform,
  macSignal: (
    pid: number,
    sig: "SIGTERM" | "SIGKILL",
  ) => IdentityBoundSignalOutcome = signalCloudflaredWithAuditToken,
): IdentityBoundSignalOutcome {
  if (platform === "linux") return signalCloudflaredWithPidfd(pid, sig);
  if (platform === "darwin") return macSignal(pid, sig);
  return "unavailable";
}

const REAL_PROCESS_CONTROL: ProcessControl = {
  isAlive,
  commandLine: readProcessCommandLine,
  signalCloudflared: signalCloudflaredForPlatform,
};

function extractTryCloudflareUrl(log: string): string | null {
  for (const rawToken of log.split(/\s+/)) {
    const candidate = rawToken.replace(/^[<("']+|[>),."']+$/g, "");
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:") continue;
      if (url.hostname === "trycloudflare.com" || url.hostname.endsWith(".trycloudflare.com")) {
        url.hash = "";
        return url.toString();
      }
    } catch {
      // Not a URL token.
    }
  }
  return null;
}

function formatNamedTunnelUrl(hostname: string): string | null {
  const normalized = hostname.trim().replace(/\.$/, "").toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      normalized,
    )
  ) {
    return null;
  }
  return `https://${normalized}`;
}

function serviceTargetsDashboard(service: string, dashboardPort: number): boolean {
  try {
    const url = new URL(service);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port === String(dashboardPort)
    );
  } catch {
    return service === `http://localhost:${String(dashboardPort)}`;
  }
}

function getConfigIngressEntries(config: unknown): Array<{ hostname: string; service: string }> {
  if (!isObjectRecord(config) || !Array.isArray(config.ingress)) return [];

  const entries: Array<{ hostname: string; service: string }> = [];
  for (const entry of config.ingress) {
    if (!isObjectRecord(entry)) continue;
    const { hostname, service } = entry;
    if (typeof hostname === "string" && typeof service === "string") {
      entries.push({ hostname, service });
    }
  }
  return entries;
}

function extractNamedCloudflareUrl(log: string, dashboardPort: number): string | null {
  for (const match of log.matchAll(/config="((?:\\"|[^"])*)"/g)) {
    const escapedConfig = match[1];
    if (!escapedConfig) continue;
    try {
      const configText = JSON.parse(`"${escapedConfig}"`) as string;
      const entries = getConfigIngressEntries(JSON.parse(configText) as unknown);
      for (const entry of entries) {
        if (!serviceTargetsDashboard(entry.service, dashboardPort)) continue;
        const url = formatNamedTunnelUrl(entry.hostname);
        if (url) return url;
      }
    } catch {
      // Fall through to the regex parser below for partial or unusual log lines.
    }
  }

  const port = String(dashboardPort).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const servicePattern = new RegExp(
    `\\\\"service\\\\"\\s*:\\s*\\\\"http://localhost:${port}/?\\\\"`,
    "g",
  );
  for (const line of log.split(/\r?\n/)) {
    for (const serviceMatch of line.matchAll(servicePattern)) {
      const prefix = line.slice(0, serviceMatch.index ?? 0);
      let hostname: string | null = null;
      for (const hostnameMatch of prefix.matchAll(/\\"hostname\\"\s*:\s*\\"([^"\\]+)\\"/g)) {
        hostname = hostnameMatch[1] ?? null;
      }
      if (!hostname) continue;
      const url = formatNamedTunnelUrl(hostname);
      if (url) return url;
    }
  }

  return null;
}

/** Extract the active cloudflared public URL from a service log. */
export function getTunnelUrl(pidDir: string, dashboardPort: number): string {
  const logFile = join(pidDir, "cloudflared.log");
  if (!existsSync(logFile)) return "";
  const log = readFileSync(logFile, "utf-8");
  return extractNamedCloudflareUrl(log, dashboardPort) ?? extractTryCloudflareUrl(log) ?? "";
}

export function readCloudflaredState(
  pidDir: string,
  pc: ProcessControl = REAL_PROCESS_CONTROL,
): CloudflaredState {
  const pidFile = join(pidDir, "cloudflared.pid");
  if (!existsSync(pidFile)) return { kind: "stopped" };
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf-8").trim();
  } catch {
    return { kind: "stopped" };
  }
  if (raw.length === 0) return { kind: "stopped" };
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) return { kind: "stale-pid-file" };
  if (!pc.isAlive(pid)) {
    return { kind: "stale-pid-process", pid };
  }
  const commandLine = pc.commandLine(pid);
  if (commandLine === null) {
    return { kind: "unverified-pid-process", pid };
  }
  if (commandLineMayWrapCloudflared(commandLine)) {
    return { kind: "unverified-pid-process", pid };
  }
  if (!commandLineNamesCloudflared(commandLine)) {
    return { kind: "stale-pid-process", pid };
  }
  return { kind: "running", pid };
}

function writePid(pidDir: string, name: string, pid: number): void {
  const pidFile = join(pidDir, `${name}.pid`);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(pidFile, flags, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, String(pid));
  } finally {
    closeSync(fd);
  }
}

function removePid(pidDir: string, name: string): void {
  const pidFile = join(pidDir, `${name}.pid`);
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

type ServiceName = "cloudflared";
const SERVICE_NAMES: readonly ServiceName[] = ["cloudflared"];

function startService(
  pidDir: string,
  name: ServiceName,
  command: string,
  args: string[],
  env?: Record<string, string>,
  pc: ProcessControl = REAL_PROCESS_CONTROL,
): boolean {
  const state = readCloudflaredState(pidDir, pc);
  if (state.kind === "running") {
    info(`${name} already running (PID ${String(state.pid)})`);
    return true;
  }
  if (state.kind === "unverified-pid-process") {
    warn(
      `${name} process identity is unavailable for PID ${String(state.pid)}; refusing to start another tunnel`,
    );
    return false;
  }

  // Open a single fd for the log file — mirrors bash `>log 2>&1`.
  // Uses child_process.spawn directly because execa's typed API
  // does not accept raw file descriptors for stdio.
  const logFile = join(pidDir, `${name}.log`);
  const logFd = openSync(logFile, "w", 0o600);
  fchmodSync(logFd, 0o600);
  const subprocess = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: buildSubprocessEnv(env),
  });
  closeSync(logFd);

  // Swallow errors on the detached child (e.g. ENOENT if the command
  // doesn't exist) so Node doesn't crash with an unhandled 'error' event.
  subprocess.on("error", () => {});

  const pid = subprocess.pid;
  if (pid === undefined) {
    warn(`${name} failed to start`);
    return false;
  }

  subprocess.unref();
  writePid(pidDir, name, pid);
  info(`${name} started (PID ${String(pid)})`);
  return true;
}

/** Poll for process exit after SIGTERM, escalate to SIGKILL if needed. */
function stopService(
  pidDir: string,
  name: ServiceName,
  pc: ProcessControl = REAL_PROCESS_CONTROL,
): boolean {
  const warnManualRecovery = (pid: number): void => {
    warn(
      `Independently verify PID ${String(pid)} is cloudflared with the host process manager, stop it, keep the PID record until it exits, then retry cleanup`,
    );
  };
  const state = readCloudflaredState(pidDir, pc);
  if (state.kind === "stopped" || state.kind === "stale-pid-file") {
    info(`${name} was not running`);
    removePid(pidDir, name);
    return true;
  }

  if (state.kind === "stale-pid-process") {
    info(`${name} was not running`);
    removePid(pidDir, name);
    return true;
  }

  if (state.kind === "unverified-pid-process") {
    warn(
      `${name} PID ${String(state.pid)} was not stopped because its process identity is unavailable`,
    );
    warnManualRecovery(state.pid);
    return false;
  }

  const pid = state.pid;

  const termOutcome = pc.signalCloudflared(pid, "SIGTERM");
  if (termOutcome === "unavailable") {
    warn(
      `${name} PID ${String(pid)} was not stopped because identity-bound signaling is unavailable`,
    );
    warnManualRecovery(pid);
    return false;
  }
  if (termOutcome === "not-running" || termOutcome === "not-cloudflared") {
    removePid(pidDir, name);
    info(`${name} was not running`);
    return true;
  }

  // Poll for exit (up to 3 seconds)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pc.isAlive(pid)) {
    // Busy-wait in 100ms increments (synchronous — matches stop being sync)
    const start = Date.now();
    while (Date.now() - start < 100) {
      /* spin */
    }
  }

  if (pc.isAlive(pid)) {
    const killOutcome = pc.signalCloudflared(pid, "SIGKILL");
    if (killOutcome === "unavailable") {
      warn(
        `${name} PID ${String(pid)} was not force-stopped because identity-bound signaling is unavailable`,
      );
      warnManualRecovery(pid);
      return false;
    }
    if (killOutcome === "not-running" || killOutcome === "not-cloudflared") {
      removePid(pidDir, name);
      info(`${name} was not running`);
      return true;
    }

    // A successful signal delivery is not proof that the process exited.
    // Retain the PID record until liveness independently confirms termination.
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && pc.isAlive(pid)) {
      const start = Date.now();
      while (Date.now() - start < 100) {
        /* spin */
      }
    }
    if (pc.isAlive(pid)) {
      warn(`${name} PID ${String(pid)} remained live after the force-stop signal`);
      warnManualRecovery(pid);
      return false;
    }
  }

  removePid(pidDir, name);
  info(`${name} stopped (PID ${String(pid)})`);
  return true;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Reject sandbox names that could escape the PID directory via path traversal. */
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function validateSandboxName(name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`Invalid sandbox name: ${JSON.stringify(name)}`);
  }
  return name;
}

function resolvePidDir(opts: ServiceOptions): string {
  const sandbox = validateSandboxName(
    opts.sandboxName ?? process.env.NEMOCLAW_SANDBOX ?? process.env.SANDBOX_NAME ?? "default",
  );
  return opts.pidDir ?? `/tmp/nemoclaw-services-${sandbox}`;
}

export function showStatus(opts: ServiceOptions = {}): void {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);

  console.log("");
  const state = readCloudflaredState(pidDir, opts.processControl ?? REAL_PROCESS_CONTROL);
  // #2604: distinguish stopped / stale-pid-file / stale-pid-process and
  // surface the matching remediation. The previous "(stopped)" line was
  // emitted in all three failure modes with no recovery hint.
  switch (state.kind) {
    case "running":
      console.log(`  ${GREEN}●${NC} cloudflared  (PID ${String(state.pid)})`);
      break;
    case "stopped":
      console.log(`  ${RED}●${NC} cloudflared  (stopped)`);
      console.log(`      no cloudflared process; run \`${CLI_NAME} tunnel start\` to start it`);
      break;
    case "stale-pid-file":
      console.log(`  ${YELLOW}●${NC} cloudflared  (stale PID file)`);
      console.log(
        `      no cloudflared process (stored PID is invalid); run \`${CLI_NAME} tunnel start\` to restart it`,
      );
      break;
    case "stale-pid-process":
      console.log(`  ${YELLOW}●${NC} cloudflared  (stale PID ${String(state.pid)})`);
      console.log(
        `      no cloudflared process (PID ${String(state.pid)} is dead or not cloudflared); run \`${CLI_NAME} tunnel start\` to restart it`,
      );
      break;
    case "unverified-pid-process":
      console.log(
        `  ${YELLOW}●${NC} cloudflared  (PID ${String(state.pid)}, identity unavailable)`,
      );
      console.log(
        "      process identity is unavailable; restore process inspection access, then retry",
      );
      break;
  }
  console.log("");

  // Only show tunnel URL if cloudflared is actually running
  const logFile = join(pidDir, "cloudflared.log");
  if (state.kind === "running" && existsSync(logFile)) {
    const publicUrl = getTunnelUrl(pidDir, opts.dashboardPort ?? DASHBOARD_PORT);
    if (publicUrl) {
      info(`Public URL: ${publicUrl}`);
    }
  }
}

export function stopAll(opts: ServiceOptions = {}): OllamaUnloadResult | void {
  // Resolve the target sandbox once and reuse it for in-sandbox and host-side cleanup.
  const rawSandboxName =
    opts.sandboxName ??
    process.env.NEMOCLAW_SANDBOX_NAME ??
    process.env.NEMOCLAW_SANDBOX ??
    process.env.SANDBOX_NAME;
  const sandboxName =
    rawSandboxName && SAFE_NAME_RE.test(rawSandboxName) && !rawSandboxName.includes("..")
      ? rawSandboxName
      : undefined;

  // Resolve host-side service state from the same effective sandbox selected
  // for in-sandbox shutdown, so pid cleanup cannot drift to a lower-priority
  // env var or the default sandbox.
  const pidDir =
    opts.pidDir ??
    (rawSandboxName && !sandboxName
      ? undefined
      : resolvePidDir({ ...opts, sandboxName: sandboxName ?? "default" }));
  if (pidDir) ensurePidDir(pidDir);

  if (sandboxName) {
    sandboxGatewayStop.stopSandboxChannels(sandboxName, {
      ...(opts.channelStopTransport ? { channelStopTransport: opts.channelStopTransport } : {}),
      info,
      warn,
    });
  } else if (rawSandboxName) {
    warn(`Invalid sandbox name: ${JSON.stringify(rawSandboxName)} — skipping in-sandbox stop.`);
  } else {
    warn("No sandbox name available — cannot stop in-sandbox messaging channels.");
    warn("Hint: run 'nemoclaw stop' with a registered sandbox or set NEMOCLAW_SANDBOX_NAME.");
  }

  let ollamaCleanupIncomplete = false;
  let ollamaCleanup: OllamaUnloadResult | undefined;
  let ollamaCleanupError: Error | undefined;
  if (opts.cleanupOllamaModels !== false) {
    try {
      const unloadOllamaModels = opts.unloadOllamaModels ?? unloadDefaultOllamaModels;
      const cleanup = unloadOllamaModels();
      if (cleanup) ollamaCleanup = cleanup;
      if (cleanup && !cleanup.ok) {
        ollamaCleanupIncomplete = true;
        warn(
          `Ollama model cleanup failed at ${cleanup.endpoint} (${cleanup.outcome}: ${cleanup.message ?? "no detail"}). The saved local route was retained; ${
            cleanup.outcome === "discovery-failed"
              ? `restore access to ${cleanup.endpoint}`
              : cleanup.outcome === "still-resident"
                ? `stop the recorded model at ${cleanup.endpoint}`
                : `allow the model unload request at ${cleanup.endpoint}`
          }, then retry this command.`,
        );
      } else if (sandboxName) {
        (opts.clearPendingOllamaModelCleanup ?? clearDefaultPendingOllamaModelCleanup)(sandboxName);
      }
    } catch (error) {
      ollamaCleanupIncomplete = true;
      const detail = (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      ollamaCleanupError = new Error(
        `Ollama model cleanup failed unexpectedly: ${detail || "unknown error"}. ` +
          "The saved local route was retained; restore access to the saved local Ollama " +
          "endpoint, then retry this command.",
        { cause: error },
      );
      warn(ollamaCleanupError.message);
    }
  }
  let cloudflaredCleanupComplete = true;
  const finishCleanup = (): OllamaUnloadResult | void => {
    if (ollamaCleanupError) throw ollamaCleanupError;
    if (!cloudflaredCleanupComplete) {
      throw new Error(
        "Cloudflared cleanup is incomplete. Keep the PID record until the process exits, then retry cleanup.",
      );
    }
    return ollamaCleanup;
  };

  // Stop host-side services only when their state directory is explicit or
  // derived from a trusted sandbox name. An invalid requested sandbox must not
  // fall through to the default sandbox's PID directory.
  if (pidDir) {
    cloudflaredCleanupComplete = stopService(
      pidDir,
      "cloudflared",
      opts.processControl ?? REAL_PROCESS_CONTROL,
    );
  } else {
    warn("Invalid sandbox name without an explicit PID directory; skipping host service stop.");
  }

  let gatewayOutcome: gatewayStop.GatewayStopOutcome | undefined;
  if (opts.releaseGatewayPort) {
    if (sandboxName) {
      gatewayOutcome = gatewayStop.releaseGatewayPortForStop(sandboxName, { info, warn });
    } else if (!rawSandboxName) {
      // #8952: no registry name — release only when NEMOCLAW_GATEWAY_PORT is
      // explicit. A requested-but-malformed name stays out: scope is unknown, not absent.
      gatewayOutcome = gatewayStop.releaseGatewayPortForStop(undefined, { info, warn });
    }
  }

  // When nothing scoped the gateway, or a scoped release was not confirmed, do
  // not claim every service stopped.
  if (gatewayOutcome === "not-scoped") {
    warn(
      "No sandbox name and no explicit NEMOCLAW_GATEWAY_PORT — the managed OpenShell gateway was not released.",
    );
    warn(
      "Hint: rerun with NEMOCLAW_GATEWAY_PORT=<port> to release that gateway, or 'openshell gateway list' to find it.",
    );
    info(
      cloudflaredCleanupComplete
        ? "Host services stopped; managed gateway not released."
        : "Host service cleanup remains incomplete; cloudflared was not stopped and the managed gateway was not released.",
    );
    return finishCleanup();
  }

  if (gatewayOutcome === "unconfirmed") {
    info(
      cloudflaredCleanupComplete
        ? "Host services stopped; managed gateway release was not confirmed."
        : "Host service cleanup remains incomplete; cloudflared was not stopped and the managed gateway release was not confirmed.",
    );
    return finishCleanup();
  }

  if (!cloudflaredCleanupComplete) {
    info("Host service cleanup remains incomplete; cloudflared was not stopped.");
  } else if (ollamaCleanupIncomplete) {
    info("Host services stopped; Ollama model cleanup remains incomplete.");
  } else {
    info("All services stopped.");
  }
  return finishCleanup();
}

/**
 * Resolve the PID directory for host-side services without starting or stopping
 * anything. Callers can derive an adjacent purpose-specific state directory
 * while preserving the same validated sandbox-name and environment precedence
 * used by `start`, `stop`, and `status`.
 */
export function resolveServicePidDir(opts: ServiceOptions = {}): string {
  return resolvePidDir(opts);
}

/**
 * Stop only the host-side cloudflared tunnel, leaving the in-sandbox gateway and
 * Ollama untouched. `stopAll` is intentionally broader (it also stops the gateway
 * and unloads Ollama); enrollment that auto-started a tunnel needs a tunnel-only
 * stop to clean up without tearing down other services.
 */
export function stopCloudflared(opts: ServiceOptions = {}): boolean {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);
  return stopService(pidDir, "cloudflared", opts.processControl ?? REAL_PROCESS_CONTROL);
}

/**
 * Sandbox name for tunnel-origin registration: same option/env precedence as
 * the other service commands, gated on the safe-name rules, but without the
 * registry default-sandbox fallback (registration is skipped rather than
 * guessed when no name is explicitly available).
 */
function resolveTunnelOriginSandboxName(opts: ServiceOptions): string | null {
  const raw =
    opts.sandboxName ??
    process.env.NEMOCLAW_SANDBOX_NAME ??
    process.env.NEMOCLAW_SANDBOX ??
    process.env.SANDBOX_NAME;
  if (!raw || !SAFE_NAME_RE.test(raw) || raw.includes("..")) return null;
  return raw;
}

export async function startAll(opts: ServiceOptions = {}): Promise<void> {
  const pidDir = resolvePidDir(opts);
  const dashboardPort = opts.dashboardPort ?? DASHBOARD_PORT;
  const processControl = opts.processControl ?? REAL_PROCESS_CONTROL;
  let cloudflaredReady = true;

  ensurePidDir(pidDir);

  // Messaging channels are handled natively by the agent runtime
  // inside the sandbox via the OpenShell provider/placeholder/L7-proxy pipeline.
  // No host-side bridge processes are needed. See: PR #1081.

  // cloudflared tunnel
  const tunnelToken = (
    opts.cloudflareTunnelToken ??
    process.env.CLOUDFLARE_TUNNEL_TOKEN ??
    ""
  ).trim();
  try {
    execSync("command -v cloudflared", {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (tunnelToken) {
      cloudflaredReady = startService(
        pidDir,
        "cloudflared",
        "cloudflared",
        ["tunnel", "run"],
        {
          TUNNEL_TOKEN: tunnelToken,
        },
        processControl,
      );
    } else {
      cloudflaredReady = startService(
        pidDir,
        "cloudflared",
        "cloudflared",
        ["tunnel", "--url", `http://localhost:${String(dashboardPort)}`],
        undefined,
        processControl,
      );
    }
  } catch {
    warn("cloudflared not found — no public URL. Install cloudflared manually if you need one.");
  }

  if (!cloudflaredReady) {
    const blockedState = readCloudflaredState(pidDir, processControl);
    if (blockedState.kind === "unverified-pid-process") {
      throw new Error(
        `cloudflared process identity is unavailable for PID ${String(blockedState.pid)}; restore process inspection access, then retry`,
      );
    }
    return;
  }

  // Wait for cloudflared URL
  if (readCloudflaredState(pidDir, processControl).kind === "running") {
    info("Waiting for tunnel URL...");
    for (let i = 0; i < 15; i++) {
      if (getTunnelUrl(pidDir, dashboardPort)) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
    }
  }

  let tunnelUrl = "";
  if (readCloudflaredState(pidDir, processControl).kind === "running") {
    tunnelUrl = getTunnelUrl(pidDir, dashboardPort);
  }

  if (tunnelUrl) {
    const sandboxName = resolveTunnelOriginSandboxName(opts);
    if (sandboxName) {
      try {
        await registerTunnelOrigin(sandboxName, tunnelUrl, { info, warn });
      } catch (err) {
        warn(`Could not register tunnel origin (${err instanceof Error ? err.message : err}).`);
      }
    } else {
      warn(
        "No sandbox name available — skipping tunnel-origin registration in gateway allowedOrigins.",
      );
    }
  }

  const bannerLines = [
    `  ${CLI_DISPLAY_NAME} Services`,
    null,
    ...(tunnelUrl ? [`  Public URL:  ${tunnelUrl}`] : []),
    `  Messaging:   via ${AGENT_PRODUCT_NAME} native channels (if configured)`,
    null,
    "  Run 'openshell term' to monitor egress approvals",
  ];

  console.log("");
  for (const line of renderBox(bannerLines)) {
    console.log(line);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Exported status helper (useful for programmatic access)
// ---------------------------------------------------------------------------

export function getServiceStatuses(opts: ServiceOptions = {}): ServiceStatus[] {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);
  return SERVICE_NAMES.map((name) => {
    const state = readCloudflaredState(pidDir, opts.processControl ?? REAL_PROCESS_CONTROL);
    const running = state.kind === "running";
    return {
      name,
      running,
      pid: running ? state.pid : null,
    };
  });
}
