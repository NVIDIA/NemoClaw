// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { readDockerDriverGatewayProcessEnvironment } from "../docker-driver-gateway-process-identity";
import { HOST_GATEWAY_PGREP_PATTERN } from "../host-gateway-process";
import {
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
  processEnvironmentUsesSelectedGatewayState,
} from "./process-environment";

export { processEnvironmentUsesSelectedGatewayState } from "./process-environment";

interface ProcessScanResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

interface DockerDriverGatewayStateOwnershipDeps {
  getDockerDriverGatewayStateDir(): string;
  isDockerDriverGatewayProcess(
    pid: number,
    gatewayBin?: string | null,
    opts?: { requireDockerDriverEnv?: boolean },
  ): boolean;
  isPidAlive(pid: number): boolean;
  readProcessEnvironment?: (pid: number) => Record<string, string> | null;
  resolveOpenShellGatewayBinary(): string | null;
  runCapture(args: string[], opts?: { ignoreError?: boolean }): string;
  runCaptureEx(args: readonly string[]): ProcessScanResult;
}

export interface DockerDriverGatewayStateOwnership {
  isDockerDriverGatewayPidUsingSelectedState(pid: number): boolean;
  isDockerDriverGatewayStateInUse(): boolean;
}

function readProcessEnvironmentFromPs(
  pid: number,
  stateDir: string,
  runCapture: DockerDriverGatewayStateOwnershipDeps["runCapture"],
): Record<string, string> | null {
  // `ps eww` separates environment entries with spaces and does not preserve
  // where a value containing whitespace ends. Do not use that fallback to
  // authorize a state operation when the selected database path is ambiguous.
  if (/\s/u.test(path.join(stateDir, "openshell.db"))) return null;
  const command = runCapture(["ps", "eww", "-p", String(pid), "-o", "command="], {
    ignoreError: true,
  }).trim();
  const processEnv: Record<string, string> = {};
  for (const key of [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV, "OPENSHELL_DB_URL"] as const) {
    const prefix = `${key}=`;
    const value = command.split(/\s+/).find((token) => token.startsWith(prefix));
    if (value) processEnv[key] = value.slice(prefix.length);
  }
  return Object.keys(processEnv).length > 0 ? processEnv : null;
}

export function createDockerDriverGatewayStateOwnership(
  deps: DockerDriverGatewayStateOwnershipDeps,
): DockerDriverGatewayStateOwnership {
  const readProcessEnvironment = (pid: number) => {
    const processEnv = (deps.readProcessEnvironment ?? readDockerDriverGatewayProcessEnvironment)(
      pid,
    );
    return (
      processEnv ??
      readProcessEnvironmentFromPs(pid, deps.getDockerDriverGatewayStateDir(), deps.runCapture)
    );
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

  function isDockerDriverGatewayStateInUse(): boolean {
    const scan = deps.runCaptureEx(["pgrep", "-f", HOST_GATEWAY_PGREP_PATTERN]);
    if (scan.timedOut || (scan.exitCode !== 0 && scan.exitCode !== 1)) return true;
    if (scan.exitCode === 1) return false;
    const lines = scan.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) return true;
    const gatewayBin = deps.resolveOpenShellGatewayBinary();
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
