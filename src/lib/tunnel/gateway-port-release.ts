// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Release the NemoClaw-managed OpenShell gateway host port on `stop`.
 *
 * `nemoclaw stop` (the deprecated alias for `tunnel stop`) historically only
 * stopped the in-sandbox channels and the host-side cloudflared tunnel. On
 * macOS the OpenShell gateway runs as a host process (`openshell-gateway`)
 * bound to the gateway port (default 8080), and nothing in the stop path ever
 * stopped it — so the port stayed occupied after `nemoclaw stop` and a fresh
 * onboard / port-conflict-recovery test could not re-bind it (#5968).
 *
 * This module reuses the shared host-gateway stopper rather than an ad-hoc
 * `pkill`: it stops the recorded gateway process (via its pid file) and any
 * duplicate/orphan gateway squatting the same port (discovered with `lsof`,
 * covering the reporter's `host-process=2` case), then polls the port until it
 * is free or a bounded timeout elapses. The sweep is scoped to the resolved
 * gateway port and gated on the openshell-gateway cmdline, so a different
 * worktree's gateway (or an unrelated process) is never torn down.
 */

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { GATEWAY_PORT } from "../core/ports";
import { waitUntil } from "../core/wait";
import {
  resolveGatewayPortFromName,
  resolveGatewayStateDirName,
  resolveSandboxGatewayName,
  type SandboxGatewayBinding,
} from "../onboard/gateway-binding";
import {
  type HostGatewayProcessDeps,
  type RunResult,
  type StopHostGatewayResult,
  stopHostGatewayProcesses,
} from "../onboard/host-gateway-process";

const DEFAULT_CONFIRM_TIMEOUT_MS = 2000;
const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 100;

export interface ReleaseGatewayPortDeps extends Partial<HostGatewayProcessDeps> {
  /** Home directory used to derive the per-port gateway state dir. */
  homeDir?: string;
  /** Clock for the confirmation poll. Defaults to Date.now. */
  now?: () => number;
  /** Sleep used between confirmation polls. Defaults to the waitUntil default. */
  sleep?: (ms: number) => void;
  /** Injectable host-gateway stopper (defaults to the shared helper). */
  stopHostGatewayProcesses?: typeof stopHostGatewayProcesses;
  /** Registry lookup used to resolve the sandbox's gateway port. */
  getSandbox?: (name: string) => SandboxGatewayBinding | null;
}

export interface ReleaseGatewayPortOptions {
  /** Sandbox whose gateway port should be released. */
  sandboxName?: string;
  /** Explicit gateway port override (skips registry resolution). */
  port?: number;
  /** How long to poll the port for release before warning. */
  confirmTimeoutMs?: number;
  /** Poll interval while confirming release. */
  confirmPollIntervalMs?: number;
}

export interface ReleaseGatewayPortResult {
  /** Resolved gateway port, or null when resolution failed closed (skipped). */
  port: number | null;
  released: boolean;
  stopped: number[];
  remaining: number[];
  scanned: boolean;
  /** True when an invalid persisted binding made us skip the destructive path. */
  skipped: boolean;
}

function defaultRun(command: string, args: string[], options: SpawnSyncOptions = {}): RunResult {
  const result = spawnSync(command, args, { encoding: "utf-8", ...options });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  return (
    defaultRun("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
      env,
    }).status === 0
  );
}

function lazyGetSandbox(name: string): SandboxGatewayBinding | null {
  try {
    const registry = require("../state/registry") as {
      getSandbox: (name: string) => SandboxGatewayBinding | null;
    };
    return registry.getSandbox(name);
  } catch {
    return null;
  }
}

function isValidPort(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Resolve the gateway port `nemoclaw stop` should release for the selected
 * sandbox. Prefers an explicit override, then the sandbox's persisted gateway
 * binding, and finally the process-wide `GATEWAY_PORT` (env-derived, default
 * 8080) so a single-sandbox deployment with no registry entry still works.
 *
 * Returns `null` when the sandbox *has* a persisted gateway binding that fails
 * validation. This stop path is destructive (it derives a pid file, scans
 * listeners, and signals matched PIDs), so it mirrors the fail-closed contract
 * of `resolveSandboxGatewayName`: a corrupt or tampered binding must not be
 * silently coerced to the default port, which could stop another sandbox's
 * (or worktree's) default gateway. The legacy/no-registry fallback to
 * `GATEWAY_PORT` is kept only for a missing entry or a legacy entry with no
 * gateway fields (where `resolveSandboxGatewayName` returns the base name).
 */
export function resolveStopGatewayPort(
  options: ReleaseGatewayPortOptions,
  getSandbox: (name: string) => SandboxGatewayBinding | null,
): number | null {
  if (isValidPort(options.port)) return options.port;
  if (options.sandboxName) {
    const entry = getSandbox(options.sandboxName);
    if (entry) {
      // Honor the persisted binding as the source of truth. Fail closed when
      // it does not validate rather than guessing the default port.
      try {
        return resolveGatewayPortFromName(resolveSandboxGatewayName(entry));
      } catch {
        return null;
      }
    }
  }
  return GATEWAY_PORT;
}

function resolveStateDir(port: number, env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.join(homeDir, ".local", "state", "nemoclaw", resolveGatewayStateDirName(port));
}

function listeningPids(
  port: number,
  run: NonNullable<HostGatewayProcessDeps["run"]>,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): number[] | null {
  // Restrict to LISTEN sockets so an in-flight client of the port is never
  // mistaken for the gateway and killed.
  const result = run("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { env });
  if (result.status !== 0 && result.status !== 1) {
    // Status 1 from lsof is "no listeners" — normal. Anything else is a real
    // error (lsof present but failing); surface it and skip the lsof sweep.
    const detail = result.stderr.trim() || `status ${String(result.status)}`;
    warn(`lsof failed while scanning gateway port ${port}: ${detail}`);
    return null;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Stop the NemoClaw-managed host gateway bound to the sandbox's gateway port
 * and confirm the port is released. Best-effort and idempotent: when no
 * gateway is running it is a quiet no-op.
 */
export function releaseManagedGatewayPort(
  options: ReleaseGatewayPortOptions = {},
  depsOverrides: ReleaseGatewayPortDeps = {},
): ReleaseGatewayPortResult {
  const env = depsOverrides.env ?? process.env;
  const homeDir = depsOverrides.homeDir ?? env.HOME ?? os.homedir();
  const run = depsOverrides.run ?? defaultRun;
  const log = depsOverrides.log ?? ((message: string) => console.log(message));
  const warn = depsOverrides.warn ?? ((message: string) => console.warn(message));
  const commandExists =
    depsOverrides.commandExists ?? ((cmd: string) => defaultCommandExists(cmd, env));
  const stopFn = depsOverrides.stopHostGatewayProcesses ?? stopHostGatewayProcesses;
  const getSandbox = depsOverrides.getSandbox ?? lazyGetSandbox;

  const port = resolveStopGatewayPort(options, getSandbox);
  if (port === null) {
    // Fail closed: the sandbox has a persisted gateway binding that does not
    // validate. Skip the destructive path entirely rather than default-port
    // cleanup that could stop another sandbox's gateway.
    warn(
      `Skipping gateway port release for sandbox ${JSON.stringify(options.sandboxName)}: ` +
        "its persisted gateway binding is invalid. Resolve the registry entry, " +
        "then re-run stop.",
    );
    return {
      port: null,
      released: false,
      stopped: [],
      remaining: [],
      scanned: false,
      skipped: true,
    };
  }
  const stateDir = resolveStateDir(port, env, homeDir);
  const pidFile = path.join(stateDir, "openshell-gateway.pid");

  let lsofPids: number[] = [];
  let scanned = false;
  if (commandExists("lsof")) {
    const probe = listeningPids(port, run, env, warn);
    if (probe !== null) {
      lsofPids = probe;
      scanned = true;
    }
  }

  // Delegate to the shared host-gateway stopper. `usePgrepFallback: false`
  // keeps the sweep scoped to this gateway port: the pid file covers the
  // recorded process and the lsof PIDs cover duplicate/orphan gateways
  // squatting the same port. A host-wide pgrep sweep could tear down a
  // different worktree's gateway, which `stop` must never do.
  const hostDeps: Partial<HostGatewayProcessDeps> = { env };
  if (depsOverrides.run) hostDeps.run = depsOverrides.run;
  if (depsOverrides.kill) hostDeps.kill = depsOverrides.kill;
  if (depsOverrides.commandExists) hostDeps.commandExists = depsOverrides.commandExists;
  if (depsOverrides.log) hostDeps.log = depsOverrides.log;
  if (depsOverrides.warn) hostDeps.warn = depsOverrides.warn;

  const stopResult: StopHostGatewayResult = stopFn(hostDeps, {
    pidFile,
    stateDir,
    pids: lsofPids,
    usePgrepFallback: false,
  });

  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const confirmPollIntervalMs = options.confirmPollIntervalMs ?? DEFAULT_CONFIRM_POLL_INTERVAL_MS;
  const now = depsOverrides.now ?? Date.now;

  let released: boolean;
  let remaining: number[] = [];
  const attemptedStop = stopResult.stopped.length > 0 || lsofPids.length > 0;
  if (!scanned) {
    // Could not probe the port (lsof absent or failing). Trust the stopper:
    // released unless it reported a process it could not kill.
    released = stopResult.failed.length === 0;
  } else if (!attemptedStop) {
    // Nothing was bound to the port to begin with — already free.
    released = true;
  } else {
    released = waitUntil(() => (listeningPids(port, run, env, warn) ?? []).length === 0, {
      deadlineMs: now() + confirmTimeoutMs,
      initialIntervalMs: confirmPollIntervalMs,
      maxIntervalMs: confirmPollIntervalMs,
      backoffFactor: 1,
      now,
      ...(depsOverrides.sleep ? { sleep: depsOverrides.sleep } : {}),
    });
    if (!released) remaining = listeningPids(port, run, env, warn) ?? [];
  }

  if (stopResult.stopped.length > 0) {
    log(
      `Released NemoClaw gateway port ${port} (stopped host process ${stopResult.stopped.join(", ")}).`,
    );
  }
  // Only warn when a *matched* gateway process resisted stopping (e.g. a
  // privileged process needing sudo). A port that stays bound by something we
  // deliberately did not touch — a Docker-published port held by docker-proxy,
  // or an unrelated app — is not ours to manage, so a "pkill openshell-gateway"
  // hint there would be misleading.
  if (stopResult.failed.length > 0) {
    warn(
      `NemoClaw gateway port ${port} is still in use after stop ` +
        `(host process ${stopResult.failed.join(", ")} could not be stopped). ` +
        "Run: sudo pkill -f openshell-gateway",
    );
  }

  return { port, released, stopped: stopResult.stopped, remaining, scanned, skipped: false };
}
