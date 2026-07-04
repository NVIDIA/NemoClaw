// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DockerDriverGatewayPortListenerScan } from "./docker-driver-gateway-port-listener";

interface GatewayHealthSnapshot {
  status: string;
  namedInfo: string;
  activeInfo: string;
}

export interface DockerDriverGatewayCutoverInput {
  gatewayBin: string | null;
  identityGatewayBin: string | null;
  driftGatewayBin: string | null;
  driftGatewayEnv: Record<string, string>;
  exitOnFailure: boolean;
  skipSandboxBridgeReachability: boolean;
  stateDir: string;
  portListenerScan: DockerDriverGatewayPortListenerScan;
  pidFileGatewayPid: number | null;
  initialHealth: GatewayHealthSnapshot;
}

export interface DockerDriverGatewayCutoverDeps {
  isDockerDriverGatewayProcessAlive(): boolean;
  isGatewayHealthy(status: string, namedInfo: string, activeInfo: string): boolean;
  getDockerDriverGatewayRuntimeDrift(
    pid: number,
    desiredEnv: Record<string, string>,
    gatewayBin: string | null,
  ): { reason: string } | null;
  logDockerDriverGatewayRestart(reason: string): void;
  registerDockerDriverGatewayEndpoint(): boolean;
  isDockerDriverGatewayHttpReady(): Promise<boolean>;
  verifySandboxBridgeGatewayReachableOrExit(
    exitOnFailure: boolean,
    options: { skip: boolean },
  ): Promise<void>;
  readGatewayHealth(): GatewayHealthSnapshot;
  rememberDockerDriverGatewayPid(pid: number): void;
  reapDuplicateHostGatewaysExceptOrFail(
    keepPid: number,
    gatewayBin: string | null,
    candidatePids: number[],
    exitOnFailure: boolean,
  ): unknown;
  reapHostGatewayBeforeLaunchOrFail(options: {
    stateDir: string;
    gatewayBin: string | null;
    extraPids: number[];
    exitOnFailure: boolean;
  }): unknown;
  isGatewayPortAvailable(): Promise<boolean>;
  reportUntrustedGatewayPort(message: string): never;
  reportMissingGatewayBinary(): never;
  log(message: string): void;
}

/**
 * Resolve reuse, adoption, or replacement for the host Docker-driver gateway.
 * Every reuse path requires a complete listener scan; replacement reaps only
 * port-observed PIDs before the fresh-launch callback is allowed to run.
 */
export async function runDockerDriverGatewayCutover(
  input: DockerDriverGatewayCutoverInput,
  deps: DockerDriverGatewayCutoverDeps,
): Promise<"reused" | "launch"> {
  const portListenerPids = input.portListenerScan.pids;
  const portListenerPid = input.portListenerScan.complete ? (portListenerPids[0] ?? null) : null;

  const pidFileGatewayAlive =
    input.pidFileGatewayPid !== null && deps.isDockerDriverGatewayProcessAlive();
  const pidFileGatewayDrift = pidFileGatewayAlive
    ? deps.getDockerDriverGatewayRuntimeDrift(
        input.pidFileGatewayPid as number,
        input.driftGatewayEnv,
        input.driftGatewayBin,
      )
    : null;
  // PID-file state alone is never a cleanup candidate: on macOS a stale marker
  // cannot distinguish PID reuse after reboot. Same-port duplicates are safe
  // only when the complete listener scan observed them explicitly.
  const cleanupPids = portListenerPids;

  if (
    input.portListenerScan.complete &&
    portListenerPids.length === 1 &&
    input.pidFileGatewayPid !== null &&
    portListenerPids[0] === input.pidFileGatewayPid &&
    pidFileGatewayAlive &&
    deps.isGatewayHealthy(
      input.initialHealth.status,
      input.initialHealth.namedInfo,
      input.initialHealth.activeInfo,
    )
  ) {
    const drift = pidFileGatewayDrift;
    if (drift) {
      deps.logDockerDriverGatewayRestart(drift.reason);
    } else if (
      deps.registerDockerDriverGatewayEndpoint() &&
      (await deps.isDockerDriverGatewayHttpReady())
    ) {
      await deps.verifySandboxBridgeGatewayReachableOrExit(input.exitOnFailure, {
        skip: input.skipSandboxBridgeReachability,
      });
      deps.log("  ✓ Reusing existing Docker-driver gateway");
      return "reused";
    } else {
      deps.log(
        "  Docker-driver gateway metadata reports healthy but its HTTP endpoint is not responding. Starting a fresh gateway...",
      );
    }
  }

  if (portListenerPid !== null) {
    const drift =
      pidFileGatewayAlive && portListenerPid === input.pidFileGatewayPid
        ? pidFileGatewayDrift
        : deps.getDockerDriverGatewayRuntimeDrift(
            portListenerPid,
            input.driftGatewayEnv,
            input.driftGatewayBin,
          );
    if (drift) deps.logDockerDriverGatewayRestart(drift.reason);
    else deps.rememberDockerDriverGatewayPid(portListenerPid);

    if (!drift && deps.registerDockerDriverGatewayEndpoint()) {
      const health = deps.readGatewayHealth();
      if (
        deps.isGatewayHealthy(health.status, health.namedInfo, health.activeInfo) &&
        (await deps.isDockerDriverGatewayHttpReady())
      ) {
        deps.reapDuplicateHostGatewaysExceptOrFail(
          portListenerPid,
          input.identityGatewayBin,
          cleanupPids,
          input.exitOnFailure,
        );
        await deps.verifySandboxBridgeGatewayReachableOrExit(input.exitOnFailure, {
          skip: input.skipSandboxBridgeReachability,
        });
        deps.log(`  ✓ Reusing existing Docker-driver gateway process (PID ${portListenerPid})`);
        return "reused";
      }
    }
  }

  if (!input.gatewayBin) deps.reportMissingGatewayBinary();
  deps.reapHostGatewayBeforeLaunchOrFail({
    stateDir: input.stateDir,
    gatewayBin: input.identityGatewayBin,
    extraPids: cleanupPids,
    exitOnFailure: input.exitOnFailure,
  });
  if (!(await deps.isGatewayPortAvailable())) {
    deps.reportUntrustedGatewayPort(
      input.portListenerScan.complete
        ? "the gateway port remains occupied after scoped cleanup"
        : "listener enumeration was incomplete and the gateway port remains occupied after scoped cleanup",
    );
  }
  return "launch";
}
