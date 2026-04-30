// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync, spawn } from "node:child_process";
import { CLI_DISPLAY_NAME, AGENT_PRODUCT_NAME } from "./branding";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { DASHBOARD_PORT } from "./ports";
import { buildSubprocessEnv } from "./subprocess-env";

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

function writePid(pidDir: string, name: string, pid: number): void {
  writeFileSync(join(pidDir, `${name}.pid`), String(pid));
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

/** Poll for process exit after SIGTERM, escalate to SIGKILL if needed. */
function stopService(pidDir: string, name: ServiceName): void {
  const pid = readPid(pidDir, name);
  if (pid === null) {
    info(`${name} was not running`);
    return;
  }

  if (!isAlive(pid)) {
    info(`${name} was not running`);
    removePid(pidDir, name);
    return;
  }

  // Send SIGTERM
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already dead between the check and the signal
    removePid(pidDir, name);
    info(`${name} stopped (PID ${String(pid)})`);
    return;
  }

  // Poll for exit (up to 3 seconds)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isAlive(pid)) {
    // Busy-wait in 100ms increments (synchronous — matches stop being sync)
    const start = Date.now();
    while (Date.now() - start < 100) {
      /* spin */
    }
  }

  // Escalate to SIGKILL if still alive
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
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
  const sandbox = validateSandboxName(
    opts.sandboxName ?? process.env.NEMOCLAW_SANDBOX ?? process.env.SANDBOX_NAME ?? "default",
  );
  return opts.pidDir ?? `/tmp/nemoclaw-services-${sandbox}`;
}

export function showStatus(opts: ServiceOptions = {}): void {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);

  console.log("");
  for (const svc of SERVICE_NAMES) {
    if (isRunning(pidDir, svc)) {
      const pid = readPid(pidDir, svc);
      console.log(`  ${GREEN}●${NC} ${svc}  (PID ${String(pid)})`);
    } else {
      console.log(`  ${RED}●${NC} ${svc}  (stopped)`);
    }
  }
  console.log("");

  // Only show tunnel URL if cloudflared is actually running
  const logFile = join(pidDir, "cloudflared.log");
  if (isRunning(pidDir, "cloudflared") && existsSync(logFile)) {
    const log = readFileSync(logFile, "utf-8");
    const match = /https:\/\/[a-z0-9-]*\.trycloudflare\.com/.exec(log);
    if (match) {
      info(`Public URL: ${match[0]}`);
    }
  }
}

export function stopAll(opts: ServiceOptions = {}): void {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);
  stopService(pidDir, "cloudflared");
  info("All services stopped.");
}

export async function startAll(opts: ServiceOptions = {}): Promise<void> {
  const pidDir = resolvePidDir(opts);
  const dashboardPort = opts.dashboardPort ?? DASHBOARD_PORT;

  ensurePidDir(pidDir);

  // Messaging (Telegram, Discord, Slack) is now handled natively by OpenClaw
  // inside the sandbox via the OpenShell provider/placeholder/L7-proxy pipeline.
  // No host-side bridge processes are needed. See: PR #1081.

  // cloudflared tunnel
  try {
    execSync("command -v cloudflared", {
      stdio: ["ignore", "ignore", "ignore"],
    });
    startService(pidDir, "cloudflared", "cloudflared", [
      "tunnel",
      "--url",
      `http://localhost:${String(dashboardPort)}`,
    ]);
  } catch {
    warn("cloudflared not found — no public URL. Install cloudflared manually if you need one.");
  }

  // Wait for cloudflared URL
  if (isRunning(pidDir, "cloudflared")) {
    info("Waiting for tunnel URL...");
    const logFile = join(pidDir, "cloudflared.log");
    for (let i = 0; i < 15; i++) {
      if (existsSync(logFile)) {
        const log = readFileSync(logFile, "utf-8");
        if (/https:\/\/[a-z0-9-]*\.trycloudflare\.com/.test(log)) {
          break;
        }
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
    }
  }

  // Banner
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log(`  │  ${(CLI_DISPLAY_NAME + " Services").padEnd(52)}│`);
  console.log("  │                                                     │");

  let tunnelUrl = "";
  const cfLogFile = join(pidDir, "cloudflared.log");
  if (isRunning(pidDir, "cloudflared") && existsSync(cfLogFile)) {
    const log = readFileSync(cfLogFile, "utf-8");
    const match = /https:\/\/[a-z0-9-]*\.trycloudflare\.com/.exec(log);
    if (match) {
      tunnelUrl = match[0];
    }
  }

  if (tunnelUrl) {
    console.log(`  │  Public URL:  ${tunnelUrl.padEnd(40)}│`);
  }

  console.log(`  │  ${("Messaging:   via " + AGENT_PRODUCT_NAME + " native channels (if configured)").padEnd(52)}│`);

  console.log("  │                                                     │");
  console.log("  │  Run 'openshell term' to monitor egress approvals   │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
}

// ---------------------------------------------------------------------------
// Exported status helper (useful for programmatic access)
// ---------------------------------------------------------------------------

export function getServiceStatuses(opts: ServiceOptions = {}): ServiceStatus[] {
  const pidDir = resolvePidDir(opts);
  ensurePidDir(pidDir);
  return SERVICE_NAMES.map((name) => {
    const running = isRunning(pidDir, name);
    return {
      name,
      running,
      pid: running ? readPid(pidDir, name) : null,
    };
  });
}
