// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { sleepSeconds } from "../core/wait";
import { trackChildExit } from "./child-exit-tracker";
import * as dockerDriverGatewayEnv from "./docker-driver-gateway-env";
import { reportDockerDriverGatewayStartFailure } from "./docker-driver-gateway-failure";
import * as dockerDriverGatewayLaunch from "./docker-driver-gateway-launch";
import * as dockerDriverGatewayRuntime from "./docker-driver-gateway-runtime";
import * as dockerDriverGatewayRuntimeMarker from "./docker-driver-gateway-runtime-marker";
import { envInt } from "./env";
import * as gatewayBinding from "./gateway-binding";
import { verifySandboxBridgeGatewayReachableOrExit } from "./gateway-sandbox-reachability";
import {
  getInstalledOpenshellVersion,
  SUPPORTED_OPENSHELL_FALLBACK_VERSION,
} from "./openshell-version";
import type { PortProbeResult } from "./preflight";

type RuntimeHelpers = Pick<
  ReturnType<typeof dockerDriverGatewayRuntime.createDockerDriverGatewayRuntimeHelpers>,
  | "clearDockerDriverGatewayRuntimeFiles"
  | "getDockerDriverGatewayEnv"
  | "getDockerDriverGatewayPid"
  | "getDockerDriverGatewayPortListenerPid"
  | "getDockerDriverGatewayRuntimeDrift"
  | "getDockerDriverGatewayStateDir"
  | "isDockerDriverGatewayProcess"
  | "isDockerDriverGatewayProcessAlive"
  | "isPidAlive"
  | "rememberDockerDriverGatewayPid"
  | "resolveOpenShellGatewayBinary"
  | "resolveOpenShellSandboxBinary"
>;

export type DockerDriverGatewayStartDeps = {
  getBinding(): { name: string; port: number };
  runtime: RuntimeHelpers;
  runCaptureOpenshell(args: string[], options?: { ignoreError?: boolean }): string;
  isDockerDriverGatewayHttpReady(): Promise<boolean>;
  registerDockerDriverGatewayEndpoint(): boolean;
  isGatewayHealthy(status: string, namedInfo: string, activeInfo: string): boolean;
  restartDockerDriverGatewayProcessForDrift(pid: number, reason: string): void;
  checkGatewayPortAvailable(): Promise<PortProbeResult>;
  getDockerDriverGatewayEndpoint(): string;
  isGatewayTcpReady(): Promise<boolean>;
};

export function createDockerDriverGatewayStarter(deps: DockerDriverGatewayStartDeps) {
  return async function startDockerDriverGateway({
    exitOnFailure = true,
    skipSandboxBridgeReachability = false,
  }: {
    exitOnFailure?: boolean;
    skipSandboxBridgeReachability?: boolean;
  } = {}): Promise<void> {
    const { name: gatewayName, port: gatewayPort } = deps.getBinding();
    const gatewayBin = deps.runtime.resolveOpenShellGatewayBinary();
    const openshellVersionOutput = deps.runCaptureOpenshell(["--version"], {
      ignoreError: true,
    });
    const gatewayEnv = deps.runtime.getDockerDriverGatewayEnv(openshellVersionOutput);
    const stateDir = deps.runtime.getDockerDriverGatewayStateDir();
    const runtimeIdentity = gatewayBin
      ? dockerDriverGatewayLaunch.buildDockerDriverGatewayRuntimeIdentity({
          gatewayBin,
          gatewayEnv,
          stateDir,
          sandboxBin: deps.runtime.resolveOpenShellSandboxBinary(),
          compatContainerName: gatewayBinding.resolveGatewayCompatContainerName(gatewayPort),
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
    if (
      await dockerDriverGatewayEnv.startPackageManagedDockerDriverGatewayWithEnvOverride({
        clearDockerDriverGatewayRuntimeFiles: deps.runtime.clearDockerDriverGatewayRuntimeFiles,
        exitOnFailure,
        gatewayEnv,
        gatewayName,
        isDockerDriverGatewayReady: deps.isDockerDriverGatewayHttpReady,
        registerDockerDriverGatewayEndpoint: deps.registerDockerDriverGatewayEndpoint,
        runCaptureOpenshell: deps.runCaptureOpenshell,
        skipSandboxBridgeReachability,
        verifySandboxBridgeGatewayReachableOrExit: (fail, options) =>
          verifySandboxBridgeGatewayReachableOrExit(fail, {
            ...options,
            port: gatewayPort,
          }),
      })
    ) {
      return;
    }

    const gatewayStatus = deps.runCaptureOpenshell(["status"], { ignoreError: true });
    const gwInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
      ignoreError: true,
    });
    const activeGatewayInfo = deps.runCaptureOpenshell(["gateway", "info"], {
      ignoreError: true,
    });
    const pidFileGatewayPid = deps.runtime.getDockerDriverGatewayPid();
    if (
      pidFileGatewayPid !== null &&
      deps.runtime.isDockerDriverGatewayProcessAlive() &&
      deps.isGatewayHealthy(gatewayStatus, gwInfo, activeGatewayInfo)
    ) {
      const drift = deps.runtime.getDockerDriverGatewayRuntimeDrift(
        pidFileGatewayPid,
        driftGatewayEnv,
        driftGatewayBin,
      );
      if (drift) {
        deps.restartDockerDriverGatewayProcessForDrift(pidFileGatewayPid, drift.reason);
      } else if (
        deps.registerDockerDriverGatewayEndpoint() &&
        (await deps.isDockerDriverGatewayHttpReady())
      ) {
        await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, {
          skip: skipSandboxBridgeReachability,
          port: gatewayPort,
        });
        console.log("  ✓ Reusing existing Docker-driver gateway");
        return;
      } else {
        console.log(
          `  Docker-driver gateway metadata reports healthy but http://127.0.0.1:${gatewayPort}/ is not responding. Starting a fresh gateway...`,
        );
      }
    }

    const portCheck = await deps.checkGatewayPortAvailable();
    const portListenerPid = deps.runtime.getDockerDriverGatewayPortListenerPid(portCheck, {
      gatewayBin: identityGatewayBin,
    });
    if (portListenerPid !== null) {
      const drift = deps.runtime.getDockerDriverGatewayRuntimeDrift(
        portListenerPid,
        driftGatewayEnv,
        driftGatewayBin,
      );
      if (drift) {
        deps.runtime.rememberDockerDriverGatewayPid(portListenerPid);
        deps.restartDockerDriverGatewayProcessForDrift(portListenerPid, drift.reason);
      } else {
        deps.runtime.rememberDockerDriverGatewayPid(portListenerPid);
      }
      if (!drift && deps.registerDockerDriverGatewayEndpoint()) {
        const adoptedStatus = deps.runCaptureOpenshell(["status"], { ignoreError: true });
        const adoptedGwInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
          ignoreError: true,
        });
        const adoptedActiveGatewayInfo = deps.runCaptureOpenshell(["gateway", "info"], {
          ignoreError: true,
        });
        if (
          deps.isGatewayHealthy(adoptedStatus, adoptedGwInfo, adoptedActiveGatewayInfo) &&
          (await deps.isDockerDriverGatewayHttpReady())
        ) {
          await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, {
            skip: skipSandboxBridgeReachability,
            port: gatewayPort,
          });
          console.log(
            `  ✓ Reusing existing Docker-driver gateway process (PID ${portListenerPid})`,
          );
          return;
        }
      }
    }
    if (!gatewayBin) {
      console.error("  OpenShell Docker-driver gateway binary not found.");
      console.error(
        `  Install OpenShell v${SUPPORTED_OPENSHELL_FALLBACK_VERSION}, or set NEMOCLAW_OPENSHELL_GATEWAY_BIN.`,
      );
      if (exitOnFailure) process.exit(1);
      throw new Error("OpenShell gateway binary not found");
    }

    const existingPid = deps.runtime.getDockerDriverGatewayPid() ?? portListenerPid;
    if (existingPid !== null && deps.runtime.isPidAlive(existingPid)) {
      if (!deps.runtime.isDockerDriverGatewayProcess(existingPid, identityGatewayBin)) {
        deps.runtime.clearDockerDriverGatewayRuntimeFiles();
      } else {
        console.log(`  Restarting unhealthy Docker-driver gateway process (PID ${existingPid})...`);
        try {
          process.kill(existingPid, "SIGTERM");
          sleepSeconds(1);
        } catch {
          // Best effort; the new process surfaces any remaining port conflict.
        }
      }
    }

    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(stateDir, "openshell-gateway.log");
    const logFd = dockerDriverGatewayLaunch.openDockerDriverGatewayLog(logPath, { exitOnFailure });
    console.log("  Starting OpenShell Docker-driver gateway...");
    console.log(`  Gateway log: ${logPath}`);
    const launch = gatewayLaunch ?? {
      command: gatewayBin,
      args: [],
      env: { ...process.env, ...gatewayEnv },
      mode: "host" as const,
      processGatewayBin: gatewayBin,
    };
    dockerDriverGatewayLaunch.prepareAndLogDockerDriverGatewayLaunch(launch);
    const child = dockerDriverGatewayLaunch.spawnDockerDriverGateway(launch, logFd);
    const childExit = trackChildExit(child);
    child.unref();
    const childPid = child.pid ?? 0;
    if (childPid <= 0) {
      throw new Error("OpenShell gateway process did not return a pid");
    }
    deps.runtime.rememberDockerDriverGatewayPid(childPid);
    dockerDriverGatewayRuntimeMarker.writeDockerDriverGatewayRuntimeMarkerForStateDir(
      deps.runtime.getDockerDriverGatewayStateDir(),
      {
        pid: childPid,
        desiredEnv: driftGatewayEnv,
        endpoint: deps.getDockerDriverGatewayEndpoint(),
        gatewayBin: driftGatewayBin,
        openshellVersion: getInstalledOpenshellVersion(openshellVersionOutput),
        dockerHost: process.env.DOCKER_HOST || null,
      },
    );

    const pollCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
    const pollInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
    for (let index = 0; index < pollCount; index += 1) {
      if (childExit.exited || !deps.runtime.isPidAlive(childPid)) break;
      if (!deps.registerDockerDriverGatewayEndpoint()) {
        if (index < pollCount - 1) sleepSeconds(pollInterval);
        continue;
      }
      const status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
      const namedInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
        ignoreError: true,
      });
      const currentInfo = deps.runCaptureOpenshell(["gateway", "info"], {
        ignoreError: true,
      });
      if (
        deps.isGatewayHealthy(status, namedInfo, currentInfo) &&
        (await deps.isGatewayTcpReady()) &&
        !childExit.exited &&
        deps.runtime.isPidAlive(childPid)
      ) {
        await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, {
          skip: skipSandboxBridgeReachability,
          port: gatewayPort,
        });
        console.log("  ✓ Docker-driver gateway is healthy");
        return;
      }
      if (index < pollCount - 1) sleepSeconds(pollInterval);
    }

    reportDockerDriverGatewayStartFailure(logPath, childExit, { exitOnFailure });
    throw new Error("Docker-driver gateway failed to start");
  };
}
