// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WILDCARD_GATEWAY_BIND_ADDRESS } from "../../../core/gateway-address";
import {
  type ManagedGatewayDriverConfig,
  writeManagedDriverGatewayConfig,
} from "../../docker-driver-gateway-config";
import { assertManagedDriverGatewayAuthConfigSafe } from "../../docker-driver-gateway-env";
import {
  buildDockerDriverGatewayLocalTlsEnv,
  getDockerDriverGatewayLocalTlsDir,
} from "../../docker-driver-gateway-local-tls";

export const PODMAN_DRIVER_GATEWAY_RUNTIME_ENV_KEYS = [
  "OPENSHELL_DRIVERS",
  "OPENSHELL_BIND_ADDRESS",
  "OPENSHELL_SERVER_PORT",
  "OPENSHELL_DISABLE_TLS",
  "OPENSHELL_DISABLE_GATEWAY_AUTH",
  "OPENSHELL_LOCAL_TLS_DIR",
  "OPENSHELL_DB_URL",
  "OPENSHELL_SSH_GATEWAY_HOST",
  "OPENSHELL_SSH_GATEWAY_PORT",
  "OPENSHELL_PODMAN_SOCKET",
  "OPENSHELL_SUPERVISOR_IMAGE",
  "OPENSHELL_GATEWAY_CONFIG",
  "NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256",
] as const;

export interface BuildPodmanDriverGatewayEnvOptions {
  readonly gatewayPort: number;
  readonly stateDir: string;
  readonly podmanSocketPath: string;
  readonly podmanNetworkName?: string;
  readonly supervisorImage: string;
}

export interface BuildPersistedPodmanDriverGatewayEnvOptions {
  readonly configSha256: string;
  readonly gatewayPort: number;
  readonly podmanSocketPath: string;
  readonly stateDir: string;
  readonly supervisorImage: string;
}

function podmanDriverGatewayBaseEnv({
  gatewayPort,
  stateDir,
  podmanSocketPath,
  supervisorImage,
}: Omit<BuildPodmanDriverGatewayEnvOptions, "podmanNetworkName">): Record<string, string> {
  if (!path.isAbsolute(podmanSocketPath)) {
    throw new Error("OpenShell Podman-driver gateway requires an absolute Podman socket path");
  }
  return {
    OPENSHELL_DRIVERS: "podman",
    OPENSHELL_BIND_ADDRESS: WILDCARD_GATEWAY_BIND_ADDRESS,
    OPENSHELL_SERVER_PORT: String(gatewayPort),
    OPENSHELL_SSH_GATEWAY_HOST: "host.openshell.internal",
    OPENSHELL_SSH_GATEWAY_PORT: String(gatewayPort),
    ...buildDockerDriverGatewayLocalTlsEnv(stateDir),
    OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
    OPENSHELL_PODMAN_SOCKET: podmanSocketPath,
    OPENSHELL_SUPERVISOR_IMAGE: supervisorImage,
  };
}

function podmanDriverConfig(
  env: Record<string, string>,
  stateDir: string,
  networkName: string,
): ManagedGatewayDriverConfig {
  const tlsDir = getDockerDriverGatewayLocalTlsDir(stateDir);
  return {
    driverName: "podman",
    persistedRuntimeKeys: ["socket_path", "network_name", "supervisor_image"],
    entries: [
      ["socket_path", env.OPENSHELL_PODMAN_SOCKET],
      ["image_pull_policy", "missing"],
      ["network_name", networkName],
      ["stop_timeout_secs", 10],
      ["supervisor_image", env.OPENSHELL_SUPERVISOR_IMAGE],
      ["guest_tls_ca", path.join(tlsDir, "ca.crt")],
      ["guest_tls_cert", path.join(tlsDir, "client", "tls.crt")],
      ["guest_tls_key", path.join(tlsDir, "client", "tls.key")],
    ],
  };
}

export function buildPodmanDriverGatewayEnv({
  gatewayPort,
  stateDir,
  podmanSocketPath,
  podmanNetworkName = "openshell",
  supervisorImage,
}: BuildPodmanDriverGatewayEnvOptions): Record<string, string> {
  const env = podmanDriverGatewayBaseEnv({
    gatewayPort,
    stateDir,
    podmanSocketPath,
    supervisorImage,
  });
  env.OPENSHELL_GATEWAY_CONFIG = writeManagedDriverGatewayConfig(
    stateDir,
    env,
    podmanDriverConfig(env, stateDir, podmanNetworkName),
  );
  env.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG))
    .digest("hex");
  assertManagedDriverGatewayAuthConfigSafe(env, {
    allowWildcardBind: true,
    driverName: "Podman",
  });
  return env;
}

/**
 * Reconstruct the exact non-secret Podman process environment from a protected
 * managed-runtime binding without rewriting gateway config during recovery or
 * snapshot preflight.
 */
export function buildPersistedPodmanDriverGatewayEnv(
  options: BuildPersistedPodmanDriverGatewayEnvOptions,
): Record<string, string> {
  if (!/^[0-9a-f]{64}$/u.test(options.configSha256)) {
    throw new Error("Managed Podman gateway config fingerprint is invalid");
  }
  const env = podmanDriverGatewayBaseEnv(options);
  const configPath = path.join(options.stateDir, "openshell-gateway.toml");
  let config: Buffer;
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    config = fs.readFileSync(configPath);
  } catch (error) {
    throw new Error(
      `Managed Podman gateway config is unavailable or unsafe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const actualConfigSha256 = crypto.createHash("sha256").update(config).digest("hex");
  if (actualConfigSha256 !== options.configSha256) {
    throw new Error("Managed Podman gateway config does not match its protected fingerprint");
  }
  env.OPENSHELL_GATEWAY_CONFIG = configPath;
  env.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256 = options.configSha256;
  assertManagedDriverGatewayAuthConfigSafe(env, {
    allowWildcardBind: true,
    driverName: "Podman",
  });
  return env;
}
