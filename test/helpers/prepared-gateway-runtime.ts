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
