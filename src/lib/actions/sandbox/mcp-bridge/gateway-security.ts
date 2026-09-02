// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import {
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
import {
  readPrivateGatewayConfig,
  readPrivateGatewayRuntimeMarker,
} from "../../../state/gateway-runtime/files";

type ManagedMcpGatewayDriver = "docker" | "podman";

function asTable(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function configuredDriverProxyHostnameMode(configBytes: Buffer): {
  driver: ManagedMcpGatewayDriver;
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
    `Managed MCP requires the selected OpenShell gateway to keep proxy_connect_by_hostname disabled (${detail}). ` +
      "Restart the gateway through its declared lifecycle authority after applying that setting, then retry. Refusing MCP policy, provider, and adapter mutation.",
  );
}

/**
 * Bind MCP address pins to the selected running gateway. The ordinary gateway
 * ownership proof ties the PID, runtime marker, process environment, command
 * line, state directory, and canonical config together. This additional proof
 * requires proxy hostname resolution to stay at its disabled default or be
 * explicitly disabled, and binds the exact
 * config bytes to the launch marker or managed-service environment.
 */
export function assertMcpGatewayProxyDnsDisabled(gatewayName: string, gatewayPort: number): void {
  const stateDir = resolveGatewayStateDirForPort({
    configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    home: os.homedir(),
    port: gatewayPort,
  });
  let configPath: string;
  let configBytes: Buffer;
  let driver: ManagedMcpGatewayDriver;
  let proxyHostnameMode: unknown;
  try {
    ({ path: configPath, bytes: configBytes } = readPrivateGatewayConfig(stateDir));
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
      readPrivateGatewayRuntimeMarker(stateDir).bytes.toString("utf-8"),
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

  if (!marker.openShellDriver) {
    throw refusal("the gateway launch marker does not record the selected OpenShell driver");
  }
  if (marker.openShellDriver !== driver) {
    throw refusal(
      "the gateway launch marker OpenShell driver does not match the selected config driver",
    );
  }

  if (
    marker.gatewayConfigPath !== path.resolve(configPath) ||
    marker.gatewayConfigSha256 !== configSha256
  ) {
    throw refusal("the effective config does not match the config recorded at gateway launch");
  }
}
