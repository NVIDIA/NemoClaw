// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { openRegularFileNoFollow } from "../../../adapters/fs/regular-file";
import {
  type DockerDriverGatewayDriver,
  DOCKER_DRIVER_GATEWAY_CONFIG_NAME,
} from "../../../onboard/docker-driver-gateway-config";
import {
  getDockerDriverGatewayRuntimeMarkerPath,
  NEMOCLAW_OPENSHELL_GATEWAY_CONFIG_SHA256_ENV,
  parseDockerDriverGatewayRuntimeMarker,
} from "../../../onboard/docker-driver-gateway-runtime-marker";
import { getTrustedActiveOpenShellGatewayUserServiceIdentity } from "../../../onboard/docker-driver-gateway-service";
import { resolveGatewayStateDirForPort } from "../../../onboard/gateway/state-dir";
import {
  externallySupervisedHostGatewayProcessOwnershipFailure,
  readHostGatewayProcessEnvironment,
  scopedHostGatewayProcessOwnershipFailure,
} from "../../../onboard/host-gateway-process";

const MAX_GATEWAY_IDENTITY_FILE_BYTES = 64 * 1024;

function asTable(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOwnedGatewayFile(filePath: string): Buffer {
  const file = openRegularFileNoFollow(filePath);
  try {
    const state = file.stat();
    if ((state.mode & 0o077) !== 0) {
      throw new Error("file is not private");
    }
    return file.readBytes(MAX_GATEWAY_IDENTITY_FILE_BYTES);
  } finally {
    file.close();
  }
}

function configuredDriverProxyHostnameMode(configBytes: Buffer): {
  driver: DockerDriverGatewayDriver;
  proxyHostnameMode: unknown;
} {
  const parsed = asTable(parseToml(configBytes.toString("utf-8")));
  const openshell = asTable(parsed?.openshell);
  const gateway = asTable(openshell?.gateway);
  const computeDrivers = gateway?.compute_drivers;
  if (
    !Array.isArray(computeDrivers) ||
    computeDrivers.length !== 1 ||
    (computeDrivers[0] !== "docker" && computeDrivers[0] !== "podman")
  ) {
    throw new Error("config does not select one supported compute driver");
  }
  const drivers = asTable(openshell?.drivers);
  const driver = asTable(drivers?.[computeDrivers[0]]);
  if (!driver) throw new Error("selected driver config is missing");
  return {
    driver: computeDrivers[0],
    proxyHostnameMode: driver.proxy_connect_by_hostname,
  };
}

function refusal(detail: string): Error {
  return new Error(
    `Managed MCP requires the selected OpenShell gateway to run with proxy_connect_by_hostname = false (${detail}). ` +
      "Restart the gateway through its declared lifecycle authority after applying that setting, then retry. Refusing MCP policy, provider, and adapter mutation.",
  );
}

/**
 * Bind MCP address pins to the selected running gateway. The ordinary gateway
 * ownership proof ties the PID, runtime marker, process environment, command
 * line, state directory, and canonical config together. This additional proof
 * requires proxy hostname resolution to be disabled and binds the exact
 * config bytes to the launch marker or managed-service environment.
 */
export function assertMcpGatewayProxyDnsDisabled(gatewayName: string, gatewayPort: number): void {
  const stateDir = resolveGatewayStateDirForPort({
    configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    home: os.homedir(),
    port: gatewayPort,
  });
  const configPath = path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME);
  let configBytes: Buffer;
  let driver: DockerDriverGatewayDriver;
  let proxyHostnameMode: unknown;
  try {
    configBytes = readOwnedGatewayFile(configPath);
    ({ driver, proxyHostnameMode } = configuredDriverProxyHostnameMode(configBytes));
  } catch (error) {
    throw refusal(error instanceof Error ? error.message : "the gateway config is unreadable");
  }
  if (proxyHostnameMode !== false && proxyHostnameMode !== undefined) {
    throw refusal("the selected driver enables proxy hostname resolution");
  }

  const ownershipFailure = scopedHostGatewayProcessOwnershipFailure(
    {},
    {
      driver,
      gatewayBin: process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN,
      openShellGatewayName: gatewayName,
      openShellGatewayPort: gatewayPort,
      stateDir,
    },
  );

  const configSha256 = crypto.createHash("sha256").update(configBytes).digest("hex");
  if (ownershipFailure) {
    const service = getTrustedActiveOpenShellGatewayUserServiceIdentity();
    if (!service?.executablePath) throw refusal(ownershipFailure);
    const serviceOwnershipFailure = externallySupervisedHostGatewayProcessOwnershipFailure(
      {},
      {
        driver,
        gatewayBin: service.executablePath,
        gatewayName,
        gatewayPort,
        pid: service.pid,
        stateDir,
      },
    );
    if (serviceOwnershipFailure) {
      throw refusal(`${ownershipFailure}; managed service: ${serviceOwnershipFailure}`);
    }
    const serviceEnvironment = readHostGatewayProcessEnvironment(service.pid);
    const serviceConfigPath = serviceEnvironment?.OPENSHELL_GATEWAY_CONFIG;
    if (!serviceConfigPath || path.resolve(serviceConfigPath) !== path.resolve(configPath)) {
      throw refusal("the managed service process does not identify the selected gateway config");
    }
    const launchedConfigSha256 = serviceEnvironment?.[NEMOCLAW_OPENSHELL_GATEWAY_CONFIG_SHA256_ENV];
    if (launchedConfigSha256 === configSha256) return;
    if (launchedConfigSha256 === undefined) {
      throw refusal("the managed service launch does not record a gateway config digest");
    }
    throw refusal("the managed service config differs from its launch environment");
  }

  let marker;
  try {
    marker = parseDockerDriverGatewayRuntimeMarker(
      readOwnedGatewayFile(getDockerDriverGatewayRuntimeMarkerPath(stateDir)).toString("utf-8"),
    );
  } catch (error) {
    throw refusal(error instanceof Error ? error.message : "the runtime marker is unreadable");
  }
  if (!marker) throw refusal("the runtime marker is missing or invalid");

  const legacyMarker =
    marker.gatewayConfigPath === undefined && marker.gatewayConfigSha256 === undefined;
  if (legacyMarker) {
    throw refusal("the gateway launch marker does not record a gateway config identity");
  }

  if (
    marker.gatewayConfigPath !== path.resolve(configPath) ||
    marker.gatewayConfigSha256 !== configSha256
  ) {
    throw refusal("the effective config does not match the config recorded at gateway launch");
  }
}
