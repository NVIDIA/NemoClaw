// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Port-scoped host gateway release for `nemoclaw stop` (#5968). */

import os from "node:os";

import type { SandboxGatewayBinding } from "../onboard/gateway-binding";
import {
  type HostGatewayProcessDeps,
  type StopHostGatewayResult,
  stopHostGatewayProcesses,
} from "../onboard/host-gateway-process";
import { getSandbox as getRegisteredSandbox } from "../state/registry";
import { confirmGatewayPortReleased, defaultProbePortFree } from "./gateway-port-confirmation";
import {
  defaultGatewayReleaseCommandExists,
  defaultGatewayReleaseRun,
  listeningGatewayPids,
} from "./gateway-port-listeners";
import {
  makeGatewayDebug,
  resolveGatewayReleaseStateDir,
  resolveStopGatewayPort,
} from "./gateway-port-resolution";

export { resolveStopGatewayPort };

export interface ReleaseGatewayPortDeps extends Partial<HostGatewayProcessDeps> {
  homeDir?: string;
  now?: () => number;
  sleep?: (ms: number) => void;
  stopHostGatewayProcesses?: typeof stopHostGatewayProcesses;
  getSandbox?: (name: string) => SandboxGatewayBinding | null;
  probePortFree?: (port: number) => boolean;
}

export interface ReleaseGatewayPortOptions {
  sandboxName?: string;
  port?: number;
  confirmTimeoutMs?: number;
  confirmPollIntervalMs?: number;
}

export interface ReleaseGatewayPortResult {
  port: number | null;
  released: boolean;
  stopped: number[];
  remaining: number[];
  scanned: boolean;
  skipped: boolean;
}

/**
 * Stop cmdline-verified gateway listeners on the selected port and prove the
 * port can be rebound. PID-file contents are never signal candidates on their
 * own: only lsof-observed PIDs are passed to the stopper, preventing a stale or
 * recycled PID from killing another worktree's same-named gateway.
 */
export function releaseManagedGatewayPort(
  options: ReleaseGatewayPortOptions = {},
  depsOverrides: ReleaseGatewayPortDeps = {},
): ReleaseGatewayPortResult {
  const env = depsOverrides.env ?? process.env;
  const homeDir = depsOverrides.homeDir ?? env.HOME ?? os.homedir();
  const run = depsOverrides.run ?? defaultGatewayReleaseRun;
  const log = depsOverrides.log ?? ((message: string) => console.log(message));
  const warn = depsOverrides.warn ?? ((message: string) => console.warn(message));
  const commandExists =
    depsOverrides.commandExists ??
    ((command: string) => defaultGatewayReleaseCommandExists(command, env));
  const stop = depsOverrides.stopHostGatewayProcesses ?? stopHostGatewayProcesses;
  const getSandbox = depsOverrides.getSandbox ?? getRegisteredSandbox;
  const probePortFree = depsOverrides.probePortFree ?? defaultProbePortFree;

  const port = resolveStopGatewayPort(options, getSandbox, makeGatewayDebug(env), warn);
  if (port === null) {
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

  const stateDir = resolveGatewayReleaseStateDir(port, env, homeDir);
  let lsofPids: number[] = [];
  let scanned = false;
  // An initial lsof failure is distinct from lsof being unavailable: the
  // observation tool exists but returned an error, so even a later bind probe
  // must not mask the incomplete destructive scan.
  let scanFailed = false;
  if (commandExists("lsof")) {
    const result = listeningGatewayPids(port, run, env, warn);
    if (result === null) scanFailed = true;
    else {
      lsofPids = result;
      scanned = true;
    }
  }

  const hostDeps: Partial<HostGatewayProcessDeps> = { env };
  if (depsOverrides.run) hostDeps.run = depsOverrides.run;
  if (depsOverrides.kill) hostDeps.kill = depsOverrides.kill;
  if (depsOverrides.commandExists) hostDeps.commandExists = depsOverrides.commandExists;
  if (depsOverrides.log) hostDeps.log = depsOverrides.log;
  if (depsOverrides.warn) hostDeps.warn = depsOverrides.warn;

  const stopResult: StopHostGatewayResult = stop(hostDeps, {
    stateDir,
    pids: lsofPids,
    // A per-port PID file is bookkeeping, not proof that its PID owns this
    // port. Only the lsof-observed, cmdline-gated candidates are signal-safe.
    usePidFile: false,
    usePgrepFallback: false,
  });

  // During confirmation, listeningGatewayPids() returns null on a real lsof
  // error. confirmGatewayPortReleased treats that as non-release and keeps
  // polling within its fixed deadline/attempt bound; it never coerces a failed
  // observation to an empty listener set.
  const confirmation =
    !scanFailed && stopResult.failed.length === 0
      ? confirmGatewayPortReleased({
          port,
          timeoutMs: options.confirmTimeoutMs ?? 2000,
          pollIntervalMs: options.confirmPollIntervalMs ?? 100,
          now: depsOverrides.now ?? Date.now,
          ...(depsOverrides.sleep ? { sleep: depsOverrides.sleep } : {}),
          probePortFree,
          ...(scanned ? { listeningPids: () => listeningGatewayPids(port, run, env, warn) } : {}),
        })
      : { released: false, remaining: stopResult.failed };

  if (confirmation.released && stopResult.stopped.length > 0) {
    log(
      `Released NemoClaw gateway port ${port} (stopped host process ${stopResult.stopped.join(", ")}).`,
    );
  }
  if (stopResult.failed.length > 0) {
    warn(
      `NemoClaw gateway port ${port} is still in use after stop ` +
        `(host process ${stopResult.failed.join(", ")} could not be stopped). ` +
        `Run: sudo kill -9 ${stopResult.failed.join(" ")}`,
    );
  }

  return {
    port,
    released: confirmation.released,
    stopped: stopResult.stopped,
    remaining: confirmation.remaining,
    scanned,
    skipped: false,
  };
}
