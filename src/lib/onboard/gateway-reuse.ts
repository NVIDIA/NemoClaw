// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import {
  type OpenShellRuntimeSelection,
  withSelectedOpenShellCommandOptions,
} from "../adapters/openshell/command-argv";
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
  getGatewayReuseSnapshot(runtimeSelection?: OpenShellRuntimeSelection): GatewayReuseSnapshot;
  selectNamedGatewayForReuseIfNeeded(
    snapshot: GatewayReuseSnapshot,
    runtimeSelection?: OpenShellRuntimeSelection,
  ): GatewayReuseSnapshot;
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
  runDockerNetworkInspect: DockerDriverNetworkInspectRunner;
  inspectDockerDriverNetwork?: (networkName: string) => DockerDriverNetworkInspection;
  log?(message: string): void;
}

export type DockerDriverNetworkInspection =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "inconclusive" };

export interface DockerDriverNetworkInspectCommandResult {
  error?: unknown;
  status: number | null;
  stderr?: unknown;
  stdout?: unknown;
}

export type DockerDriverNetworkInspectRunner = (
  args: readonly string[],
  options: { ignoreError: true; suppressOutput: true; timeout: number },
) => DockerDriverNetworkInspectCommandResult;

export interface DockerDriverGatewayReuseApplication {
  refreshDockerDriverGatewayReuseState(state: GatewayReuseState): Promise<GatewayReuseState>;
}

function outputText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return (Buffer.isBuffer(value) ? value.toString("utf8") : String(value)).trim();
}

export function classifyDockerDriverNetworkInspection(
  networkName: string,
  result: DockerDriverNetworkInspectCommandResult,
): DockerDriverNetworkInspection {
  if (!result.error && result.status === 0 && outputText(result.stdout) === networkName) {
    return { kind: "present" };
  }

  const escapedName = networkName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exactAbsent = new RegExp(
    `^(?:Error response from daemon:\\s*)?(?:No such network: ${escapedName}|network ${escapedName} not found)$`,
    "iu",
  );
  if (!result.error && result.status === 1 && exactAbsent.test(outputText(result.stderr))) {
    return { kind: "absent" };
  }
  return { kind: "inconclusive" };
}

export function inspectDockerDriverNetwork(
  networkName: string,
  runDocker: DockerDriverNetworkInspectRunner,
): DockerDriverNetworkInspection {
  const result = runDocker(["network", "inspect", "--format", "{{.Name}}", networkName], {
    ignoreError: true,
    suppressOutput: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  return classifyDockerDriverNetworkInspection(networkName, result);
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
  const inspectNetwork =
    deps.inspectDockerDriverNetwork ??
    ((networkName) => inspectDockerDriverNetwork(networkName, deps.runDockerNetworkInspect));
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
    const networkName = desiredEnv.OPENSHELL_DOCKER_NETWORK_NAME;
    if (!networkName) {
      throw new Error(
        "NemoClaw cannot verify the OpenShell Docker network because the NemoClaw-managed OpenShell gateway configuration has no network name.",
      );
    }

    function reconcileManagedGatewayNetwork(): GatewayReuseState {
      const network = inspectNetwork(networkName);
      if (network.kind === "present") return state;
      if (network.kind === "absent") {
        log(
          `  Existing NemoClaw-managed OpenShell gateway network ${JSON.stringify(networkName)} is absent; the gateway will be recreated.`,
        );
        return "stale";
      }
      throw new Error(
        `NemoClaw could not verify Docker network ${JSON.stringify(networkName)} before reusing the NemoClaw-managed OpenShell gateway. Check Docker daemon access and the configured network, then rerun \`nemoclaw onboard\`.`,
      );
    }

    function verifyNetworkWithoutLifecycleAuthority(): GatewayReuseState {
      const network = inspectNetwork(networkName);
      if (network.kind === "present") return state;
      if (network.kind === "absent") {
        throw new Error(
          `Docker network ${JSON.stringify(networkName)} is absent, but NemoClaw could not verify the running gateway's lifecycle authority. Restart the gateway through its lifecycle authority, then rerun \`nemoclaw onboard\`.`,
        );
      }
      throw new Error(
        `NemoClaw could not verify Docker network ${JSON.stringify(networkName)} before reusing the running OpenShell gateway. Check Docker daemon access and the configured network, then rerun \`nemoclaw onboard\`.`,
      );
    }

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
      return reconcileManagedGatewayNetwork();
    }

    const portCheck = await deps.checkGatewayPortAvailable();
    const dockerGatewayPid = deps.getDockerDriverGatewayPortListenerPid(portCheck, {
      gatewayBin: identityBin,
    });
    if (dockerGatewayPid !== null) {
      if (dockerGatewayPid !== managedServicePid) {
        return verifyNetworkWithoutLifecycleAuthority();
      }
      const drift = deps.getDockerDriverGatewayReuseDrift(
        dockerGatewayPid,
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
      return reconcileManagedGatewayNetwork();
    }

    // OpenShell status already proved the selected gateway is reachable. Preserve it when
    // the port probe cannot identify an owner, instead of deleting a potentially live gateway.
    if (!portCheck.ok && !portCheck.pid) return verifyNetworkWithoutLifecycleAuthority();

    return "stale";
  }

  return { refreshDockerDriverGatewayReuseState };
}

export function createGatewayReuseHelpers(deps: GatewayReuseDeps): GatewayReuseHelpers {
  const currentGatewayName = () =>
    typeof deps.gatewayName === "function" ? deps.gatewayName() : deps.gatewayName;

  function getGatewayReuseSnapshot(
    runtimeSelection?: OpenShellRuntimeSelection,
  ): GatewayReuseSnapshot {
    const gatewayName = currentGatewayName();
    if (runtimeSelection && runtimeSelection.gatewayName !== gatewayName) {
      throw new Error(
        `Gateway reuse target '${gatewayName}' does not match runtime selection '${runtimeSelection.gatewayName}'`,
      );
    }
    const runtimeOptions = withSelectedOpenShellCommandOptions({}, runtimeSelection);
    const probeOptions = {
      ...runtimeOptions,
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    };
    // OpenShell 0.0.99 omits the gateway name when connection setup fails, so
    // bind the probe explicitly and carry that authority into classification.
    const gatewayStatus = deps.runCaptureOpenshell(["status", "-g", gatewayName], {
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
        gatewayName,
      ),
    };
  }

  function selectNamedGatewayForReuseIfNeeded(
    snapshot: GatewayReuseSnapshot,
    runtimeSelection?: OpenShellRuntimeSelection,
  ): GatewayReuseSnapshot {
    const gatewayName = currentGatewayName();
    if (runtimeSelection && runtimeSelection.gatewayName !== gatewayName) {
      throw new Error(
        `Gateway reuse target '${gatewayName}' does not match runtime selection '${runtimeSelection.gatewayName}'`,
      );
    }
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

    const runtimeOptions = withSelectedOpenShellCommandOptions({}, runtimeSelection);
    const selectResult = deps.runOpenshell(["gateway", "select", gatewayName], {
      ...runtimeOptions,
      ignoreError: true,
      suppressOutput: true,
    });
    if (selectResult.status !== 0) {
      return snapshot;
    }

    const refreshed = getGatewayReuseSnapshot(runtimeSelection);
    if (refreshed.gatewayReuseState === "healthy") {
      process.env.OPENSHELL_GATEWAY = gatewayName;
      console.log(`  ✓ Selected existing ${deps.cliDisplayName()} gateway`);
    }
    return refreshed;
  }

  return { getGatewayReuseSnapshot, selectNamedGatewayForReuseIfNeeded };
}
