// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { redact } from "../runner";
import type { GatewayReuseState } from "../state/gateway";
import { trackChildExit } from "./child-exit-tracker";
import type {
  ManagedGatewayDriverProfile,
  ManagedGatewayRuntimeAdapter,
} from "./compute/managed-gateway-profile";
import type { OpenShellComputePlan } from "./compute/plan";
import type { PodmanSandboxCreateRuntimeAuthority } from "./compute/podman/sandbox-create-authority";
import * as computeRuntime from "./compute/runtime";
import type { SandboxRuntimeAuthorityAdapterRegistry } from "./compute/runtime-authority";
import * as dockerDriverGatewayCutover from "./docker-driver-gateway-cutover";
import * as dockerDriverGatewayEnv from "./docker-driver-gateway-env";
import { reportManagedDriverGatewayStartFailure } from "./docker-driver-gateway-failure";
import * as dockerDriverGatewayLaunch from "./docker-driver-gateway-launch";
import {
  reapDuplicateHostGatewaysExceptOrFail,
  reapHostGatewayBeforeLaunchOrFail,
} from "./docker-driver-gateway-prelaunch";
import { waitForStandaloneManagedDriverGateway } from "./docker-driver-gateway-readiness";
import * as dockerDriverGatewayRuntimeMarker from "./docker-driver-gateway-runtime-marker";
import * as gatewayService from "./docker-driver-gateway-service";
import { envInt } from "./env";
import * as gatewayBinding from "./gateway-binding";
import { formatGatewayHealthWaitLimit } from "./gateway-health-wait";
import { verifySandboxBridgeGatewayReachableOrExit } from "./gateway-sandbox-reachability";
import {
  getInstalledOpenshellVersion,
  SUPPORTED_OPENSHELL_FALLBACK_VERSION,
} from "./openshell-version";
import type { PortProbeResult } from "./preflight";

type DockerDriverGatewayRuntimeHelpers = ReturnType<
  typeof import("./docker-driver-gateway-runtime").createDockerDriverGatewayRuntimeHelpers
>;

type DynamicGatewayRuntimeHelpers = Pick<
  ReturnType<typeof import("./gateway-binding").createDynamicGatewayRuntimeHelpers>,
  "getDockerDriverGatewayEndpoint" | "isDockerDriverGatewayHttpReady" | "isGatewayTcpReady"
>;

type RunCaptureOpenshell = (
  args: string[],
  options?: { ignoreError?: boolean; timeout?: number },
) => string;

type ManagedGatewayRuntimeAdapterContext = {
  gatewayBin: string;
  openshellVersionOutput: string;
  profile: ManagedGatewayDriverProfile;
  stateDir: string;
};

type ResolvedManagedGatewayRuntime = {
  gatewayEnv: Record<string, string>;
  runtimeDiagnostics: readonly string[];
  runtimeIdentity: dockerDriverGatewayLaunch.ManagedDriverGatewayRuntimeIdentity;
  verifySandboxReachability(exitOnFailure: boolean, options?: { skip?: boolean }): Promise<void>;
  writeRuntimeMarker?(pid: number): void;
};

type OnboardManagedGatewayRuntimeAdapter = ManagedGatewayRuntimeAdapter & {
  build(context: ManagedGatewayRuntimeAdapterContext): ResolvedManagedGatewayRuntime;
};

export interface ManagedGatewayOnboardRuntimeDeps {
  checkGatewayPortAvailable(): Promise<PortProbeResult>;
  dockerRuntime: DockerDriverGatewayRuntimeHelpers;
  dynamicGatewayRuntime: DynamicGatewayRuntimeHelpers;
  getActiveComputePlan(): OpenShellComputePlan;
  getActiveManagedGatewayProfile(): ManagedGatewayDriverProfile | null;
  getGatewayName(): string;
  getGatewayPort(): number;
  isGatewayHealthy(
    statusOutput?: string,
    gatewayInfoOutput?: string,
    activeGatewayInfoOutput?: string,
  ): boolean;
  registerManagedGatewayEndpoint(): boolean;
  runCaptureOpenshell: RunCaptureOpenshell;
  sleepSeconds(seconds: number): void;
}

export interface ManagedGatewayOnboardRuntime {
  readonly sandboxRuntimeAuthorityAdapters: SandboxRuntimeAuthorityAdapterRegistry<void>;
  refreshManagedGatewayReuseState(state: GatewayReuseState): Promise<GatewayReuseState>;
  startManagedDriverGateway(options?: {
    exitOnFailure?: boolean;
    skipSandboxBridgeReachability?: boolean;
  }): Promise<void>;
}

export function createManagedGatewayOnboardRuntime(
  deps: ManagedGatewayOnboardRuntimeDeps,
): ManagedGatewayOnboardRuntime {
  const {
    clearDockerDriverGatewayRuntimeFiles,
    createGatewayServicePortOwnership,
    getDockerDriverGatewayEnv,
    getDockerDriverGatewayPid,
    getDockerDriverGatewayPortListenerPid,
    getDockerDriverGatewayReuseDrift,
    getDockerDriverGatewayRuntimeDrift,
    getDockerDriverGatewayStateDir,
    getOpenShellSupervisorImage,
    isDockerDriverGatewayProcessAlive,
    isPidAlive,
    rememberDockerDriverGatewayPid,
    resolveOpenShellGatewayBinary,
    resolveOpenShellSandboxBinary,
  } = deps.dockerRuntime;
  const { getDockerDriverGatewayEndpoint, isDockerDriverGatewayHttpReady, isGatewayTcpReady } =
    deps.dynamicGatewayRuntime;

  const managedGatewayRuntimeAdapters = {
    docker: {
      driverName: "docker",
      launchPolicy: "docker-compat",
      runtimeMarkerPolicy: "docker-compat-v1",
      sandboxReachability: "docker-bridge",
      build({
        gatewayBin,
        openshellVersionOutput,
        profile,
        stateDir,
      }: ManagedGatewayRuntimeAdapterContext): ResolvedManagedGatewayRuntime {
        if (profile.launchPolicy !== "docker-compat") {
          throw new Error("Docker managed-gateway profile must use docker-compat launch policy");
        }
        const gatewayEnv = getDockerDriverGatewayEnv(openshellVersionOutput);
        const runtimeIdentity = dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({
          gatewayBin,
          gatewayEnv,
          stateDir,
          sandboxBin: profile.capabilities.localSupervisorBinary
            ? resolveOpenShellSandboxBinary()
            : null,
          gatewayName: deps.getGatewayName(),
          compatContainerName: gatewayBinding.resolveGatewayCompatContainerName(
            deps.getGatewayPort(),
          ),
          ensureLocalTlsBundle: true,
          removeEnvironmentKeys: profile.incompatibleRuntimeEnvironmentKeys,
        });
        return {
          gatewayEnv,
          runtimeDiagnostics: ["docker info --format '{{json .CDISpecDirs}}'"],
          runtimeIdentity,
          verifySandboxReachability: (fail, options) =>
            verifySandboxBridgeGatewayReachableOrExit(fail, {
              skip: options?.skip,
              port: deps.getGatewayPort(),
            }),
          writeRuntimeMarker: (pid) =>
            dockerDriverGatewayRuntimeMarker.writeDockerDriverGatewayRuntimeMarkerForStateDir(
              stateDir,
              {
                pid,
                desiredEnv: runtimeIdentity.desiredEnv,
                endpoint: getDockerDriverGatewayEndpoint(),
                gatewayBin: runtimeIdentity.driftGatewayBin,
                openshellVersion: getInstalledOpenshellVersion(openshellVersionOutput),
                dockerHost: process.env.DOCKER_HOST || null,
              },
            ),
        };
      },
    },
    podman: {
      driverName: "podman",
      launchPolicy: "host-only",
      runtimeMarkerPolicy: "process-env",
      sandboxReachability: "podman-host",
      build({
        gatewayBin,
        openshellVersionOutput,
        profile,
        stateDir,
      }: ManagedGatewayRuntimeAdapterContext): ResolvedManagedGatewayRuntime {
        if (profile.launchPolicy !== "host-only") {
          throw new Error("Podman managed-gateway profile must remain host-only");
        }
        const podmanSocketPath = process.env.OPENSHELL_PODMAN_SOCKET?.trim();
        if (!podmanSocketPath) {
          throw new Error("Qualified Podman runtime did not provide OPENSHELL_PODMAN_SOCKET");
        }
        const qualifiedPodman = computeRuntime.assessNativePodman({ env: process.env });
        if (qualifiedPodman.socketPath !== podmanSocketPath) {
          throw new Error("Qualified Podman socket does not match the managed gateway runtime.");
        }
        computeRuntime.ensureManagedGatewayLocalTlsBundle({
          additionalServerDnsSans: ["host.containers.internal"],
          gatewayBin,
          stateDir,
        });
        const gatewayEnv = computeRuntime.buildPodmanDriverGatewayEnv({
          gatewayPort: deps.getGatewayPort(),
          stateDir,
          podmanSocketPath,
          podmanNetworkName: process.env.OPENSHELL_PODMAN_NETWORK_NAME || "openshell",
          supervisorImage: getOpenShellSupervisorImage(openshellVersionOutput),
        });
        const runtimeIdentity = dockerDriverGatewayLaunch.buildHostManagedGatewayRuntimeIdentity({
          gatewayBin,
          gatewayEnv,
          gatewayName: deps.getGatewayName(),
          removeEnvironmentKeys: profile.incompatibleRuntimeEnvironmentKeys,
          runtimeEnvironmentKeys: profile.runtimeEnvironmentKeys,
        });
        return {
          gatewayEnv,
          runtimeDiagnostics: [
            `podman --url unix://${podmanSocketPath} info`,
            `podman --url unix://${podmanSocketPath} network inspect ${
              process.env.OPENSHELL_PODMAN_NETWORK_NAME || "openshell"
            }`,
          ],
          runtimeIdentity,
          verifySandboxReachability: (fail, options) =>
            computeRuntime.verifyPodmanSandboxGatewayReachableOrExit(fail, {
              skip: options?.skip,
              networkName: process.env.OPENSHELL_PODMAN_NETWORK_NAME || "openshell",
              podmanSocketPath,
              port: deps.getGatewayPort(),
              redact,
              socketAuthority: qualifiedPodman.socketAuthority,
            }),
        };
      },
    },
  } as const satisfies Record<string, OnboardManagedGatewayRuntimeAdapter>;

  function resolveManagedGatewayRuntime(
    profile: ManagedGatewayDriverProfile,
    context: Omit<ManagedGatewayRuntimeAdapterContext, "profile">,
  ): ResolvedManagedGatewayRuntime {
    return computeRuntime
      .resolveManagedGatewayRuntimeAdapter(profile, managedGatewayRuntimeAdapters)
      .build({ ...context, profile });
  }

  async function refreshManagedGatewayReuseState(
    gatewayReuseState: GatewayReuseState,
  ): Promise<GatewayReuseState> {
    const profile = deps.getActiveManagedGatewayProfile();
    if (!profile || gatewayReuseState !== "healthy") {
      return gatewayReuseState;
    }
    const gatewayBin = resolveOpenShellGatewayBinary();
    if (!gatewayBin) {
      console.log(
        `  Existing OpenShell ${profile.displayName}-driver gateway cannot be verified without its gateway binary; it will be recreated.`,
      );
      return "stale";
    }
    let runtime: ResolvedManagedGatewayRuntime;
    try {
      runtime = resolveManagedGatewayRuntime(profile, {
        gatewayBin,
        openshellVersionOutput: deps.runCaptureOpenshell(["--version"], {
          ignoreError: true,
        }),
        stateDir: getDockerDriverGatewayStateDir(),
      });
    } catch (error) {
      console.log(
        `  Existing OpenShell ${profile.displayName}-driver gateway runtime cannot be verified (${String(error).replace(/\s+/g, " ").trim()}); it will be recreated.`,
      );
      return "stale";
    }
    const desiredEnv = runtime.runtimeIdentity.desiredEnv;
    const driftBin = dockerDriverGatewayLaunch.resolveDriftGatewayBin(
      runtime.runtimeIdentity,
      gatewayBin,
    );
    const identityBin = runtime.runtimeIdentity.identityGatewayBin ?? gatewayBin;
    const managedServicePid = gatewayService.getTrustedActiveOpenShellGatewayUserServicePid();
    const pid = getDockerDriverGatewayPid();
    if (pid !== null && isDockerDriverGatewayProcessAlive()) {
      const drift = getDockerDriverGatewayReuseDrift(pid, desiredEnv, driftBin, managedServicePid);
      if (drift) {
        console.log(
          `  Existing OpenShell ${profile.displayName}-driver gateway is stale (${drift.reason}); it will be recreated.`,
        );
        return "stale";
      }
      return gatewayReuseState;
    }

    const portCheck = await deps.checkGatewayPortAvailable();
    const managedGatewayPid = getDockerDriverGatewayPortListenerPid(portCheck, {
      gatewayBin: identityBin,
    });
    if (managedGatewayPid !== null) {
      const drift = getDockerDriverGatewayReuseDrift(
        managedGatewayPid,
        desiredEnv,
        driftBin,
        managedServicePid,
      );
      if (managedGatewayPid !== managedServicePid)
        rememberDockerDriverGatewayPid(managedGatewayPid);
      if (drift) {
        console.log(
          `  Existing OpenShell ${profile.displayName}-driver gateway is stale (${drift.reason}); it will be recreated.`,
        );
        return "stale";
      }
      return "healthy";
    }

    if (!portCheck.ok && !portCheck.pid) return "healthy";
    return "stale";
  }

  function createActivePodmanWatcherController(): PodmanSandboxCreateRuntimeAuthority {
    if (deps.getActiveComputePlan().driverName !== "podman") {
      throw new Error("Podman watcher controller requires the active Podman compute driver.");
    }
    const profile = deps.getActiveManagedGatewayProfile();
    if (!profile || profile.driverName !== "podman") {
      throw new Error("Podman watcher controller requires a NemoClaw-managed Podman gateway.");
    }
    const gatewayBin = resolveOpenShellGatewayBinary();
    if (!gatewayBin) {
      throw new Error("Podman watcher controller could not resolve the gateway binary.");
    }
    const stateDir = getDockerDriverGatewayStateDir();
    const qualifiedPodman = computeRuntime.assessNativePodman({ env: process.env });
    const configuredSocketPath = process.env.OPENSHELL_PODMAN_SOCKET?.trim();
    if (!configuredSocketPath || qualifiedPodman.socketPath !== configuredSocketPath) {
      throw new Error("Qualified Podman socket does not match the active compute runtime.");
    }
    const runtime = resolveManagedGatewayRuntime(profile, {
      gatewayBin,
      openshellVersionOutput: deps.runCaptureOpenshell(["--version"], { ignoreError: true }),
      stateDir,
    });
    const socketPath = runtime.gatewayEnv.OPENSHELL_PODMAN_SOCKET?.trim();
    if (!socketPath) {
      throw new Error(
        "Podman watcher controller requires the exact host launch and socket identity.",
      );
    }
    return computeRuntime.createPodmanSandboxCreateRuntimeAuthority({
      cdiDevices: qualifiedPodman.cdiDevices,
      driverLabel: profile.displayName,
      gatewayBin,
      gatewayName: deps.getGatewayName(),
      gatewayPort: deps.getGatewayPort(),
      getRememberedGatewayPid: getDockerDriverGatewayPid,
      getRuntimeDrift: (pid, desiredEnv, driftGatewayBin, trustedServicePid) =>
        getDockerDriverGatewayReuseDrift(
          pid,
          { ...desiredEnv },
          driftGatewayBin,
          trustedServicePid,
        ),
      isGatewayHealthy: () =>
        deps.isGatewayHealthy(
          deps.runCaptureOpenshell(["status"], { ignoreError: true }),
          deps.runCaptureOpenshell(["gateway", "info", "-g", deps.getGatewayName()], {
            ignoreError: true,
          }),
          deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
        ),
      isPidAlive,
      rememberGatewayPid: rememberDockerDriverGatewayPid,
      runtimeIdentity: runtime.runtimeIdentity,
      socketAuthority: qualifiedPodman.socketAuthority,
      socketPath,
      stateDir,
    });
  }

  const sandboxRuntimeAuthorityAdapters = {
    docker: { driverName: "docker", resolve: () => null },
    kubernetes: { driverName: "kubernetes", resolve: () => null },
    podman: {
      driverName: "podman",
      resolve: createActivePodmanWatcherController,
      revalidate: (authority: unknown) => {
        const podmanAuthority = authority as Partial<PodmanSandboxCreateRuntimeAuthority> | null;
        if (
          !podmanAuthority ||
          typeof podmanAuthority.socketPath !== "string" ||
          !podmanAuthority.socketAuthority ||
          podmanAuthority.socketAuthority.socketPath !== podmanAuthority.socketPath
        ) {
          throw new Error("Podman sandbox mutation requires its exact socket authority.");
        }
        computeRuntime.assertPodmanSocketAuthority(podmanAuthority.socketAuthority);
      },
    },
  } as const satisfies SandboxRuntimeAuthorityAdapterRegistry<void>;

  async function startManagedDriverGateway({
    exitOnFailure = true,
    skipSandboxBridgeReachability = false,
  }: {
    exitOnFailure?: boolean;
    skipSandboxBridgeReachability?: boolean;
  } = {}): Promise<void> {
    const profile = deps.getActiveManagedGatewayProfile();
    if (!profile) {
      throw new Error(
        `OpenShell compute driver '${deps.getActiveComputePlan().driverName}' is not NemoClaw-managed.`,
      );
    }
    const gatewayBin = resolveOpenShellGatewayBinary();
    if (!gatewayBin) {
      console.error(`  OpenShell ${profile.displayName}-driver gateway binary not found.`);
      console.error(
        `  Install OpenShell v${SUPPORTED_OPENSHELL_FALLBACK_VERSION}, or set NEMOCLAW_OPENSHELL_GATEWAY_BIN.`,
      );
      if (exitOnFailure) process.exit(1);
      throw new Error("OpenShell gateway binary not found");
    }
    const openshellVersionOutput = deps.runCaptureOpenshell(["--version"], {
      ignoreError: true,
    });
    const stateDir = getDockerDriverGatewayStateDir();
    const runtime = resolveManagedGatewayRuntime(profile, {
      gatewayBin,
      openshellVersionOutput,
      stateDir,
    });
    const gatewayEnv = runtime.gatewayEnv;
    if (gatewayEnv.OPENSHELL_LOCAL_TLS_DIR) {
      process.env.OPENSHELL_LOCAL_TLS_DIR = gatewayEnv.OPENSHELL_LOCAL_TLS_DIR;
    }
    const runtimeIdentity = runtime.runtimeIdentity;
    const gatewayLaunch = runtimeIdentity.launch;
    const driftGatewayBin = dockerDriverGatewayLaunch.resolveDriftGatewayBin(
      runtimeIdentity,
      gatewayBin,
    );
    const driftGatewayEnv = runtimeIdentity.desiredEnv;
    const identityGatewayBin = runtimeIdentity.identityGatewayBin ?? gatewayBin;
    const verifySandboxReachability = runtime.verifySandboxReachability;
    const initialPortCheck = await deps.checkGatewayPortAvailable();
    const servicePortOwnership = createGatewayServicePortOwnership(initialPortCheck, {
      exitOnFailure,
      gatewayBin: identityGatewayBin,
      preparePort: (extraPids) =>
        reapHostGatewayBeforeLaunchOrFail({
          stateDir,
          gatewayBin: identityGatewayBin,
          extraPids,
          exitOnFailure,
        }),
    });
    if (
      profile.capabilities.packageManagedService &&
      (await dockerDriverGatewayEnv.startPackageManagedDriverGatewayWithEnvOverride({
        allowWildcardBind: profile.allowWildcardBind,
        clearDockerDriverGatewayRuntimeFiles,
        driverLabel: profile.displayName,
        driverName: profile.driverName,
        exitOnFailure,
        gatewayEnv: driftGatewayEnv,
        gatewayName: deps.getGatewayName(),
        isDockerDriverGatewayReady: () =>
          isDockerDriverGatewayHttpReady(undefined, undefined, driftGatewayEnv),
        registerDockerDriverGatewayEndpoint: deps.registerManagedGatewayEndpoint,
        preparePortForOpenShellGatewayUserServiceStart: servicePortOwnership.preparePort,
        runCaptureOpenshell: deps.runCaptureOpenshell,
        skipSandboxBridgeReachability,
        validatePortOwnerForOpenShellGatewayUserServiceStart:
          servicePortOwnership.validatePortOwner,
        verifySandboxBridgeGatewayReachableOrExit: verifySandboxReachability,
      }))
    ) {
      return;
    }
    const initialHealth = dockerDriverGatewayCutover.readDockerDriverGatewayHealth(
      deps.runCaptureOpenshell,
      deps.getGatewayName(),
    );
    const cutover = await dockerDriverGatewayCutover.runManagedDriverGatewayCutover(
      {
        driverLabel: profile.displayName,
        gatewayBin,
        identityGatewayBin,
        driftGatewayBin,
        driftGatewayEnv,
        exitOnFailure,
        skipSandboxBridgeReachability,
        stateDir,
        portListenerScan: servicePortOwnership.portListenerScan,
        pidFileGatewayPid: getDockerDriverGatewayPid(),
        initialHealth,
      },
      {
        isDockerDriverGatewayProcessAlive,
        isGatewayHealthy: deps.isGatewayHealthy,
        getDockerDriverGatewayRuntimeDrift,
        logDockerDriverGatewayRestart: (reason) =>
          console.log(
            `  Existing OpenShell ${profile.displayName}-driver gateway is stale (${reason}); restarting...`,
          ),
        registerDockerDriverGatewayEndpoint: deps.registerManagedGatewayEndpoint,
        isDockerDriverGatewayHttpReady: () =>
          isDockerDriverGatewayHttpReady(undefined, undefined, driftGatewayEnv),
        verifySandboxBridgeGatewayReachableOrExit: verifySandboxReachability,
        readGatewayHealth: () => ({
          status: deps.runCaptureOpenshell(["status"], { ignoreError: true }),
          namedInfo: deps.runCaptureOpenshell(["gateway", "info", "-g", deps.getGatewayName()], {
            ignoreError: true,
          }),
          activeInfo: deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
        }),
        rememberDockerDriverGatewayPid,
        reapDuplicateHostGatewaysExceptOrFail,
        reapHostGatewayBeforeLaunchOrFail,
        isGatewayPortAvailable: async () => {
          const probe = await deps.checkGatewayPortAvailable();
          return probe.ok && !probe.warning;
        },
        reportUntrustedGatewayPort: servicePortOwnership.reportUntrustedGatewayPort,
        reportMissingGatewayBinary: () => {
          throw new Error("OpenShell gateway binary disappeared during managed cutover");
        },
        log: (message) => console.log(message),
      },
    );
    if (cutover === "reused") return;
    if (!gatewayLaunch) {
      throw new Error("OpenShell gateway launch missing after cutover");
    }

    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(stateDir, "openshell-gateway.log");
    const logFd = dockerDriverGatewayLaunch.openManagedDriverGatewayLog(logPath, {
      driverLabel: profile.displayName,
      exitOnFailure,
    });
    console.log(`  Starting OpenShell ${profile.displayName}-driver gateway...`);
    console.log(`  Gateway log: ${logPath}`);
    dockerDriverGatewayLaunch.prepareAndLogDockerDriverGatewayLaunch(gatewayLaunch);
    const child = dockerDriverGatewayLaunch.spawnDockerDriverGateway(gatewayLaunch, logFd);
    const childExit = trackChildExit(child);
    child.unref();
    const childPid = child.pid ?? 0;
    if (childPid <= 0) {
      throw new Error("OpenShell gateway process did not return a pid");
    }
    rememberDockerDriverGatewayPid(childPid);
    runtime.writeRuntimeMarker?.(childPid);

    const pollCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
    const pollInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
    const gatewayStartup = await waitForStandaloneManagedDriverGateway({
      childExited: () => childExit.exited,
      childPid,
      gatewayName: deps.getGatewayName(),
      healthPollCount: pollCount,
      healthPollIntervalSeconds: pollInterval,
      isGatewayHealthy: deps.isGatewayHealthy,
      isGatewayTcpReady,
      isPidAlive,
      onHealthy: async () => {
        await verifySandboxReachability(exitOnFailure, {
          skip: skipSandboxBridgeReachability,
        });
      },
      registerGatewayEndpoint: deps.registerManagedGatewayEndpoint,
      runCaptureOpenshell: deps.runCaptureOpenshell,
      sleepSeconds: deps.sleepSeconds,
    });
    if (gatewayStartup === "healthy") {
      console.log(`  ✓ ${profile.displayName}-driver gateway is healthy`);
      return;
    }

    reportManagedDriverGatewayStartFailure(logPath, childExit, {
      driverLabel: profile.displayName,
      exitOnFailure,
      runtimeDiagnostics: runtime.runtimeDiagnostics,
    });
    if (gatewayStartup === "exited") {
      throw new Error(
        `${profile.displayName}-driver gateway failed to start because the process exited`,
      );
    }
    const waitLimit = formatGatewayHealthWaitLimit(pollCount, pollInterval);
    throw new Error(`${profile.displayName}-driver gateway failed to start within ${waitLimit}`);
  }

  return {
    sandboxRuntimeAuthorityAdapters,
    refreshManagedGatewayReuseState,
    startManagedDriverGateway,
  };
}
