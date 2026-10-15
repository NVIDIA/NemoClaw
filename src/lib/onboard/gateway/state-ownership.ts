// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { dockerContextIsDefaultFromBuild } from "../../adapters/docker/client-isolation";
import { dockerRun } from "../../adapters/docker/run";
import {
  parseRetainedSandboxCreateAuthority,
  type RetainedSandboxCreateAuthority,
} from "../../state/onboard-session/retained-sandbox-recovery";
import { resolveGatewayStateDirForPort } from "./state-dir";

import { readDockerDriverGatewayProcessEnvironment } from "../docker-driver-gateway-process-identity";
import {
  HOST_GATEWAY_PGREP_PATTERN,
  resolveOwnedHostGatewayRuntimeProviderId,
} from "../host-gateway-process";
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

/** Observe the same native gateway and daemon authority for create and retained recovery. */
export function captureNativeDockerRecoveryAuthority(
  gatewayName: string,
  gatewayPort: number,
  reservationSessionId: string,
): RetainedSandboxCreateAuthority | undefined {
  if (process.platform !== "linux") return undefined;
  if (
    process.env.DOCKER_HOST?.trim() !== "unix:///var/run/docker.sock" &&
    !dockerContextIsDefaultFromBuild(process.env)
  )
    return undefined;
  const gatewayStateDir = resolveGatewayStateDirForPort({
    configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    home: os.homedir(),
    port: gatewayPort,
  });
  const ownedRuntime = () =>
    resolveOwnedHostGatewayRuntimeProviderId({
      gatewayName,
      gatewayPort,
      stateDir: gatewayStateDir,
      requireDefaultDockerDaemon: true,
    });
  if (ownedRuntime() !== "docker") return undefined;
  const result = dockerRun(["--context", "default", "info", "--format", "{{.ID}}"], {
    ignoreError: true,
    suppressOutput: true,
    timeout: 5_000,
  });
  const authority = parseRetainedSandboxCreateAuthority({
    schemaVersion: 1,
    runtime: "native-linux-default-docker",
    reservationSessionId,
    gatewayStateDir,
    daemonId: String(result.stdout ?? "").trim(),
  });
  if (
    result.status !== 0 ||
    String(result.stderr ?? "").trim() ||
    !authority ||
    ownedRuntime() !== "docker"
  ) {
    throw new Error("Cannot establish the owned Docker daemon for retained create recovery.");
  }
  return authority;
}
