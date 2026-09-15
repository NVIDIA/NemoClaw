// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "../docker-driver-gateway-config";
import { readDockerDriverGatewayProcessEnvironment } from "../docker-driver-gateway-process-identity";
import { HOST_GATEWAY_PGREP_PATTERN } from "../host-gateway-process";

interface ProcessScanResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

interface DockerDriverGatewayStateOwnershipDeps {
  getDockerDriverGatewayPid(): number | null;
  getDockerDriverGatewayStateDir(): string;
  isDockerDriverGatewayProcess(
    pid: number,
    gatewayBin?: string | null,
    opts?: { requireDockerDriverEnv?: boolean },
  ): boolean;
  isPidAlive(pid: number): boolean;
  readProcessEnvironment?: (pid: number) => Record<string, string> | null;
  resolveOpenShellGatewayBinary(): string | null;
  runCaptureEx(args: readonly string[]): ProcessScanResult;
}

export interface DockerDriverGatewayStateOwnership {
  isDockerDriverGatewayPidUsingSelectedState(pid: number): boolean;
  isDockerDriverGatewayStateInUse(): boolean;
}

export function processEnvironmentUsesSelectedGatewayState(
  processEnv: Readonly<Record<string, string>>,
  stateDir: string,
): boolean {
  const selectedNamespace = gatewayIdForStateDir(stateDir);
  const namespace = processEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV];
  const databaseUrl = processEnv.OPENSHELL_DB_URL;
  const selectedDatabaseUrl = `sqlite:${path.join(stateDir, "openshell.db")}`;
  if (databaseUrl !== undefined && databaseUrl !== selectedDatabaseUrl) return false;
  if (namespace === selectedNamespace) return true;
  return (
    (namespace === undefined || namespace === "default") && databaseUrl === selectedDatabaseUrl
  );
}

export function createDockerDriverGatewayStateOwnership(
  deps: DockerDriverGatewayStateOwnershipDeps,
): DockerDriverGatewayStateOwnership {
  const readProcessEnvironment = (pid: number) =>
    (deps.readProcessEnvironment ?? readDockerDriverGatewayProcessEnvironment)(pid);

  function isDockerDriverGatewayPidUsingSelectedState(pid: number): boolean {
    if (!deps.isPidAlive(pid)) return false;
    const processEnv = readProcessEnvironment(pid);
    return processEnv
      ? processEnvironmentUsesSelectedGatewayState(
          processEnv,
          deps.getDockerDriverGatewayStateDir(),
        )
      : false;
  }

  /** Fail closed unless one process scan proves no gateway uses the selected state. */
  function isDockerDriverGatewayStateInUse(): boolean {
    const gatewayBin = deps.resolveOpenShellGatewayBinary();
    try {
      const recordedPid = deps.getDockerDriverGatewayPid();
      if (
        recordedPid !== null &&
        deps.isPidAlive(recordedPid) &&
        deps.isDockerDriverGatewayProcess(recordedPid, gatewayBin, {
          requireDockerDriverEnv: false,
        })
      ) {
        const processEnv = readProcessEnvironment(recordedPid);
        if (!processEnv) return true;
        if (
          processEnvironmentUsesSelectedGatewayState(
            processEnv,
            deps.getDockerDriverGatewayStateDir(),
          )
        ) {
          return true;
        }
      }
    } catch {
      return true;
    }
    let scan: ProcessScanResult;
    try {
      scan = deps.runCaptureEx(["pgrep", "-f", HOST_GATEWAY_PGREP_PATTERN]);
    } catch {
      return true;
    }
    if (scan.timedOut || (scan.exitCode !== 0 && scan.exitCode !== 1)) return true;
    if (scan.exitCode === 1) return false;
    const lines = scan.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) return true;
    for (const line of lines) {
      const recorded = line.trim();
      if (!/^[1-9]\d*$/.test(recorded)) return true;
      const pid = Number(recorded);
      if (!Number.isSafeInteger(pid) || !deps.isPidAlive(pid)) continue;
      if (!deps.isDockerDriverGatewayProcess(pid, gatewayBin, { requireDockerDriverEnv: false })) {
        return true;
      }
      const processEnv = readProcessEnvironment(pid);
      if (!processEnv) return true;
      if (
        processEnvironmentUsesSelectedGatewayState(
          processEnv,
          deps.getDockerDriverGatewayStateDir(),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  return { isDockerDriverGatewayPidUsingSelectedState, isDockerDriverGatewayStateInUse };
}
