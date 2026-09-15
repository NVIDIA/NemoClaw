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
  platform?: NodeJS.Platform;
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
  if (databaseUrl !== undefined) return databaseUrl === selectedDatabaseUrl;
  if (namespace === selectedNamespace) return true;
  return false;
}

function processEnvironmentFromPsOutput(stdout: string): Record<string, string> | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) return null;

  const environment: Record<string, string> = {};
  for (const key of [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV, "OPENSHELL_DB_URL"]) {
    const prefix = `${key}=`;
    const values = lines[0]
      .split(/\s+/)
      .filter((token) => token.startsWith(prefix))
      .map((token) => token.slice(prefix.length));
    if (values.length > 1) return null;
    if (values.length === 1) environment[key] = values[0];
  }
  return Object.keys(environment).length > 0 ? environment : null;
}

export function createDockerDriverGatewayStateOwnership(
  deps: DockerDriverGatewayStateOwnershipDeps,
): DockerDriverGatewayStateOwnership {
  const readProcessEnvironment = (pid: number) => {
    const environment = (deps.readProcessEnvironment ?? readDockerDriverGatewayProcessEnvironment)(
      pid,
    );
    if (environment || (deps.platform ?? process.platform) !== "darwin") return environment;
    try {
      const result = deps.runCaptureEx(["ps", "eww", "-p", String(pid), "-o", "command="]);
      if (result.timedOut || result.exitCode !== 0) return null;
      return processEnvironmentFromPsOutput(result.stdout);
    } catch {
      return null;
    }
  };

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
