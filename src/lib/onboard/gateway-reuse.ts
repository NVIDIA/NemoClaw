// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import {
  getGatewayReuseState,
  type GatewayReuseState,
  shouldSelectNamedGatewayForReuse,
} from "../state/gateway";
import * as dockerDriverGatewayLaunch from "./docker-driver-gateway-launch";
import * as gatewayService from "./docker-driver-gateway-service";
import type { PortProbeResult } from "./preflight";

export type GatewayReuseSnapshot = {
  gatewayStatus: string;
  gwInfo: string;
  activeGatewayInfo: string;
  gatewayReuseState: ReturnType<typeof getGatewayReuseState>;
};

export interface GatewayReuseDeps {
  gatewayName: string | (() => string);
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string;
  runOpenshell(args: string[], opts?: Record<string, unknown>): { status: number | null };
  cliDisplayName(): string;
}

export interface GatewayReuseHelpers {
  getGatewayReuseSnapshot(): GatewayReuseSnapshot;
  selectNamedGatewayForReuseIfNeeded(snapshot: GatewayReuseSnapshot): GatewayReuseSnapshot;
}

export interface DockerDriverGatewayReuseApplicationDeps {
  gatewayName(): string;
  getGatewayCompatContainerName(): string;
  isDockerDriverGatewayEnabled(): boolean;
  resolveOpenShellGatewayBinary(): string | null;
  getDockerDriverGatewayEnv(versionOutput?: string | null): Record<string, string>;
  runCaptureOpenshell(args: string[], opts?: { ignoreError?: boolean }): string;
  getDockerDriverGatewayStateDir(): string;
  resolveOpenShellSandboxBinary(): string | null;
  getDockerDriverGatewayPid(): number | null;
  isDockerDriverGatewayProcessAlive(): boolean;
  getDockerDriverGatewayReuseDrift(
    pid: number,
    desiredEnv: Record<string, string>,
    gatewayBin?: string | null,
    trustedServicePid?: number | null,
  ): { reason: string } | null;
  checkGatewayPortAvailable(): Promise<PortProbeResult>;
  getDockerDriverGatewayPortListenerPid(
    portCheck: PortProbeResult,
    opts?: { gatewayBin?: string | null },
  ): number | null;
  rememberDockerDriverGatewayPid(pid: number): void;
  buildDockerDriverGatewayRuntimeIdentity?: typeof dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity;
  resolveDriftGatewayBin?: typeof dockerDriverGatewayLaunch.resolveDriftGatewayBin;
  getTrustedActiveOpenShellGatewayUserServicePid?: typeof gatewayService.getTrustedActiveOpenShellGatewayUserServicePid;
  log?(message: string): void;
}

export interface DockerDriverGatewayReuseApplication {
  refreshDockerDriverGatewayReuseState(state: GatewayReuseState): Promise<GatewayReuseState>;
}

export function createDockerDriverGatewayReuseApplication(
  deps: DockerDriverGatewayReuseApplicationDeps,
): DockerDriverGatewayReuseApplication {
  const buildRuntimeIdentity =
    deps.buildDockerDriverGatewayRuntimeIdentity ??
    dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity;
  const resolveDriftGatewayBin =
    deps.resolveDriftGatewayBin ?? dockerDriverGatewayLaunch.resolveDriftGatewayBin;
  const getTrustedServicePid =
    deps.getTrustedActiveOpenShellGatewayUserServicePid ??
    gatewayService.getTrustedActiveOpenShellGatewayUserServicePid;
  const log = deps.log ?? console.log;

  async function refreshDockerDriverGatewayReuseState(
    state: GatewayReuseState,
  ): Promise<GatewayReuseState> {
    if (!deps.isDockerDriverGatewayEnabled() || state !== "healthy") return state;

    const gatewayBin = deps.resolveOpenShellGatewayBinary();
    const baseDesiredEnv = deps.getDockerDriverGatewayEnv(
      deps.runCaptureOpenshell(["--version"], { ignoreError: true }),
    );
    const runtimeIdentity = gatewayBin
      ? buildRuntimeIdentity({
          gatewayBin,
          gatewayEnv: baseDesiredEnv,
          stateDir: deps.getDockerDriverGatewayStateDir(),
          sandboxBin: deps.resolveOpenShellSandboxBinary(),
          gatewayName: deps.gatewayName(),
          compatContainerName: deps.getGatewayCompatContainerName(),
        })
      : null;
    const desiredEnv = runtimeIdentity?.desiredEnv ?? baseDesiredEnv;
    const driftBin = resolveDriftGatewayBin(runtimeIdentity, gatewayBin);
    const identityBin = runtimeIdentity?.identityGatewayBin ?? gatewayBin;
    const managedServicePid = getTrustedServicePid();
    const pid = deps.getDockerDriverGatewayPid();
    if (pid !== null && deps.isDockerDriverGatewayProcessAlive()) {
      const drift = deps.getDockerDriverGatewayReuseDrift(
        pid,
        desiredEnv,
        driftBin,
        managedServicePid,
      );
      if (drift) {
        log(
          `  Existing OpenShell Docker-driver gateway is stale (${drift.reason}); it will be recreated.`,
        );
        return "stale";
      }
      return state;
    }

    const portCheck = await deps.checkGatewayPortAvailable();
    const dockerGatewayPid = deps.getDockerDriverGatewayPortListenerPid(portCheck, {
      gatewayBin: identityBin,
    });
    if (dockerGatewayPid !== null) {
      const drift = deps.getDockerDriverGatewayReuseDrift(
        dockerGatewayPid,
        desiredEnv,
        driftBin,
        managedServicePid,
      );
      if (dockerGatewayPid !== managedServicePid) {
        deps.rememberDockerDriverGatewayPid(dockerGatewayPid);
      }
      if (drift) {
        log(
          `  Existing OpenShell Docker-driver gateway is stale (${drift.reason}); it will be recreated.`,
        );
        return "stale";
      }
      return "healthy";
    }

    // OpenShell status already proved the selected gateway is reachable. Preserve it when
    // the port probe cannot identify an owner, instead of deleting a potentially live gateway.
    if (!portCheck.ok && !portCheck.pid) return "healthy";

    return "stale";
  }

  return { refreshDockerDriverGatewayReuseState };
}

export function createGatewayReuseHelpers(deps: GatewayReuseDeps): GatewayReuseHelpers {
  const currentGatewayName = () =>
    typeof deps.gatewayName === "function" ? deps.gatewayName() : deps.gatewayName;

  function getGatewayReuseSnapshot(): GatewayReuseSnapshot {
    const gatewayName = currentGatewayName();
    const probeOptions = { ignoreError: true, timeout: OPENSHELL_PROBE_TIMEOUT_MS };
    const gatewayStatus = deps.runCaptureOpenshell(["status"], {
      ...probeOptions,
      includeStderr: true,
    });
    const gwInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
      ...probeOptions,
    });
    const activeGatewayInfo = deps.runCaptureOpenshell(["gateway", "info"], probeOptions);
    return {
      gatewayStatus,
      gwInfo,
      activeGatewayInfo,
      gatewayReuseState: getGatewayReuseState(
        gatewayStatus,
        gwInfo,
        activeGatewayInfo,
        gatewayName,
      ),
    };
  }

  function selectNamedGatewayForReuseIfNeeded(
    snapshot: GatewayReuseSnapshot,
  ): GatewayReuseSnapshot {
    const gatewayName = currentGatewayName();
    if (
      !shouldSelectNamedGatewayForReuse(
        snapshot.gatewayStatus,
        snapshot.gwInfo,
        snapshot.activeGatewayInfo,
        gatewayName,
      )
    ) {
      return snapshot;
    }

    const selectResult = deps.runOpenshell(["gateway", "select", gatewayName], {
      ignoreError: true,
      suppressOutput: true,
    });
    if (selectResult.status !== 0) {
      return snapshot;
    }

    const refreshed = getGatewayReuseSnapshot();
    if (refreshed.gatewayReuseState === "healthy") {
      process.env.OPENSHELL_GATEWAY = gatewayName;
      console.log(`  ✓ Selected existing ${deps.cliDisplayName()} gateway`);
    }
    return refreshed;
  }

  return { getGatewayReuseSnapshot, selectNamedGatewayForReuseIfNeeded };
}
