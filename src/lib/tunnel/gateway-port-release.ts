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
  // `command` is always an internal, trusted literal ("lsof"); it is never
  // user-supplied. It is also JSON.stringify-quoted, so the `sh -c` here carries
  // no shell-injection surface.
  return (
    defaultRun("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
      env,
    }).status === 0
  );
}

function lazyGetSandbox(name: string): SandboxGatewayBinding | null {
  // Intentionally does not swallow lookup errors: a registry read that throws
  // (e.g. a corrupt registry file) must reach resolveStopGatewayPort's
  // fail-closed handling rather than being treated as a clean "no entry",
  // which would fall back to destructive default-port cleanup.
  const registry = require("../state/registry") as {
    getSandbox: (name: string) => SandboxGatewayBinding | null;
  };
  return registry.getSandbox(name);
}

function isValidPort(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Stderr debug logger gated on `NODE_DEBUG=nemoclaw:gateway`. The fail-closed
 * catch branches below skip the destructive path silently by design (a stop
 * must not be noisy about a corrupt/missing binding), but an operator
 * debugging "why was gateway release skipped?" can opt into the detail without
 * changing default behavior.
 */
function makeGatewayDebug(env: NodeJS.ProcessEnv): (message: string) => void {
  const enabled = (env.NODE_DEBUG ?? "").includes("nemoclaw:gateway");
  return enabled ? (message: string) => console.error(`[nemoclaw:gateway] ${message}`) : () => {};
}

/**
 * Resolve the gateway port `nemoclaw stop` should release for the selected
 * sandbox. Prefers an explicit override, then the sandbox's persisted gateway
 * binding.
 *
 * This stop path is destructive (it derives a pid file, scans listeners, and
 * signals matched PIDs), so it fails closed — returns `null` to skip the
 * destructive path — in every case where the selected sandbox's gateway port
 * cannot be trusted:
 *   - an explicit `port` override is present but out of range (a caller error,
 *     not a request to clean the default gateway port);
 *   - the registry lookup itself throws (e.g. a corrupt registry);
 *   - the sandbox *has* a persisted binding that fails validation (mirroring
 *     `resolveSandboxGatewayName`'s fail-closed contract: a corrupt or tampered
 *     binding must not be silently coerced to the default port);
 *   - a *named* sandbox has no registry entry at all. Coercing an absent named
 *     entry to the process-wide `GATEWAY_PORT` could tear down another sandbox's
 *     (or worktree's) default gateway — the same hazard `stopAll()` avoids for
 *     the no-sandbox path, where the default port is not tied to the selected
 *     `pidDir`.
 *
 * The `GATEWAY_PORT` fallback (env-derived, default 8080) is kept only for a
 * call with no sandbox name (a direct "release the default gateway" request)
 * and for a real legacy entry with no gateway fields (e.g. `{}`), which
 * `resolveSandboxGatewayName` maps to the base `nemoclaw` name so existing
 * single-sandbox deployments keep working.
 */
export function resolveStopGatewayPort(
  options: ReleaseGatewayPortOptions,
  getSandbox: (name: string) => SandboxGatewayBinding | null,
  debug: (message: string) => void = () => {},
): number | null {
  // An explicit port override that is present but invalid fails closed (null)
  // rather than silently falling through to sandbox/default resolution: an
  // out-of-range override is a caller error, not a request to clean the
  // default gateway port. An absent override (undefined) continues to the
  // registry binding below.
  if (options.port !== undefined) return isValidPort(options.port) ? options.port : null;
  if (options.sandboxName) {
    let entry: SandboxGatewayBinding | null;
    try {
      entry = getSandbox(options.sandboxName);
    } catch (error) {
      // Registry lookup itself failed (e.g. corrupt registry). Fail closed
      // rather than falling back to default-port cleanup.
      //
      // Source-of-truth review: invalid state = a registry file that throws on
      // read (corruption); source boundary = the registry write path
      // (`state/registry`), which should guarantee a readable file; this is the
      // defensive read-time guard; regression test = "skips the destructive
      // path when the registry lookup throws"; removal condition = when the
      // registry write path validates/heals so a lookup cannot throw.
      debug(
        `registry lookup for sandbox ${JSON.stringify(options.sandboxName)} threw; ` +
          `skipping gateway release: ${(error as Error).message ?? String(error)}`,
      );
      return null;
    }
    if (entry) {
      // Honor the persisted binding as the source of truth. Fail closed when
      // it does not validate rather than guessing the default port.
      //
      // Source-of-truth review: invalid state = a corrupt/tampered
      // gatewayPort/gatewayName in a persisted entry; source boundary = the
      // onboard/registry write path (`resolveSandboxGatewayName` validates on
      // write, but pre-existing rows may be invalid); regression test = "does
      // not fall back to the default port when the persisted gateway binding is
      // invalid"; removal condition = when registry migration validates all
      // existing entries.
      try {
        return resolveGatewayPortFromName(resolveSandboxGatewayName(entry));
      } catch (error) {
        debug(
          `persisted gateway binding for sandbox ${JSON.stringify(options.sandboxName)} is invalid; ` +
            `skipping gateway release: ${(error as Error).message ?? String(error)}`,
        );
        return null;
      }
    }
    // Named sandbox with no registry entry: fail closed. A legacy entry with
    // no gateway fields is honored above (it is truthy); only a truly absent
    // entry reaches here, and default-port cleanup for an unknown name could
    // stop a different sandbox's/worktree's gateway.
    return null;
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
  const debug = makeGatewayDebug(env);

  const port = resolveStopGatewayPort(options, getSandbox, debug);
  if (port === null) {
    // Fail closed: the sandbox's persisted gateway binding is invalid or its
    // registry entry could not be read. Skip the destructive path entirely
    // rather than default-port cleanup that could stop another sandbox's
    // gateway.
    warn(
      `Skipping gateway port release for sandbox ${JSON.stringify(options.sandboxName)}: ` +
        "no valid gateway binding is registered for it (the entry is missing, " +
        "invalid, or unreadable). Resolve the registry entry, then re-run stop.",
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
  // Distinct from `lsof absent`: lsof is present but the probe itself errored, so
  // we genuinely could not observe the port and must not optimistically release.
  let scanFailed = false;
  if (commandExists("lsof")) {
    const probe = listeningPids(port, run, env, warn);
    if (probe !== null) {
      lsofPids = probe;
      scanned = true;
    } else {
      scanFailed = true;
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
    // Could not probe the port. When lsof is simply absent we trust the stopper:
    // released unless it reported a process it could not kill. Known limitation:
    // with lsof unavailable we cannot observe a non-pid-file squatter still holding
    // the port, so `released` may be optimistic in that case. But when lsof was
    // present and the scan itself errored (`scanFailed`), we confirmed nothing —
    // fail closed so `stopAll` surfaces its unconfirmed-release warning.
    released = !scanFailed && stopResult.failed.length === 0;
  } else if (!attemptedStop) {
    // Nothing was bound to the port to begin with — already free.
    released = true;
  } else {
    // A null probe means lsof itself errored — that is not a confirmation that
    // the port is free, so it must not coerce to released. Track it so a
    // transient lsof failure after the stop attempt cannot be reported as a
    // released port.
    let confirmProbeFailed = false;
    released = waitUntil(
      () => {
        const pids = listeningPids(port, run, env, warn);
        confirmProbeFailed = pids === null;
        return pids !== null && pids.length === 0;
      },
      {
        deadlineMs: now() + confirmTimeoutMs,
        initialIntervalMs: confirmPollIntervalMs,
        maxIntervalMs: confirmPollIntervalMs,
        backoffFactor: 1,
        now,
        ...(depsOverrides.sleep ? { sleep: depsOverrides.sleep } : {}),
      },
    );
    if (confirmProbeFailed) released = false;
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
