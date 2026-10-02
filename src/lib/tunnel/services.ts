// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import { resolveNemoclawStateDir } from "../state/paths";
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
  /** Override the cloudflared PID directory (default: one host-scoped directory). */
  pidDir?: string;
  /** Injectable process operations (identity + signalling) for tests. */
  processControl?: ProcessControl;
  /** Injectable current-user cloudflared discovery for tests. */
  unmanagedCloudflaredPids?: (managedPid: number | null) => number[];
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
  /** Stop the shared dashboard tunnel. Sandbox cleanup sets this false. */
  stopCloudflared?: boolean;
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
  if (process.platform === "win32") return null;
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
    .some((token) => basename(token) === "cloudflared");
}

/** Find current-user cloudflared processes that have no NemoClaw PID record. */
export function findUnmanagedCloudflaredPids(
  managedPid: number | null,
  captureProcessList: () => string = () =>
    execFileSync("ps", ["-x", "-o", "pid=", "-o", "comm=", "-o", "args="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }),
): number[] {
  if (process.platform === "win32") return [];
  let output: string;
  try {
    output = captureProcessList();
  } catch {
    return [];
  }

  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === managedPid) return [];
    const executable = basename(match[2] ?? "").toLowerCase();
    return executable === "cloudflared" || executable === "cloudflared.exe" ? [pid] : [];
  });
}

function unmanagedCloudflaredPids(opts: ServiceOptions, managedPid: number | null): number[] {
  return (opts.unmanagedCloudflaredPids ?? findUnmanagedCloudflaredPids)(managedPid);
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

export function readCloudflaredState(pidDir: string): CloudflaredState {
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
  try {
    process.kill(pid, 0);
  } catch {
    return { kind: "stale-pid-process", pid };
  }
  const cmdline = readProcessCommandLine(pid);
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
 * bystander, so only report a live PID as ours when its command line still
 * names cloudflared. A null/unreadable command line stays conservative and is
 * treated as ours, matching readCloudflaredState.
 */
function pidIsOurs(pid: number, pc: ProcessControl): boolean {
  const cmdline = pc.commandLine(pid);
  return cmdline === null || commandLineNamesCloudflared(cmdline);
}

/** Poll for process exit after SIGTERM, escalate to SIGKILL if needed. */
function stopService(
  pidDir: string,
  name: ServiceName,
  pc: ProcessControl = REAL_PROCESS_CONTROL,
): void {
  const pid = readPid(pidDir, name);
  if (pid === null) {
    info(`${name} was not running`);
    return;
  }

  // A dead PID, or a live PID recycled to a non-cloudflared process, means our
  // service is not running. Drop the stale pid file without signalling.
  if (!pc.isAlive(pid) || !pidIsOurs(pid, pc)) {
    info(`${name} was not running`);
    removePid(pidDir, name);
    return;
  }

  // Send SIGTERM
  try {
    pc.signal(pid, "SIGTERM");
  } catch {
    // Already dead between the check and the signal
    removePid(pidDir, name);
    info(`${name} stopped (PID ${String(pid)})`);
    return;
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
    if (!pidIsOurs(pid, pc)) {
      removePid(pidDir, name);
      info(`${name} was not running`);
      return;
    }
    try {
      pc.signal(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  removePid(pidDir, name);
  info(`${name} stopped (PID ${String(pid)})`);
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
  if (opts.pidDir) return opts.pidDir;
  return join(resolveNemoclawStateDir(), "tunnel");
}

function legacyTunnelPidDirs(): string[] {
  try {
    return readdirSync("/tmp", { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith("nemoclaw-services-") &&
          !entry.name.endsWith("-googlechat"),
      )
      .map((entry) => join("/tmp", entry.name))
      .filter((pidDir) => !existsSync(join(pidDir, "nemoclaw-googlechat-webhook-proxy.pid")));
  } catch {
    return [];
  }
}

export interface LegacyCloudflaredMigrationDeps {
  legacyPidDirs?: () => string[];
  readState?: (pidDir: string) => CloudflaredState;
}

/**
 * Move one live pre-#11628 dashboard tunnel record into the host-scoped state
 * directory. Dedicated Google Chat tunnel directories are never candidates.
 * Multiple live records are ambiguous and fail closed.
 */
export function migrateLegacyCloudflaredState(
  opts: ServiceOptions = {},
  deps: LegacyCloudflaredMigrationDeps = {},
): boolean {
  if (opts.pidDir) return false;

  const targetPidDir = resolvePidDir(opts);
  const readState = deps.readState ?? readCloudflaredState;
  ensurePidDir(targetPidDir);
  const targetState = readState(targetPidDir);

  const candidates = (deps.legacyPidDirs ?? legacyTunnelPidDirs)().flatMap((pidDir) => {
    const state = readState(pidDir);
    return state.kind === "running" ? [{ pidDir, pid: state.pid }] : [];
  });
  if (candidates.length === 0) return false;
  if (targetState.kind === "running" || candidates.length > 1) {
    const activeRecords = [
      ...(targetState.kind === "running" ? [{ pidDir: targetPidDir, pid: targetState.pid }] : []),
      ...candidates,
    ];
    const detail = activeRecords.map(({ pidDir, pid }) => `${pid} (${pidDir})`).join(", ");
    throw new Error(
      `Multiple recorded cloudflared processes are running: ${detail}. ` +
        "Stop the unintended processes, then retry the tunnel command.",
    );
  }

  const candidate = candidates[0]!;
  const sourceLog = join(candidate.pidDir, "cloudflared.log");
  const targetLog = join(targetPidDir, "cloudflared.log");
  if (existsSync(targetLog)) unlinkSync(targetLog);
  if (existsSync(sourceLog)) {
    copyFileSync(sourceLog, targetLog, constants.COPYFILE_EXCL);
    chmodSync(targetLog, 0o600);
  }
  removePid(targetPidDir, "cloudflared");
  writePid(targetPidDir, "cloudflared", candidate.pid);
  removePid(candidate.pidDir, "cloudflared");
  info(`Adopted legacy cloudflared state from ${candidate.pidDir}.`);
  return true;
}

function prepareTunnelPidDir(opts: ServiceOptions): string {
  migrateLegacyCloudflaredState(opts);
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);
  return pidDir;
}

function resolveSandboxServicePidDir(opts: ServiceOptions): string {
  const sandbox = validateSandboxName(
    opts.sandboxName ?? process.env.NEMOCLAW_SANDBOX ?? process.env.SANDBOX_NAME ?? "default",
  );
  return `/tmp/nemoclaw-services-${sandbox}`;
}

export function showStatus(opts: ServiceOptions = {}): void {
  const pidDir = prepareTunnelPidDir(opts);

  console.log("");
  const state = readCloudflaredState(pidDir);
  const unmanagedPids =
    state.kind === "running"
      ? []
      : unmanagedCloudflaredPids(opts, state.kind === "stale-pid-process" ? state.pid : null);
  if (unmanagedPids.length > 0) {
    console.log(
      `  ${YELLOW}●${NC} cloudflared  (unmanaged ${unmanagedPids.map((pid) => `PID ${String(pid)}`).join(", ")})`,
    );
    console.log(
      "      cloudflared is running without NemoClaw ownership; stop it through its process manager before running `nemoclaw tunnel start`",
    );
    console.log("");
    return;
  }
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

  const pidDir =
    rawSandboxName && !sandboxName && !opts.pidDir ? undefined : prepareTunnelPidDir(opts);

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
  const finishOllamaCleanup = (): OllamaUnloadResult | void => {
    if (ollamaCleanupError) throw ollamaCleanupError;
    return ollamaCleanup;
  };

  if (opts.stopCloudflared !== false && pidDir) {
    stopService(pidDir, "cloudflared", opts.processControl ?? REAL_PROCESS_CONTROL);
    const unmanagedPids = unmanagedCloudflaredPids(opts, null);
    if (unmanagedPids.length > 0) {
      throw new Error(
        `cloudflared remains running outside NemoClaw ownership (${unmanagedPids.map((pid) => `PID ${String(pid)}`).join(", ")}). ` +
          "Stop it through its process manager; NemoClaw did not signal it.",
      );
    }
  } else if (opts.stopCloudflared !== false) {
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
}

/**
 * Resolve the PID directory for host-side services without starting or stopping
 * anything. Callers can derive an adjacent purpose-specific state directory
 * while preserving the same validated sandbox-name and environment precedence
 * used by `start`, `stop`, and `status`.
 */
export function resolveServicePidDir(opts: ServiceOptions = {}): string {
  return opts.pidDir ?? resolveSandboxServicePidDir(opts);
}

/** Resolve the shared dashboard tunnel state directory without changing state. */
export function resolveTunnelPidDir(opts: ServiceOptions = {}): string {
  return resolvePidDir(opts);
}

/**
 * Stop only the host-side cloudflared tunnel, leaving the in-sandbox gateway and
 * Ollama untouched. `stopAll` is intentionally broader (it also stops the gateway
 * and unloads Ollama); enrollment that auto-started a tunnel needs a tunnel-only
 * stop to clean up without tearing down other services.
 */
export function stopCloudflared(opts: ServiceOptions = {}): void {
  const pidDir = prepareTunnelPidDir(opts);
  stopService(pidDir, "cloudflared");
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
  const pidDir = prepareTunnelPidDir(opts);
  const dashboardPort = opts.dashboardPort ?? DASHBOARD_PORT;

  const recordedState = readCloudflaredState(pidDir);
  if (recordedState.kind !== "running") {
    const unmanagedPids = unmanagedCloudflaredPids(
      opts,
      recordedState.kind === "stale-pid-process" ? recordedState.pid : null,
    );
    if (unmanagedPids.length > 0) {
      throw new Error(
        `cloudflared is already running outside NemoClaw ownership (${unmanagedPids.map((pid) => `PID ${String(pid)}`).join(", ")}). ` +
          "Stop it through its process manager, then retry `nemoclaw tunnel start`.",
      );
    }
  }

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
      startService(pidDir, "cloudflared", "cloudflared", ["tunnel", "run"], {
        TUNNEL_TOKEN: tunnelToken,
      });
    } else {
      startService(pidDir, "cloudflared", "cloudflared", [
        "tunnel",
        "--url",
        `http://localhost:${String(dashboardPort)}`,
      ]);
    }
  } catch {
    warn("cloudflared not found — no public URL. Install cloudflared manually if you need one.");
  }

  // Wait for cloudflared URL
  if (isRunning(pidDir, "cloudflared")) {
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
  if (isRunning(pidDir, "cloudflared")) {
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
  const pidDir = prepareTunnelPidDir(opts);
  return SERVICE_NAMES.map((name) => {
    const state = readCloudflaredState(pidDir);
    const unmanagedPids =
      state.kind === "running"
        ? []
        : unmanagedCloudflaredPids(opts, state.kind === "stale-pid-process" ? state.pid : null);
    const running = state.kind === "running" || unmanagedPids.length > 0;
    return {
      name,
      running,
      pid: state.kind === "running" ? state.pid : (unmanagedPids[0] ?? null),
    };
  });
}
