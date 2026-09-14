// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "../docker-driver-gateway-config";
import { readDockerDriverGatewayProcessEnvironment } from "../docker-driver-gateway-process-identity";

interface DockerDriverGatewayStateOwnershipDeps {
  getDockerDriverGatewayStateDir(): string;
  isPidAlive(pid: number): boolean;
  readProcessEnvironment?: (pid: number) => Record<string, string> | null;
  runCapture(args: string[], opts?: { ignoreError?: boolean }): string;
}

export interface DockerDriverGatewayStateOwnership {
  isDockerDriverGatewayPidUsingSelectedState(pid: number): boolean;
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

export function readDockerDriverGatewayProcessEnvironmentFromPs(
  pid: number,
  runCapture: (args: string[], opts?: { ignoreError?: boolean }) => string,
): Record<string, string> | null {
  const command = runCapture(["ps", "eww", "-p", String(pid), "-o", "command="], {
    ignoreError: true,
  }).trim();
  const tokens = command.split(/\s+/).filter(Boolean);
  const processEnv: Record<string, string> = {};
  for (const key of [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV, "OPENSHELL_DB_URL"] as const) {
    const prefix = `${key}=`;
    const matches = tokens
      .map((token, index) => ({ index, token }))
      .filter(({ token }) => token.startsWith(prefix));
    if (matches.length > 1) return null;
    const match = matches[0];
    if (!match) continue;
    const next = tokens[match.index + 1];
    if (next && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) return null;
    processEnv[key] = match.token.slice(prefix.length);
  }
  return Object.keys(processEnv).length > 0 ? processEnv : null;
}

export function createDockerDriverGatewayStateOwnership(
  deps: DockerDriverGatewayStateOwnershipDeps,
): DockerDriverGatewayStateOwnership {
  const readProcessEnvironment = (pid: number) =>
    (deps.readProcessEnvironment ?? readDockerDriverGatewayProcessEnvironment)(pid) ??
    readDockerDriverGatewayProcessEnvironmentFromPs(pid, deps.runCapture);

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

  return { isDockerDriverGatewayPidUsingSelectedState };
}
