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

function readProcessCommandLine(pid: number): string | null {
  if (process.platform === "win32") {
    // Native Windows is not a supported NemoClaw execution path. Fail closed
    // rather than introducing a partial process-inspection contract here; the
    // documented Windows path runs the Linux implementation under WSL2.
    return null;
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
    .some((token) => basename(token) === "cloudflared");
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
  const cmdline = pc.commandLine(pid);
  if (cmdline === null) {
    return { kind: "unverified-pid-process", pid };
  }
  if (!commandLineNamesCloudflared(cmdline)) {
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

type StopServiceOutcome = { kind: "complete" } | { kind: "unverified-pid-process"; pid: number };

function startService(
  pidDir: string,
  name: ServiceName,
  command: string,
  args: string[],
  env?: Record<string, string>,
  pc: ProcessControl = REAL_PROCESS_CONTROL,
): void {
  const state = readCloudflaredState(pidDir, pc);
  if (state.kind === "running") {
    info(`${name} already running (PID ${String(state.pid)})`);
    return;
  }
  if (state.kind === "unverified-pid-process") {
    warn(
      `${name} process identity is unavailable for PID ${String(state.pid)}; refusing to start another tunnel`,
    );
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

/** Poll for process exit after SIGTERM, escalate to SIGKILL if needed. */
function stopService(
  pidDir: string,
  name: ServiceName,
  pc: ProcessControl = REAL_PROCESS_CONTROL,
): StopServiceOutcome {
  const state = readCloudflaredState(pidDir, pc);
  if (state.kind === "stopped") {
    info(`${name} was not running`);
    return { kind: "complete" };
  }
  if (state.kind === "stale-pid-file" || state.kind === "stale-pid-process") {
    info(`${name} was not running`);
    removePid(pidDir, name);
    return { kind: "complete" };
  }
  if (state.kind === "unverified-pid-process") {
    warn(
      `${name} process identity is unavailable for PID ${String(state.pid)}; refusing to signal it. Restore process inspection access, then retry this command`,
    );
    return state;
  }
  const pid = state.pid;

  // Send SIGTERM
  try {
    pc.signal(pid, "SIGTERM");
  } catch {
    // Already dead between the check and the signal
    removePid(pidDir, name);
    info(`${name} stopped (PID ${String(pid)})`);
    return { kind: "complete" };
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

  // Re-read the same identity-aware state before escalation: the PID could
  // have exited and been recycled, or process inspection could have become
  // unavailable, while SIGTERM was draining.
  const postTermState = readCloudflaredState(pidDir, pc);
  if (postTermState.kind === "unverified-pid-process") {
    warn(
      `${name} process identity became unavailable for PID ${String(pid)}; refusing to send SIGKILL. Restore process inspection access, then retry this command`,
    );
    return postTermState;
  }
  if (postTermState.kind === "running") {
    try {
      pc.signal(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  } else if (postTermState.kind === "stale-pid-process") {
    info(`${name} was not running`);
  }

  removePid(pidDir, name);
  info(`${name} stopped (PID ${String(pid)})`);
  return { kind: "complete" };
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
      console.log(`  ${YELLOW}●${NC} cloudflared  (PID ${String(state.pid)}, unverified)`);
      console.log(
        `      process identity is unavailable; retry after restoring process inspection access`,
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
  const finishOllamaCleanup = (): OllamaUnloadResult | void => {
    if (ollamaCleanupError) throw ollamaCleanupError;
    return ollamaCleanup;
  };

  // Stop host-side services only when their state directory is explicit or
  // derived from a trusted sandbox name. An invalid requested sandbox must not
  // fall through to the default sandbox's PID directory.
  let cloudflaredStopOutcome: StopServiceOutcome = { kind: "complete" };
  if (pidDir) {
    cloudflaredStopOutcome = stopService(
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
      cloudflaredStopOutcome.kind === "unverified-pid-process"
        ? "Host service cleanup remains incomplete; cloudflared and the managed gateway were not released."
        : "Host services stopped; managed gateway not released.",
    );
    return finishOllamaCleanup();
  }

  if (gatewayOutcome === "unconfirmed") {
    info(
      cloudflaredStopOutcome.kind === "unverified-pid-process"
        ? "Host service cleanup remains incomplete; cloudflared was not stopped and managed gateway release was not confirmed."
        : "Host services stopped; managed gateway release was not confirmed.",
    );
    return finishOllamaCleanup();
  }

  if (cloudflaredStopOutcome.kind === "unverified-pid-process") {
    info(
      `Host service cleanup remains incomplete; cloudflared PID ${String(cloudflaredStopOutcome.pid)} was not stopped${
        ollamaCleanupIncomplete ? " and Ollama model cleanup also remains incomplete" : ""
      }.`,
    );
  } else if (ollamaCleanupIncomplete) {
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
  const pidDir = resolvePidDir(opts);
  const dashboardPort = opts.dashboardPort ?? DASHBOARD_PORT;
  const processControl = opts.processControl ?? REAL_PROCESS_CONTROL;

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
      startService(
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
      startService(
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
