// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

export function selectPreparedGatewayRuntime(source: string): string {
  return [
    [
      "  getDockerDriverGatewayPid(): number | null;",
      `  getDockerDriverGatewayPreparation(
    versionOutput?: string | null,
    platform?: NodeJS.Platform,
  ): import("./docker-driver-gateway-env").DockerDriverGatewayPreparation;
  getDockerDriverGatewayPid(): number | null;`,
    ],
    [
      `  function getDockerDriverGatewayEnv(
    versionOutput: string | null = null,
    platform: NodeJS.Platform = process.platform,
  ): Record<string, string> {`,
      `  function getDockerDriverGatewayPreparation(
    versionOutput: string | null = null,
    platform: NodeJS.Platform = process.platform,
  ): import("./docker-driver-gateway-env").DockerDriverGatewayPreparation {`,
    ],
    [
      "const gatewayEnv = dockerDriverGatewayEnv.buildDockerDriverGatewayEnv({",
      "const preparation = dockerDriverGatewayEnv.prepareDockerDriverGatewayEnv({",
    ],
    [
      `    if (gatewayEnv.OPENSHELL_LOCAL_TLS_DIR) {
      process.env.OPENSHELL_LOCAL_TLS_DIR = gatewayEnv.OPENSHELL_LOCAL_TLS_DIR;
    }
    return gatewayEnv;`,
      `    if (preparation.gatewayEnv.OPENSHELL_LOCAL_TLS_DIR) {
      process.env.OPENSHELL_LOCAL_TLS_DIR = preparation.gatewayEnv.OPENSHELL_LOCAL_TLS_DIR;
    }
    return preparation;
  }

  function getDockerDriverGatewayEnv(
    versionOutput: string | null = null,
    platform: NodeJS.Platform = process.platform,
  ): Record<string, string> {
    return getDockerDriverGatewayPreparation(versionOutput, platform).gatewayEnv;`,
    ],
    [
      "    getDockerDriverGatewayEnv,",
      "    getDockerDriverGatewayEnv,\n    getDockerDriverGatewayPreparation,",
    ],
  ].reduce((result, [expected, replacement]) => {
    assert.ok(result.includes(expected), `preparation fixture must contain ${expected}`);
    return result.replaceAll(expected, replacement);
  }, source);
}

export function selectCentralizedGatewayStateOwnershipRuntime(source: string): string {
  return [
    [
      `import {
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "./docker-driver-gateway-config";
`,
      "",
    ],
    ['import { HOST_GATEWAY_PGREP_PATTERN } from "./host-gateway-process";\n', ""],
    ["  isDockerDriverGatewayStateInUse(): boolean;\n", ""],
    [
      `  function readProcessEnvironmentFromPs(pid: number): Record<string, string> | null {
    const command = deps
      .runCapture(["ps", "eww", "-p", String(pid), "-o", "command="], { ignoreError: true })
      .trim();
    const prefix = \`\${NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV}=\`;
    const value = command.split(/\\s+/).find((token) => token.startsWith(prefix));
    return value
      ? { [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: value.slice(prefix.length) }
      : null;
  }

  /**
   * Fail-closed recovery probe for every direct gateway process that can still
   * use the selected state directory, including a service-manager replacement
   * whose PID differs from the recorded standalone process.
   */
  function isDockerDriverGatewayStateInUse(): boolean {
    if (isDockerDriverGatewayProcessAlive()) return true;
    if (!deps.runCaptureEx) return true;
    const scan = deps.runCaptureEx(["pgrep", "-f", HOST_GATEWAY_PGREP_PATTERN]);
    if (scan.timedOut || (scan.exitCode !== 0 && scan.exitCode !== 1)) return true;
    if (scan.exitCode === 1) return false;
    const selectedNamespace = gatewayIdForStateDir(getDockerDriverGatewayStateDir());
    const gatewayBin = resolveOpenShellGatewayBinary();
    const lines = scan.stdout.split(/\\r?\\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) return true;
    for (const line of lines) {
      const recorded = line.trim();
      if (!/^[1-9]\\d*$/.test(recorded)) return true;
      const pid = Number(recorded);
      if (!Number.isSafeInteger(pid) || !isPidAlive(pid)) continue;
      if (!isDockerDriverGatewayProcess(pid, gatewayBin, { requireDockerDriverEnv: false })) {
        return true;
      }
      const processEnv = readProcessEnv(pid) ?? readProcessEnvironmentFromPs(pid);
      if (!processEnv) return true;
      if (processEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV] === selectedNamespace) return true;
    }
    return false;
  }

`,
      "",
    ],
    ["    isDockerDriverGatewayStateInUse,\n", ""],
  ].reduce((result, [expected, replacement]) => {
    assert.ok(result.includes(expected), `state-ownership fixture must contain ${expected}`);
    return result.replaceAll(expected, replacement);
  }, source);
}

export function selectPreparedCentralizedGatewayStateOwnershipRuntime(source: string): string {
  return selectPreparedGatewayRuntime(selectCentralizedGatewayStateOwnershipRuntime(source));
}
