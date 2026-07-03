// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-launch reaping for the host OpenShell Docker-driver gateway.
 *
 * When onboard cannot reuse an already-running gateway (its metadata reports
 * unhealthy, the HTTP endpoint is unresponsive, or runtime drift forces a
 * restart) it replaces that gateway with a fresh process. Historically that
 * replacement only sent a single `SIGTERM` and slept one second before
 * spawning — with no `SIGKILL` escalation, no wait for the old process to
 * actually exit, and no sweep of a duplicate listener — so a slow-to-die
 * gateway could still be alive when the new one spawned, leaving two
 * host-process gateways bound to the same port (#5968: "gateway must be shared
 * (exactly one instance …); got container=0 host-process=2").
 *
 * This reuses the shared `stopHostGatewayProcesses` reaper (TERM→KILL with
 * bounded waits, wait-for-exit, and cmdline gating on the `openshell-gateway`
 * identity) so the existing gateway is *confirmed gone* before the caller
 * spawns its replacement. It is scoped to the resolved per-port candidates with
 * `usePgrepFallback: false` — never a host-wide sweep — so a different
 * worktree's gateway on another port is never torn down.
 *
 * Two follow-on guards keep the linked singleton invariant on the start path:
 *   - `reapHostGatewayBeforeLaunchOrFail` fails closed when a matched gateway
 *     resists the reap (`failed` non-empty), so a replacement is never spawned
 *     over a still-alive gateway.
 *   - `reapDuplicateHostGatewaysExcept` lets a reuse path clean up a *known*
 *     stale duplicate (e.g. a previously recorded pid that differs from the
 *     adopted port listener) without tearing down the gateway being reused.
 */

import path from "node:path";

import {
  type HostGatewayProcessDeps,
  type StopHostGatewayResult,
  stopHostGatewayProcesses,
} from "./host-gateway-process";

export interface ReapHostGatewayBeforeLaunchOptions {
  /** Per-port gateway state dir (holds the pid file and runtime marker). */
  stateDir: string;
  /** Recorded gateway pid file; defaults to `<stateDir>/openshell-gateway.pid`. */
  pidFile?: string;
  /** Canonical gateway binary; cmdline-gates which PIDs may be signalled. */
  gatewayBin: string | null;
  /** Extra candidate PIDs to reap (e.g. the current port listener). */
  extraPids?: Array<number | null | undefined>;
}

// A `stopHostGatewayProcesses` result with nothing stopped — returned when there
// is no live candidate to reap so callers always get a well-formed result.
function emptyStopResult(): StopHostGatewayResult {
  return {
    failed: [],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    stopped: [],
    sudoRemediationPids: [],
  };
}

function validPids(pids: Array<number | null | undefined>, exclude?: number): number[] {
  return Array.from(
    new Set(
      pids.filter(
        (pid): pid is number =>
          typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid !== exclude,
      ),
    ),
  );
}

/**
 * Reap any host `openshell-gateway` already bound to this gateway port so the
 * caller can spawn exactly one replacement. Best-effort and idempotent: a quiet
 * no-op when nothing matching is alive. Returns the stopper result so callers
 * (and tests) can observe what was stopped.
 */
export function reapHostGatewayBeforeLaunch(
  options: ReapHostGatewayBeforeLaunchOptions,
  deps: Partial<HostGatewayProcessDeps> = {},
  stop: typeof stopHostGatewayProcesses = stopHostGatewayProcesses,
): StopHostGatewayResult {
  return stop(
    { env: process.env, ...deps },
    {
      pids: validPids(options.extraPids ?? []),
      pidFile: options.pidFile ?? path.join(options.stateDir, "openshell-gateway.pid"),
      stateDir: options.stateDir,
      gatewayBin: options.gatewayBin,
      // PID-file state is bookkeeping, not proof that the process owns this
      // port. Signal only the port-observed candidates supplied by the caller;
      // a stale/recycled PID must never reap another worktree's gateway.
      usePidFile: false,
      usePgrepFallback: false,
    },
  );
}

/**
 * Message describing host gateways the prelaunch reap could not stop, or `null`
 * when the port is clear. A non-empty `failed` means a matched gateway resisted
 * TERM→KILL (e.g. a privileged process); spawning a replacement over it would
 * leave two host gateways (#5968 host-process=2), so callers must fail closed.
 */
export function prelaunchReapFailureMessage(result: StopHostGatewayResult): string | null {
  if (result.failed.length === 0) return null;
  // Recommend killing exactly the PIDs we matched, not a host-wide
  // `pkill -f openshell-gateway`: this path is deliberately scoped to this port
  // (usePgrepFallback:false), so a host-wide kill could take down another
  // worktree's gateway.
  return (
    "Refusing to start a second OpenShell gateway: existing host gateway process " +
    `${result.failed.join(", ")} could not be stopped. Run: sudo kill -9 ${result.failed.join(" ")}`
  );
}

/**
 * Reap the existing host gateway for this port, then fail closed when a matched
 * gateway resisted stopping so onboard never spawns a replacement over a
 * still-alive gateway. Honours `exitOnFailure` like the rest of onboard:
 * `process.exit(1)` when set, otherwise throw. Returns the (cleared) stop result.
 */
export function reapHostGatewayBeforeLaunchOrFail(
  options: ReapHostGatewayBeforeLaunchOptions & { exitOnFailure?: boolean },
  deps: Partial<HostGatewayProcessDeps> = {},
  stop: typeof stopHostGatewayProcesses = stopHostGatewayProcesses,
  exit: (code: number) => never = (code) => process.exit(code) as never,
): StopHostGatewayResult {
  const result = reapHostGatewayBeforeLaunch(options, deps, stop);
  const failure = prelaunchReapFailureMessage(result);
  if (failure) {
    console.error(`  ${failure}`);
    if (options.exitOnFailure) exit(1);
    throw new Error(failure);
  }
  return result;
}

/**
 * Reap KNOWN host gateways (cmdline-gated, no host-wide pgrep sweep) other than
 * the gateway being reused, so a reuse path can enforce a single matching host
 * gateway without tearing down the adopted one. Used when a previously recorded
 * gateway pid differs from the port listener now being adopted — that stale pid
 * is a duplicate orphan and is reaped here. A quiet no-op when the only known
 * candidate is `keepPid`. Pid-file discovery and runtime-file cleanup are
 * disabled so the adopted gateway's live state is never read as a candidate or
 * cleared.
 */
export function reapDuplicateHostGatewaysExcept(
  keepPid: number,
  gatewayBin: string | null,
  candidatePids: Array<number | null | undefined>,
  deps: Partial<HostGatewayProcessDeps> = {},
  stop: typeof stopHostGatewayProcesses = stopHostGatewayProcesses,
): StopHostGatewayResult {
  const pids = validPids(candidatePids, keepPid);
  if (pids.length === 0) return emptyStopResult();
  return stop(
    { env: process.env, ...deps },
    {
      clearRuntimeFiles: false,
      pids,
      gatewayBin,
      usePidFile: false,
      usePgrepFallback: false,
    },
  );
}

/**
 * Like `reapDuplicateHostGatewaysExcept`, but fail closed when a matched
 * duplicate resisted stopping (`failed` non-empty): a reuse path must not report
 * success while a second matching host gateway is still alive (#5968). Honours
 * `exitOnFailure` (`process.exit(1)` when set, otherwise throw).
 */
export function reapDuplicateHostGatewaysExceptOrFail(
  keepPid: number,
  gatewayBin: string | null,
  candidatePids: Array<number | null | undefined>,
  exitOnFailure?: boolean,
  deps: Partial<HostGatewayProcessDeps> = {},
  stop: typeof stopHostGatewayProcesses = stopHostGatewayProcesses,
  exit: (code: number) => never = (code) => process.exit(code) as never,
): StopHostGatewayResult {
  const result = reapDuplicateHostGatewaysExcept(keepPid, gatewayBin, candidatePids, deps, stop);
  const failure = prelaunchReapFailureMessage(result);
  if (failure) {
    console.error(`  ${failure}`);
    if (exitOnFailure) exit(1);
    throw new Error(failure);
  }
  return result;
}
