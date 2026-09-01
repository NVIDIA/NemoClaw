// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackChildExit } from "../child-exit-tracker";
import * as dockerDriverGatewayCutover from "../docker-driver-gateway-cutover";
import { reportDockerDriverGatewayStartFailure } from "../docker-driver-gateway-failure";
import * as dockerDriverGatewayLaunch from "../docker-driver-gateway-launch";
import {
  reapDuplicateHostGatewaysExceptOrFail,
  reapHostGatewayBeforeLaunchOrFail,
} from "../docker-driver-gateway-prelaunch";
import { waitForStandaloneDockerDriverGateway } from "../docker-driver-gateway-readiness";
import * as dockerDriverGatewayRuntimeMarker from "../docker-driver-gateway-runtime-marker";
import * as gatewayStateLifecycleLock from "./state-lifecycle-lock";
import { formatGatewayHealthWaitLimit } from "../gateway-health-wait";
import { verifySandboxBridgeGatewayReachableOrExit } from "../gateway-sandbox-reachability";

type GatewayRuntimeHelpers = ReturnType<
  typeof import("../docker-driver-gateway-runtime").createDockerDriverGatewayRuntimeHelpers
>;
type DynamicGatewayHelpers = ReturnType<
  typeof import("../gateway-binding").createDynamicGatewayRuntimeHelpers
>;

export interface DockerDriverGatewayStartDeps {
  SUPPORTED_OPENSHELL_FALLBACK_VERSION: string;
  checkGatewayPortAvailable(): Promise<import("../preflight").PortProbeResult>;
  clearDockerDriverGatewayRuntimeFiles: GatewayRuntimeHelpers["clearDockerDriverGatewayRuntimeFiles"];
  createGatewayServicePortOwnership: GatewayRuntimeHelpers["createGatewayServicePortOwnership"];
  dockerDriverGatewayEnv: typeof import("../docker-driver-gateway-env");
  envInt: typeof import("../env").envInt;
  gatewayBinding: typeof import("../gateway-binding");
  gatewayName(): string;
  gatewayPort(): number;
  getDockerDriverGatewayEndpoint: DynamicGatewayHelpers["getDockerDriverGatewayEndpoint"];
  getDockerDriverGatewayEnv: GatewayRuntimeHelpers["getDockerDriverGatewayEnv"];
  getDockerDriverGatewayPid: GatewayRuntimeHelpers["getDockerDriverGatewayPid"];
  getDockerDriverGatewayPortListenerScan: GatewayRuntimeHelpers["getDockerDriverGatewayPortListenerScan"];
  getDockerDriverGatewayRuntimeDrift: GatewayRuntimeHelpers["getDockerDriverGatewayRuntimeDrift"];
  getDockerDriverGatewayStateDir: GatewayRuntimeHelpers["getDockerDriverGatewayStateDir"];
  getInstalledOpenshellVersion: typeof import("../openshell-version").getInstalledOpenshellVersion;
  isDockerDriverGatewayHttpReady: DynamicGatewayHelpers["isDockerDriverGatewayHttpReady"];
  isDockerDriverGatewayProcessAlive: GatewayRuntimeHelpers["isDockerDriverGatewayProcessAlive"];
  isDockerDriverGatewayStateInUse: GatewayRuntimeHelpers["isDockerDriverGatewayStateInUse"];
  isGatewayHealthy(status: string, namedInfo: string, activeInfo: string): boolean;
  isGatewayTcpReady: DynamicGatewayHelpers["isGatewayTcpReady"];
  isPidAlive: GatewayRuntimeHelpers["isPidAlive"];
  logDockerDriverGatewayRestart(reason: string): void;
  registerDockerDriverGatewayEndpoint(): boolean;
  rememberDockerDriverGatewayPid: GatewayRuntimeHelpers["rememberDockerDriverGatewayPid"];
  resolveOpenShellGatewayBinary: GatewayRuntimeHelpers["resolveOpenShellGatewayBinary"];
  resolveOpenShellSandboxBinary: GatewayRuntimeHelpers["resolveOpenShellSandboxBinary"];
  runCaptureOpenshell(args: string[], options?: { ignoreError?: boolean }): string;
  sleepSeconds: typeof import("../../core/wait").sleepSeconds;
  verifySandboxBridgeGatewayReachableOrExit?: typeof verifySandboxBridgeGatewayReachableOrExit;
}

export interface DockerDriverGatewayStart {
  startDockerDriverGateway(options?: {
    exitOnFailure?: boolean;
    skipSandboxBridgeReachability?: boolean;
  }): Promise<void>;
}

export function createDockerDriverGatewayStart(
  deps: DockerDriverGatewayStartDeps,
): DockerDriverGatewayStart {
  async function startDockerDriverGateway({
    exitOnFailure = true,
    skipSandboxBridgeReachability = false,
  }: {
    exitOnFailure?: boolean;
    skipSandboxBridgeReachability?: boolean;
  } = {}): Promise<void> {
    const verifyReachability =
      deps.verifySandboxBridgeGatewayReachableOrExit ?? verifySandboxBridgeGatewayReachableOrExit;
    const stateDir = deps.gatewayBinding.resolveGatewayStateDirForPort({
      configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
      home: os.homedir(),
      port: deps.gatewayPort(),
    });
    const configuredStateDir = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
    const stateLifecycleLock = configuredStateDir
      ? gatewayStateLifecycleLock.acquireManagedGatewayStateLifecycleLock(stateDir)
      : null;
    try {
      if (configuredStateDir) {
        deps.gatewayBinding.ensureManagedGatewayStateRoot(
          {
            gatewayName: deps.gatewayName(),
            gatewayPort: deps.gatewayPort(),
            stateDir,
          },
          {
            isLegacyManagedState: () =>
              dockerDriverGatewayLaunch.hasStateScopedSandboxNamespace(stateDir),
          },
        );
      }
      const gatewayBin = deps.resolveOpenShellGatewayBinary();
      const openshellVersionOutput = deps.runCaptureOpenshell(["--version"], { ignoreError: true });
      const gatewayEnv = deps.getDockerDriverGatewayEnv(openshellVersionOutput);
      const runtimeIdentity = gatewayBin
        ? dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({
            gatewayBin,
            gatewayEnv,
            stateDir,
            sandboxBin: deps.resolveOpenShellSandboxBinary(),
            gatewayName: deps.gatewayName(),
            compatContainerName: deps.gatewayBinding.resolveGatewayCompatContainerName(
              deps.gatewayPort(),
            ),
            ensureLocalTlsBundle: true,
          })
        : null;
      const gatewayLaunch = runtimeIdentity?.launch ?? null;
      const driftGatewayBin = dockerDriverGatewayLaunch.resolveDriftGatewayBin(
        runtimeIdentity,
        gatewayBin,
      );
      const driftGatewayEnv = runtimeIdentity?.desiredEnv ?? gatewayEnv;
      const identityGatewayBin = runtimeIdentity?.identityGatewayBin ?? gatewayBin;
      const initialPortCheck = await deps.checkGatewayPortAvailable();
      const servicePortOwnership = deps.createGatewayServicePortOwnership(initialPortCheck, {
        exitOnFailure,
        gatewayBin: identityGatewayBin,
        preparePort: (extraPids: number[]) =>
          reapHostGatewayBeforeLaunchOrFail({
            stateDir,
            gatewayBin: identityGatewayBin,
            extraPids,
            exitOnFailure,
          }),
      });
      const cutover = await dockerDriverGatewayCutover.runDockerDriverGatewayManagedFallback(
        () =>
          deps.dockerDriverGatewayEnv.startPackageManagedDockerDriverGatewayWithEnvOverride({
            clearDockerDriverGatewayRuntimeFiles: deps.clearDockerDriverGatewayRuntimeFiles,
            exitOnFailure,
            gatewayEnv: driftGatewayEnv,
            gatewayName: deps.gatewayName(),
            isDockerDriverGatewayReady: () =>
              deps.isDockerDriverGatewayHttpReady(undefined, undefined, driftGatewayEnv),
            registerDockerDriverGatewayEndpoint: deps.registerDockerDriverGatewayEndpoint,
            preparePortForOpenShellGatewayUserServiceStart: servicePortOwnership.preparePort,
            runCaptureOpenshell: deps.runCaptureOpenshell,
            skipSandboxBridgeReachability,
            validatePortOwnerForOpenShellGatewayUserServiceStart:
              servicePortOwnership.validatePortOwner,
            verifySandboxBridgeGatewayReachableOrExit: (fail, options) =>
              verifyReachability(fail, {
                ...(options ?? {}),
                port: deps.gatewayPort(),
              }),
          }),
        async () =>
          dockerDriverGatewayCutover.runDockerDriverGatewayCutover(
            {
              gatewayBin,
              identityGatewayBin,
              driftGatewayBin,
              driftGatewayEnv,
              exitOnFailure,
              skipSandboxBridgeReachability,
              stateDir,
              portListenerScan: deps.getDockerDriverGatewayPortListenerScan(
                await deps.checkGatewayPortAvailable(),
                { gatewayBin: identityGatewayBin },
              ),
              pidFileGatewayPid: deps.getDockerDriverGatewayPid(),
              initialHealth: dockerDriverGatewayCutover.readDockerDriverGatewayHealth(
                deps.runCaptureOpenshell,
                deps.gatewayName(),
              ),
            },
            {
              isDockerDriverGatewayProcessAlive: deps.isDockerDriverGatewayProcessAlive,
              isGatewayHealthy: deps.isGatewayHealthy,
              getDockerDriverGatewayRuntimeDrift: deps.getDockerDriverGatewayRuntimeDrift,
              logDockerDriverGatewayRestart: deps.logDockerDriverGatewayRestart,
              registerDockerDriverGatewayEndpoint: deps.registerDockerDriverGatewayEndpoint,
              isDockerDriverGatewayHttpReady: () =>
                deps.isDockerDriverGatewayHttpReady(undefined, undefined, driftGatewayEnv),
              verifySandboxBridgeGatewayReachableOrExit: (fail, options) =>
                verifyReachability(fail, {
                  ...(options ?? {}),
                  port: deps.gatewayPort(),
                }),
              readGatewayHealth: () => ({
                status: deps.runCaptureOpenshell(["status"], { ignoreError: true }),
                namedInfo: deps.runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName()], {
                  ignoreError: true,
                }),
                activeInfo: deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
              }),
              rememberDockerDriverGatewayPid: deps.rememberDockerDriverGatewayPid,
              reapDuplicateHostGatewaysExceptOrFail,
              reapHostGatewayBeforeLaunchOrFail,
              isGatewayPortAvailable: async () => {
                const probe = await deps.checkGatewayPortAvailable();
                return probe.ok && !probe.warning;
              },
              reportUntrustedGatewayPort: servicePortOwnership.reportUntrustedGatewayPort,
              reportMissingGatewayBinary: () => {
                console.error("  OpenShell Docker-driver gateway binary not found.");
                console.error(
                  `  Install OpenShell v${deps.SUPPORTED_OPENSHELL_FALLBACK_VERSION}, or set NEMOCLAW_OPENSHELL_GATEWAY_BIN.`,
                );
                if (exitOnFailure) process.exit(1);
                throw new Error("OpenShell gateway binary not found");
              },
              log: console.log,
            },
          ),
      );
      if (cutover !== "launch") return;
      if (!gatewayBin || !gatewayLaunch) {
        throw new Error("OpenShell gateway launch missing after cutover");
      }

      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const logPath = path.join(stateDir, "openshell-gateway.log");
      const log = dockerDriverGatewayLaunch.openDockerDriverGatewayLog(logPath, { exitOnFailure });
      console.log("  Starting OpenShell Docker-driver gateway...");
      console.log(`  Gateway log: ${logPath}`);
      dockerDriverGatewayLaunch.prepareAndLogDockerDriverGatewayLaunch(gatewayLaunch);
      const child = dockerDriverGatewayLaunch.spawnDockerDriverGateway(gatewayLaunch, log.fd);
      const childExit = trackChildExit(child);
      child.unref();
      const childPid = child.pid ?? 0;
      if (childPid <= 0) throw new Error("OpenShell gateway process did not return a pid");
      deps.rememberDockerDriverGatewayPid(childPid);
      dockerDriverGatewayRuntimeMarker.writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
        pid: childPid,
        desiredEnv: driftGatewayEnv,
        endpoint: deps.getDockerDriverGatewayEndpoint(),
        gatewayBin: driftGatewayBin,
        openshellVersion: deps.getInstalledOpenshellVersion(openshellVersionOutput),
        dockerHost: process.env.DOCKER_HOST || null,
      });
      const pollCount = deps.envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
      const pollInterval = deps.envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
      const startup = await waitForStandaloneDockerDriverGateway({
        childExited: () => childExit.exited,
        childPid,
        gatewayName: deps.gatewayName(),
        healthPollCount: pollCount,
        healthPollIntervalSeconds: pollInterval,
        isGatewayHealthy: deps.isGatewayHealthy,
        isGatewayTcpReady: deps.isGatewayTcpReady,
        isPidAlive: deps.isPidAlive,
        onHealthy: async () => {
          await verifyReachability(exitOnFailure, {
            skip: skipSandboxBridgeReachability,
            port: deps.gatewayPort(),
          });
        },
        registerGatewayEndpoint: deps.registerDockerDriverGatewayEndpoint,
        runCaptureOpenshell: deps.runCaptureOpenshell,
        sleepSeconds: deps.sleepSeconds,
      });
      if (startup === "healthy") {
        console.log("  ✓ Docker-driver gateway is healthy");
        return;
      }
      reportDockerDriverGatewayStartFailure(logPath, childExit, {
        exitOnFailure,
        isGatewayStateInUse: deps.isDockerDriverGatewayStateInUse,
        launchLogOffset: log.startOffset,
      });
      if (startup === "exited") {
        throw new Error("Docker-driver gateway failed to start because the process exited");
      }
      throw new Error(
        `Docker-driver gateway failed to start within ${formatGatewayHealthWaitLimit(pollCount, pollInterval)}`,
      );
    } finally {
      if (stateLifecycleLock) {
        gatewayStateLifecycleLock.releaseManagedGatewayStateLifecycleLock(stateLifecycleLock);
      }
    }
  }

  return { startDockerDriverGateway };
}
