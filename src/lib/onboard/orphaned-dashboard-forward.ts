// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CheckPortOpts, PortProbeResult } from "./preflight";

import { getOccupiedPorts } from "./dashboard-port";

export type ListForwardsRunner = (
  args: string[],
  opts: { timeout?: number; suppressOutput?: boolean },
) => string;

export type KillRunner = (args: string[], opts: { ignoreError?: boolean }) => unknown;

export type CheckPortAvailableFn = (port: number, opts?: CheckPortOpts) => Promise<PortProbeResult>;

export type SleepFn = (seconds: number) => void;

export interface OrphanedDashboardForwardDeps {
  port: number;
  pid: number;
  label: string;
  portCheckOptions?: CheckPortOpts;
  captureProcessArgs(pid: number): string;
  runCaptureOpenshell: ListForwardsRunner;
  run: KillRunner;
  sleepSeconds: SleepFn;
  checkPortAvailable: CheckPortAvailableFn;
  log?: (message: string) => void;
}

export type OrphanedDashboardForwardOutcome =
  | { kind: "not-openshell" }
  | { kind: "list-failed" }
  | { kind: "owned-by-live"; owner: string }
  | { kind: "killed-cleared" }
  | { kind: "killed-still-blocked"; portCheck: PortProbeResult };

/**
 * Decide whether an orphaned SSH port-forward sitting on the dashboard port
 * can be killed to free the port. The caller has already detected that the
 * port is blocked by an `ssh` listener (typical signature of a stale
 * `openshell forward start` left behind after a previous session).
 *
 * Cross-instance safety is enforced by consulting `openshell forward list`
 * for the live owner:
 *   - `not-openshell`     — listener is unrelated SSH; caller should fall
 *                           through to the generic port-blocked error path.
 *   - `list-failed`       — could not enumerate forwards; the kill is
 *                           SKIPPED. With no ownership data, a kill could
 *                           collateral-damage a concurrent live sandbox's
 *                           dashboard forward. Caller continues — the runtime
 *                           allocator will pick a different dashboard port.
 *   - `owned-by-live`     — another live sandbox holds the forward; kill is
 *                           skipped, caller continues with auto-allocation.
 *   - `killed-cleared`    — kill succeeded and the port is now free.
 *   - `killed-still-blocked` — kill ran but the port stayed blocked; the
 *                           refreshed `portCheck` is returned so the caller
 *                           can fall through to the generic port-blocked
 *                           error path with up-to-date diagnostics.
 *
 * The `forward list` call is intentionally allowed to throw — `ignoreError`
 * would swallow the failure into an empty string, which `getOccupiedPorts`
 * parses as an empty map, and the "no entry → kill" branch would still run
 * with no ownership data.
 */
export async function tryCleanupOrphanedDashboardForward(
  deps: OrphanedDashboardForwardDeps,
): Promise<OrphanedDashboardForwardOutcome> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const cmdline = deps.captureProcessArgs(deps.pid);
  if (!cmdline.includes("openshell")) {
    return { kind: "not-openshell" };
  }

  let listOutput: string;
  try {
    listOutput = deps.runCaptureOpenshell(["forward", "list"], {
      suppressOutput: true,
      timeout: 10_000,
    });
  } catch {
    log(
      `  Could not enumerate OpenShell forwards while checking port ${deps.port}; leaving its forward intact to avoid killing a live sandbox.`,
    );
    return { kind: "list-failed" };
  }

  const owner = getOccupiedPorts(listOutput).get(String(deps.port)) ?? null;
  if (owner) {
    log(
      `  Port ${deps.port} held by live sandbox '${owner}'; leaving its forward intact (this sandbox will auto-allocate a different dashboard port).`,
    );
    return { kind: "owned-by-live", owner };
  }

  log(`  Cleaning up orphaned SSH port-forward on port ${deps.port} (PID ${deps.pid})...`);
  deps.run(["kill", String(deps.pid)], { ignoreError: true });
  deps.sleepSeconds(1);
  const portCheck = await deps.checkPortAvailable(deps.port, deps.portCheckOptions);
  if (portCheck.ok) {
    log(`  ✓ Port ${deps.port} available after orphaned forward cleanup (${deps.label})`);
    return { kind: "killed-cleared" };
  }
  return { kind: "killed-still-blocked", portCheck };
}
