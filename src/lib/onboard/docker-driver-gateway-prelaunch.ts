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
 */

import {
  type HostGatewayProcessDeps,
  type StopHostGatewayResult,
  stopHostGatewayProcesses,
} from "./host-gateway-process";

export interface ReapHostGatewayBeforeLaunchOptions {
  /** Pid file in the gateway's per-port state dir (the recorded gateway pid). */
  pidFile: string;
  /** Per-port gateway state dir (holds the pid file and runtime marker). */
  stateDir: string;
  /** Canonical gateway binary; cmdline-gates which PIDs may be signalled. */
  gatewayBin: string | null;
  /** Extra candidate PIDs to reap (e.g. the current port listener). */
  extraPids?: Array<number | null | undefined>;
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
  const pids = (options.extraPids ?? []).filter(
    (pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0,
  );
  return stop(
    { env: process.env, ...deps },
    {
      pids,
      pidFile: options.pidFile,
      stateDir: options.stateDir,
      gatewayBin: options.gatewayBin,
      // Scope strictly to this port's recorded pid + the passed listener PID.
      // A host-wide pgrep sweep could reap a different worktree's gateway.
      usePgrepFallback: false,
    },
  );
}
