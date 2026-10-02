// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { basename, join, resolve } from "node:path";
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
import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../state/mcp-lifecycle-lock-acquisition";
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

function readPid(pidDir: string, name: string): number | null {
  const pidFile = join(pidDir, `${name}.pid`);
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf-8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRunning(pidDir: string, name: string): boolean {
  const pid = readPid(pidDir, name);
  if (pid === null) return false;
  return isAlive(pid);
}

// ---------------------------------------------------------------------------
// Cloudflared state — finer-grained than isRunning() so callers (status,
// doctor) can distinguish stopped / stale-pid-file / stale-pid-process and
// emit a targeted remediation. Issue #2604.
// ---------------------------------------------------------------------------

export type CloudflaredState =
  | { kind: "running"; pid: number }
  | { kind: "stopped" }
  | { kind: "stale-pid-file" }
  | { kind: "stale-pid-process"; pid: number };

function readProcessCommandLine(pid: number): string | null {
  if (process.platform === "win32") {
    try {
      const executablePath = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(pid)}' -ErrorAction Stop).ExecutablePath`,
        ],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
        },
      ).trim();
      return executablePath.length > 0 ? JSON.stringify(executablePath) : null;
    } catch {
      return null;
    }
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "comm=", "-o", "args="], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      });
    } catch {
      return null;
    }
  }
}

function commandLineNamesCloudflared(commandLine: string): boolean {
  return commandLine
    .split(/\0|\s+/)
    .filter(Boolean)
    .some((token) => {
      const pathToken = token.replace(/^"|"$/g, "").replaceAll("\\", "/");
      return (
        basename(pathToken)
          .replace(/\.exe$/i, "")
          .toLowerCase() === "cloudflared"
      );
    });
}

// Process operations behind a small seam so lifecycle tests can model PID
// reuse deterministically (per the tunnel adapter/fake test convention)
// instead of spawning real processes or reading /proc.
export interface ProcessControl {
  isAlive(pid: number): boolean;
  commandLine(pid: number): string | null;
  signal(pid: number, sig: NodeJS.Signals): void;
}

const REAL_PROCESS_CONTROL: ProcessControl = {
  isAlive,
  commandLine: readProcessCommandLine,
  signal: (pid, sig) => {
    process.kill(pid, sig);
  },
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

function namedTunnelTargetsDashboard(pidDir: string, dashboardPort: number): boolean {
  const logFile = join(pidDir, "cloudflared.log");
  if (!existsSync(logFile)) return false;
  return extractNamedCloudflareUrl(readFileSync(logFile, "utf-8"), dashboardPort) !== null;
}

function hasNamedTunnelConfiguration(pidDir: string): boolean {
  const logFile = join(pidDir, "cloudflared.log");
  return existsSync(logFile) && readFileSync(logFile, "utf-8").includes("ingress");
}

export function readCloudflaredState(
  pidDir: string,
  processControl: ProcessControl = REAL_PROCESS_CONTROL,
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
  if (!processControl.isAlive(pid)) {
    return { kind: "stale-pid-process", pid };
  }
  const cmdline = processControl.commandLine(pid);
  if (cmdline !== null && !commandLineNamesCloudflared(cmdline)) {
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

const CLOUDFLARED_DASHBOARD_PORT_FILE = "cloudflared.dashboard-port";

function cloudflaredLifecycleLockName(pidDir: string): string {
  return `cloudflared-${createHash("sha256").update(resolve(pidDir)).digest("hex")}`;
}

function readCloudflaredDashboardPort(pidDir: string): number | null {
  const targetFile = join(pidDir, CLOUDFLARED_DASHBOARD_PORT_FILE);
  try {
    const port = Number(readFileSync(targetFile, "utf-8").trim());
    return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function quickTunnelTargetsDashboard(
  pidDir: string,
  pid: number,
  dashboardPort: number,
  processControl: ProcessControl,
): boolean {
  const commandLine = processControl.commandLine(pid);
  if (commandLine === null) return readCloudflaredDashboardPort(pidDir) === dashboardPort;

  const commandArgs = commandLine.split(/\0|\s+/).filter(Boolean);
  const urlFlagIndex = commandArgs.indexOf("--url");
  const target =
    urlFlagIndex >= 0
      ? commandArgs[urlFlagIndex + 1]
      : commandArgs.find((argument) => argument.startsWith("--url="))?.slice("--url=".length);
  if (urlFlagIndex < 0 && !commandArgs.some((argument) => argument.startsWith("--url="))) {
    return false;
  }

  try {
    const url = new URL(target ?? "");
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port === String(dashboardPort)
    );
  } catch {
    return false;
  }
}

function writeCloudflaredDashboardPort(pidDir: string, dashboardPort: number): void {
  const targetFile = join(pidDir, CLOUDFLARED_DASHBOARD_PORT_FILE);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(targetFile, flags, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, String(dashboardPort));
  } finally {
    closeSync(fd);
  }
}

function removeCloudflaredDashboardPort(pidDir: string): void {
  const targetFile = join(pidDir, CLOUDFLARED_DASHBOARD_PORT_FILE);
  if (existsSync(targetFile)) unlinkSync(targetFile);
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
): void {
  if (isRunning(pidDir, name)) {
    const pid = readPid(pidDir, name);
    info(`${name} already running (PID ${String(pid)})`);
    return;
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
    return;
  }

  subprocess.unref();
  writePid(pidDir, name, pid);
  info(`${name} started (PID ${String(pid)})`);
}

/**
 * The recorded process may have exited and had its PID recycled by the OS to an
 * unrelated (possibly system) process. Signalling it would terminate a
 * bystander, so only signal a live PID when its command line confirms
 * cloudflared. A null/unreadable command line is unknown and must be retained
 * without signal.
 */
function pidIdentity(pid: number, pc: ProcessControl): "cloudflared" | "other" | "unknown" {
  const cmdline = pc.commandLine(pid);
  if (cmdline === null) return "unknown";
  return commandLineNamesCloudflared(cmdline) ? "cloudflared" : "other";
}

/** Poll for process exit after SIGTERM, escalate to SIGKILL if needed. */
function stopService(
  pidDir: string,
  name: ServiceName,
  pc: ProcessControl = REAL_PROCESS_CONTROL,
): boolean {
  const pid = readPid(pidDir, name);
  if (pid === null) {
    info(`${name} was not running`);
    return true;
  }

  // A dead PID, or a live PID recycled to a non-cloudflared process, means our
  // service is not running. Drop the stale pid file without signalling.
  if (!pc.isAlive(pid)) {
    info(`${name} was not running`);
    removePid(pidDir, name);
    removeCloudflaredDashboardPort(pidDir);
    return true;
  }
  const initialIdentity = pidIdentity(pid, pc);
  if (initialIdentity === "other") {
    info(`${name} was not running`);
    removePid(pidDir, name);
    removeCloudflaredDashboardPort(pidDir);
    return true;
  }
  if (initialIdentity === "unknown") {
    warn(
      `${name} identity could not be confirmed (PID ${String(pid)}); process state was retained.`,
    );
    return false;
  }

  // Send SIGTERM
  try {
    pc.signal(pid, "SIGTERM");
  } catch {
    if (pc.isAlive(pid)) {
      warn(`${name} could not be stopped (PID ${String(pid)})`);
      return false;
    }
    removePid(pidDir, name);
    removeCloudflaredDashboardPort(pidDir);
    info(`${name} stopped (PID ${String(pid)})`);
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

  // Escalate to SIGKILL if still alive. Re-verify identity first: the PID could
  // have exited and been recycled to an unrelated process during the poll.
  if (pc.isAlive(pid)) {
    const identity = pidIdentity(pid, pc);
    if (identity === "other") {
      removePid(pidDir, name);
      removeCloudflaredDashboardPort(pidDir);
      info(`${name} was not running`);
      return true;
    }
    if (identity === "unknown") {
      warn(
        `${name} identity could not be confirmed (PID ${String(pid)}); process state was retained.`,
      );
      return false;
    }
    try {
      pc.signal(pid, "SIGKILL");
    } catch {
      /* already dead */
    }

    // Signal delivery can precede process exit; allow a bounded confirmation window.
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && pc.isAlive(pid)) {
      if (pidIdentity(pid, pc) !== "cloudflared") break;
      const start = Date.now();
      while (Date.now() - start < 100) {
        /* spin */
      }
    }
  }

  if (pc.isAlive(pid)) {
    const identity = pidIdentity(pid, pc);
    if (identity === "other") {
      removePid(pidDir, name);
      removeCloudflaredDashboardPort(pidDir);
      info(`${name} was not running`);
      return true;
    }
    if (identity === "unknown") {
      warn(
        `${name} identity could not be confirmed (PID ${String(pid)}); process state was retained.`,
      );
      return false;
    }
    warn(`${name} could not be stopped (PID ${String(pid)})`);
    return false;
  }

  removePid(pidDir, name);
  removeCloudflaredDashboardPort(pidDir);
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
  const dashboardPort = opts.dashboardPort ?? DASHBOARD_PORT;
  const processControl = opts.processControl ?? REAL_PROCESS_CONTROL;
  ensurePidDir(pidDir);

  console.log("");
  const state = readCloudflaredState(pidDir, processControl);
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
  }
  console.log("");

  // Only show tunnel URL if cloudflared is actually running
  const logFile = join(pidDir, "cloudflared.log");
  if (state.kind === "running") {
    const log = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    const commandArgs = processControl
      .commandLine(state.pid)
      ?.split(/\0|\s+/)
      .filter(Boolean);
    const tunnelIndex = commandArgs?.indexOf("tunnel") ?? -1;
    const runningNamedTunnel =
      (tunnelIndex >= 0 && commandArgs?.[tunnelIndex + 1] === "run") ||
      (commandArgs === undefined &&
        readCloudflaredDashboardPort(pidDir) === null &&
        hasNamedTunnelConfiguration(pidDir));
    const namedUrl = extractNamedCloudflareUrl(log, dashboardPort);
    const quickUrl = extractTryCloudflareUrl(log);
    const publicUrl =
      namedUrl ??
      (quickUrl && quickTunnelTargetsDashboard(pidDir, state.pid, dashboardPort, processControl)
        ? quickUrl
        : "");
    if (publicUrl) {
      info(`Public URL: ${publicUrl}`);
    } else if (quickUrl) {
      info(
        `Public URL withheld: the quick tunnel target could not be confirmed for dashboard port ${String(dashboardPort)}; run \`${CLI_NAME} tunnel start\` to retarget it.`,
      );
    } else if (runningNamedTunnel && !hasNamedTunnelConfiguration(pidDir)) {
      info(
        `Named tunnel dashboard target is unconfirmed for port ${String(dashboardPort)} because its ingress route has not been logged yet. Wait for the route log or correct the Cloudflare route, then rerun \`${CLI_NAME} tunnel status\`.`,
      );
    } else if (runningNamedTunnel && !namedTunnelTargetsDashboard(pidDir, dashboardPort)) {
      info(
        `Named tunnel ingress does not confirm dashboard port ${String(dashboardPort)}. Correct the Cloudflare route, then rerun \`${CLI_NAME} tunnel status\`.`,
      );
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

  const stopServices = (): OllamaUnloadResult | void => {
    // A public tunnel must not outlive the services it forwards to. Confirm the
    // host tunnel is stopped before tearing down sandbox channels, models, or the
    // gateway; otherwise a failed tunnel stop leaves a partially stopped target.
    // The lifecycle lock is held around this entire operation so a concurrent
    // start cannot recreate the tunnel before its dependencies are fully stopped.
    let hostServicesStopped = true;
    if (pidDir) {
      hostServicesStopped = stopService(
        pidDir,
        "cloudflared",
        opts.processControl ?? REAL_PROCESS_CONTROL,
      );
    } else {
      warn("Invalid sandbox name without an explicit PID directory; skipping host service stop.");
    }
    if (!hostServicesStopped) {
      info("Cloudflared remains running; service stop was not confirmed.");
      throw new Error(
        "cloudflared could not be stopped; its process and state were retained. Before stopping it manually, verify its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.",
      );
    }

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
          (opts.clearPendingOllamaModelCleanup ?? clearDefaultPendingOllamaModelCleanup)(
            sandboxName,
          );
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
    const finishOllamaCleanup = (): OllamaUnloadResult | void => {
      if (ollamaCleanupError) throw ollamaCleanupError;
      return ollamaCleanup;
    };

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
      info("Host services stopped; managed gateway not released.");
      return finishOllamaCleanup();
    }

    if (gatewayOutcome === "unconfirmed") {
      info("Host services stopped; managed gateway release was not confirmed.");
      return finishOllamaCleanup();
    }

    if (ollamaCleanupIncomplete) {
      info("Host services stopped; Ollama model cleanup remains incomplete.");
    } else {
      info("All services stopped.");
    }
    return finishOllamaCleanup();
  };

  return pidDir
    ? withMcpLifecycleLockSync(cloudflaredLifecycleLockName(pidDir), stopServices)
    : stopServices();
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
export function stopCloudflared(opts: ServiceOptions = {}): void {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);
  const stopped = withMcpLifecycleLockSync(cloudflaredLifecycleLockName(pidDir), () =>
    stopService(pidDir, "cloudflared", opts.processControl ?? REAL_PROCESS_CONTROL),
  );
  if (!stopped) {
    throw new Error(
      "cloudflared could not be stopped; its process and state were retained. Before stopping it manually, verify its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.",
    );
  }
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
  const dashboardPort =
    Number.isSafeInteger(opts.dashboardPort) &&
    (opts.dashboardPort ?? 0) >= 1 &&
    (opts.dashboardPort ?? 0) <= 65535
      ? (opts.dashboardPort ?? DASHBOARD_PORT)
      : DASHBOARD_PORT;

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
  let cloudflaredAvailable = true;
  try {
    execSync("command -v cloudflared", {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    cloudflaredAvailable = false;
    warn("cloudflared not found — no public URL. Install cloudflared manually if you need one.");
  }
  const tunnelTransition = await withMcpLifecycleLock(cloudflaredLifecycleLockName(pidDir), () => {
    let targetReady = true;
    let dashboardPortBound = false;
    let namedTunnelStarted = false;
    let targetFailure: string | null = null;
    const processControl = opts.processControl ?? REAL_PROCESS_CONTROL;
    let runningState = readCloudflaredState(pidDir, processControl);
    // A dead or recycled PID is not a running tunnel. Clear its owned state
    // before startService checks liveness, otherwise a recycled PID can make
    // startService silently retain an unrelated process.
    if (runningState.kind === "stale-pid-file") {
      removePid(pidDir, "cloudflared");
      removeCloudflaredDashboardPort(pidDir);
      runningState = { kind: "stopped" };
    } else if (runningState.kind === "stale-pid-process") {
      stopService(pidDir, "cloudflared", opts.processControl ?? REAL_PROCESS_CONTROL);
      runningState = readCloudflaredState(pidDir, processControl);
    }
    if (cloudflaredAvailable) {
      if (tunnelToken) {
        let runningNamedTunnel = false;
        if (runningState.kind === "running") {
          const commandLine = processControl.commandLine(runningState.pid);
          const commandArgs = commandLine?.split(/\0|\s+/).filter(Boolean);
          const tunnelIndex = commandArgs?.indexOf("tunnel") ?? -1;
          const runningQuickTunnel =
            tunnelIndex >= 0 && commandArgs?.slice(tunnelIndex + 1).includes("--url");
          runningNamedTunnel =
            (tunnelIndex >= 0 && commandArgs?.[tunnelIndex + 1] === "run") ||
            (commandArgs === undefined && namedTunnelTargetsDashboard(pidDir, dashboardPort));
          const recordedQuickTunnel =
            commandArgs === undefined &&
            readCloudflaredDashboardPort(pidDir) !== null &&
            Boolean(getTunnelUrl(pidDir, dashboardPort));
          if (runningNamedTunnel) {
            if (!namedTunnelTargetsDashboard(pidDir, dashboardPort)) {
              targetReady = false;
              targetFailure =
                "The existing named cloudflared tunnel is still running, but its logged ingress does not confirm the selected dashboard port. Update the tunnel route in Cloudflare or stop the tunnel manually only after verifying its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.";
            }
          } else if (runningQuickTunnel || recordedQuickTunnel) {
            // A named-tunnel request must not silently reuse a quick tunnel.
            // Stop only after confirming its identity; retain it if shutdown
            // cannot be verified.
            if (!stopService(pidDir, "cloudflared", processControl)) {
              targetReady = false;
              targetFailure =
                "The existing quick cloudflared tunnel could not be stopped before starting the named tunnel. Stop it manually only after verifying its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.";
            }
          } else {
            targetReady = false;
            targetFailure =
              "The existing cloudflared process type cannot be confirmed. Do not stop the process while its identity is uncertain. Verify its command line identifies cloudflared before stopping it, then retry.";
          }
        }
        if (targetReady && !runningNamedTunnel) {
          startService(pidDir, "cloudflared", "cloudflared", ["tunnel", "run"], {
            TUNNEL_TOKEN: tunnelToken,
          });
          namedTunnelStarted = isRunning(pidDir, "cloudflared");
        }
        if (targetReady && isRunning(pidDir, "cloudflared")) {
          removeCloudflaredDashboardPort(pidDir);
        }
      } else {
        const commandArgs =
          runningState.kind === "running"
            ? (opts.processControl ?? REAL_PROCESS_CONTROL)
                .commandLine(runningState.pid)
                ?.split(/\0|\s+/)
                .filter(Boolean)
            : undefined;
        const tunnelIndex = commandArgs?.indexOf("tunnel") ?? -1;
        const runningNamedTunnel =
          (tunnelIndex >= 0 && commandArgs?.[tunnelIndex + 1] === "run") ||
          (commandArgs === undefined && namedTunnelTargetsDashboard(pidDir, dashboardPort));
        const runningQuickTunnel =
          tunnelIndex >= 0 && commandArgs?.slice(tunnelIndex + 1).includes("--url");
        if (runningNamedTunnel && !namedTunnelTargetsDashboard(pidDir, dashboardPort)) {
          targetReady = false;
          targetFailure =
            "The existing named cloudflared tunnel is still running, but its logged ingress does not confirm the selected dashboard port. Update the tunnel route in Cloudflare or stop the tunnel manually only after verifying its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.";
        }
        // On platforms where the command line is unavailable, the private
        // dashboard-port record is the only durable evidence that this PID
        // was started as our quick tunnel. Require it to be valid before
        // reusing the process; a missing or malformed record remains closed.
        if (runningState.kind === "running" && !runningNamedTunnel) {
          const runningPort = readCloudflaredDashboardPort(pidDir);
          const recordedQuickTunnel = commandArgs === undefined && runningPort !== null;
          if (!runningQuickTunnel && !recordedQuickTunnel) {
            targetReady = false;
          } else if (runningPort !== dashboardPort) {
            targetReady = stopService(
              pidDir,
              "cloudflared",
              opts.processControl ?? REAL_PROCESS_CONTROL,
            );
          }
        }
        if (targetReady && !runningNamedTunnel) {
          // Persist the target before launching a process that depends on this state.
          writeCloudflaredDashboardPort(pidDir, dashboardPort);
          startService(pidDir, "cloudflared", "cloudflared", [
            "tunnel",
            "--url",
            `http://localhost:${String(dashboardPort)}`,
          ]);
          dashboardPortBound = true;
        } else if (runningQuickTunnel && readCloudflaredDashboardPort(pidDir) === dashboardPort) {
          dashboardPortBound = true;
        }
      }
    }
    return {
      targetReady,
      targetFailure,
      pid: readPid(pidDir, "cloudflared"),
      dashboardPortBound,
      namedTunnelStarted,
    };
  });

  if (!tunnelTransition.targetReady) {
    throw new Error(
      tunnelTransition.targetFailure ??
        "cloudflared could not be retargeted because the existing tunnel is still running. Stop it manually only after verifying its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.",
    );
  }

  // Wait for cloudflared URL
  const stillOwnsTunnel = () =>
    tunnelTransition.pid !== null &&
    readPid(pidDir, "cloudflared") === tunnelTransition.pid &&
    (!tunnelTransition.dashboardPortBound ||
      readCloudflaredDashboardPort(pidDir) === dashboardPort);
  if (stillOwnsTunnel() && isRunning(pidDir, "cloudflared")) {
    info("Waiting for tunnel URL...");
    for (let i = 0; i < 15; i++) {
      if (!stillOwnsTunnel()) break;
      if (getTunnelUrl(pidDir, dashboardPort)) {
        break;
      }
      if (tunnelTransition.namedTunnelStarted && hasNamedTunnelConfiguration(pidDir)) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
    }
  }

  if (
    tunnelTransition.namedTunnelStarted &&
    stillOwnsTunnel() &&
    isRunning(pidDir, "cloudflared")
  ) {
    if (!hasNamedTunnelConfiguration(pidDir)) {
      const rejectionOutcome = await withMcpLifecycleLock(
        cloudflaredLifecycleLockName(pidDir),
        () => {
          if (!stillOwnsTunnel()) return "superseded" as const;
          return stopService(pidDir, "cloudflared", opts.processControl ?? REAL_PROCESS_CONTROL)
            ? ("stopped" as const)
            : ("unconfirmed" as const);
        },
      );
      if (rejectionOutcome === "superseded") {
        throw new Error(
          "The new named cloudflared tunnel stopped or changed during ingress validation; its dashboard target is unconfirmed. Check tunnel status, then retry.",
        );
      }
      if (rejectionOutcome === "unconfirmed") {
        throw new Error(
          "The new named cloudflared tunnel did not log its ingress route and could not be confirmed stopped. Its process state was retained. Stop it manually only after verifying its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.",
        );
      }
      throw new Error(
        "The new named cloudflared tunnel did not log its ingress route. Its dashboard target is unconfirmed; check the tunnel route in Cloudflare, then retry.",
      );
    } else if (!namedTunnelTargetsDashboard(pidDir, dashboardPort)) {
      const rejectionOutcome = await withMcpLifecycleLock(
        cloudflaredLifecycleLockName(pidDir),
        () => {
          if (!stillOwnsTunnel()) return "superseded" as const;
          return stopService(pidDir, "cloudflared", opts.processControl ?? REAL_PROCESS_CONTROL)
            ? ("stopped" as const)
            : ("unconfirmed" as const);
        },
      );
      if (rejectionOutcome === "superseded") {
        warn(
          "The cloudflared process changed during named tunnel validation; leaving the replacement process running.",
        );
      } else if (rejectionOutcome === "unconfirmed") {
        throw new Error(
          "The new named cloudflared tunnel does not confirm the selected dashboard port and could not be confirmed stopped. Its process state was retained. Stop it manually only after verifying its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.",
        );
      } else {
        throw new Error(
          "The new named cloudflared tunnel does not confirm the selected dashboard port. Update the tunnel route in Cloudflare or stop the tunnel manually only after verifying its command line identifies cloudflared; do not stop it if its identity is uncertain. Then retry.",
        );
      }
    }
  }

  let tunnelUrl = "";
  if (stillOwnsTunnel() && isRunning(pidDir, "cloudflared")) {
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
  const processControl = opts.processControl ?? REAL_PROCESS_CONTROL;
  return SERVICE_NAMES.map((name) => {
    const running =
      name === "cloudflared"
        ? readCloudflaredState(pidDir, processControl).kind === "running"
        : isRunning(pidDir, name);
    return {
      name,
      running,
      pid: running ? readPid(pidDir, name) : null,
    };
  });
}
