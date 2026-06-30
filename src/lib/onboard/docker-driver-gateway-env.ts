// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GATEWAY_BIND_ADDRESS,
  getGatewayConnectHost,
  getGatewayHttpsEndpoint,
  WILDCARD_GATEWAY_BIND_ADDRESS,
} from "../core/gateway-address";
import { GATEWAY_PORT } from "../core/ports";
import {
  DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  prepareDockerDriverGatewayConfigEnv,
} from "./docker-driver-gateway-config";
import { buildDockerDriverGatewayLocalTlsEnv } from "./docker-driver-gateway-local-tls";
import {
  hasOpenShellGatewayUserService,
  type PackageManagedDockerDriverGatewayOptions,
  startPackageManagedDockerDriverGateway,
} from "./docker-driver-gateway-service";

export { getGatewayHttpsEndpoint, startPackageManagedDockerDriverGateway };

export const DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS = [
  "OPENSHELL_DRIVERS",
  "OPENSHELL_BIND_ADDRESS",
  "OPENSHELL_SERVER_PORT",
  "OPENSHELL_DISABLE_TLS",
  "OPENSHELL_DISABLE_GATEWAY_AUTH",
  "OPENSHELL_LOCAL_TLS_DIR",
  "OPENSHELL_DB_URL",
  "OPENSHELL_GRPC_ENDPOINT",
  "OPENSHELL_SSH_GATEWAY_HOST",
  "OPENSHELL_SSH_GATEWAY_PORT",
  "OPENSHELL_DOCKER_NETWORK_NAME",
  "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
  "OPENSHELL_DOCKER_SUPERVISOR_BIN",
  "OPENSHELL_GATEWAY_CONFIG",
  "OPENSHELL_VM_DRIVER_STATE_DIR",
  "OPENSHELL_DRIVER_DIR",
] as const;

export interface BuildDockerDriverGatewayEnvOptions {
  platform?: NodeJS.Platform;
  gatewayPort?: number;
  stateDir: string;
  dockerNetworkName?: string;
  getDockerSupervisorImage: () => string;
  resolveSandboxBin: () => string | null;
}

export type PackageManagedDockerDriverGatewayWithEnvOverrideOptions = Omit<
  PackageManagedDockerDriverGatewayOptions,
  "prepareOpenShellGatewayUserServiceEnv"
> & {
  gatewayEnv: Record<string, string>;
};

export function getGatewayPortCheckOptions(): { host: string } {
  return { host: GATEWAY_BIND_ADDRESS };
}

export function getGatewayStartNetworkEnv(
  gatewayPort: number = GATEWAY_PORT,
): Record<string, string> {
  return {
    OPENSHELL_BIND_ADDRESS: GATEWAY_BIND_ADDRESS,
    OPENSHELL_SERVER_PORT: String(gatewayPort),
    OPENSHELL_SSH_GATEWAY_HOST: getGatewayConnectHost(),
    OPENSHELL_SSH_GATEWAY_PORT: String(gatewayPort),
  };
}

export function assertDockerDriverGatewayBindAddressSafe(gatewayEnv: Record<string, string>): void {
  if (gatewayEnv.OPENSHELL_BIND_ADDRESS !== WILDCARD_GATEWAY_BIND_ADDRESS) return;
  throw new Error(
    "NEMOCLAW_GATEWAY_BIND_ADDRESS=0.0.0.0 is not supported for the OpenShell Docker-driver gateway while gateway JWT auth is active. Remove the override, or use NEMOCLAW_DASHBOARD_BIND for dashboard exposure.",
  );
}

type TomlScalar = boolean | number | string;

function parseTomlScalar(raw: string): TomlScalar | undefined {
  const booleanMatch = raw.match(/^(true|false)(?:\s+#.*)?$/);
  if (booleanMatch?.[1]) return booleanMatch[1] === "true";
  const integerMatch = raw.match(/^(\d+)(?:\s+#.*)?$/);
  if (integerMatch?.[1]) return Number(integerMatch[1]);
  const stringMatch = raw.match(/^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/);
  if (!stringMatch?.[1]) return undefined;
  try {
    const value: unknown = JSON.parse(stringMatch[1]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseTomlScalarValues(toml: string): Map<string, TomlScalar> {
  const values = new Map<string, TomlScalar>();
  let section = "";
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      continue;
    }
    const assignmentMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!assignmentMatch?.[1] || !assignmentMatch[2]) continue;
    const value = parseTomlScalar(assignmentMatch[2]);
    if (value !== undefined) values.set(`${section}.${assignmentMatch[1]}`, value);
  }
  return values;
}

function assertTomlBoolean(values: Map<string, TomlScalar>, key: string, expected: boolean): void {
  const actual = values.get(key);
  if (actual === expected) return;
  throw new Error(
    `OpenShell Docker-driver gateway config must set ${key}=${expected}; found ${
      actual === undefined ? "missing" : actual
    }`,
  );
}

function assertTomlString(values: Map<string, TomlScalar>, key: string): string {
  const actual = values.get(key);
  if (typeof actual === "string" && actual.trim()) return actual;
  throw new Error(`OpenShell Docker-driver gateway config must set non-empty ${key}`);
}

function assertTomlInteger(values: Map<string, TomlScalar>, key: string, expected: number): void {
  const actual = values.get(key);
  if (actual === expected) return;
  throw new Error(
    `OpenShell Docker-driver gateway config must set ${key}=${expected}; found ${
      actual === undefined ? "missing" : String(actual)
    }`,
  );
}

function assertGatewayJwtFile(key: string, filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`OpenShell Docker-driver gateway config ${key} must be an absolute path`);
  }
  try {
    if (fs.statSync(filePath).isFile()) {
      fs.accessSync(filePath, fs.constants.R_OK);
      return;
    }
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new Error(
    `OpenShell Docker-driver gateway config ${key} must reference an existing readable file`,
  );
}

export function assertDockerDriverGatewayAuthConfigSafe(gatewayEnv: Record<string, string>): void {
  assertDockerDriverGatewayBindAddressSafe(gatewayEnv);
  const configPath = gatewayEnv.OPENSHELL_GATEWAY_CONFIG?.trim();
  if (!configPath) {
    throw new Error("OpenShell Docker-driver gateway requires OPENSHELL_GATEWAY_CONFIG");
  }
  const toml = fs.readFileSync(configPath, "utf-8");
  const values = parseTomlScalarValues(toml);
  assertTomlBoolean(values, "openshell.gateway.disable_tls", false);
  assertTomlBoolean(values, "openshell.gateway.tls.require_client_auth", true);
  assertTomlBoolean(values, "openshell.gateway.mtls_auth.enabled", true);
  assertTomlBoolean(values, "openshell.gateway.auth.allow_unauthenticated_users", false);
  for (const key of ["signing_key_path", "public_key_path", "kid_path"] as const) {
    const fullKey = `openshell.gateway.gateway_jwt.${key}`;
    assertGatewayJwtFile(fullKey, assertTomlString(values, fullKey));
  }
  assertTomlString(values, "openshell.gateway.gateway_jwt.gateway_id");
  assertTomlInteger(
    values,
    "openshell.gateway.gateway_jwt.ttl_secs",
    DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  );
}

export function getDockerDriverGatewayEndpoint(gatewayPort: number = GATEWAY_PORT): string {
  return getGatewayHttpsEndpoint(gatewayPort);
}

export function warnIfGatewayWildcardBindAddress(): void {
  if (GATEWAY_BIND_ADDRESS !== WILDCARD_GATEWAY_BIND_ADDRESS) return;
  console.log(
    "  ! OpenShell gateway bind address set to 0.0.0.0; the gateway may be reachable from other hosts on this network.",
  );
}

export function buildDockerDriverGatewayEnv({
  platform = process.platform,
  gatewayPort = GATEWAY_PORT,
  stateDir,
  dockerNetworkName = "openshell-docker",
  getDockerSupervisorImage,
  resolveSandboxBin,
}: BuildDockerDriverGatewayEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    OPENSHELL_DRIVERS: "docker",
    ...getGatewayStartNetworkEnv(gatewayPort),
    ...buildDockerDriverGatewayLocalTlsEnv(stateDir),
    OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
    OPENSHELL_GRPC_ENDPOINT: getDockerDriverGatewayEndpoint(gatewayPort),
    OPENSHELL_DOCKER_NETWORK_NAME: dockerNetworkName,
    OPENSHELL_DOCKER_SUPERVISOR_IMAGE: getDockerSupervisorImage(),
  };
  if (platform === "linux") {
    const sandboxBin = resolveSandboxBin();
    if (sandboxBin) {
      env.OPENSHELL_DOCKER_SUPERVISOR_BIN = sandboxBin;
    }
  }
  prepareDockerDriverGatewayConfigEnv(env, stateDir, env.OPENSHELL_DOCKER_SUPERVISOR_BIN);
  return env;
}

export function buildDockerGatewayDebEnvFile(
  existing: string,
  override: Record<string, string>,
): string {
  const managedKeyPattern = new RegExp(`^(${DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS.join("|")})=`);
  const preserved = existing
    .split("\n")
    .filter((line) => line.trim() && !managedKeyPattern.test(line));
  const managed = DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS.flatMap((key) =>
    typeof override[key] === "string" ? [formatEnvironmentFileAssignment(key, override[key])] : [],
  );
  return `${[...preserved, ...managed].join("\n")}\n`;
}

function formatEnvironmentFileAssignment(key: string, value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`Invalid OpenShell gateway env value for ${key}: contains a line break`);
  }
  return `${key}=${value}`;
}

function readTextFileIfPresent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

function writeDockerGatewayDebEnvOverrideFile(getOverride: () => Record<string, string>): void {
  const override = getOverride();
  const envDir = path.join(os.homedir(), ".config", "openshell");
  const envFile = path.join(envDir, "gateway.env");
  fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(envDir, 0o700);
  const existing = readTextFileIfPresent(envFile);
  fs.writeFileSync(envFile, buildDockerGatewayDebEnvFile(existing, override), {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.chmodSync(envFile, 0o600);
}

export function writeDockerGatewayDebEnvOverride(
  getOverride: () => Record<string, string>,
  opts: Parameters<typeof hasOpenShellGatewayUserService>[0] = {},
): boolean {
  if (!hasOpenShellGatewayUserService(opts)) return false;
  writeDockerGatewayDebEnvOverrideFile(getOverride);
  return true;
}

export function writeDockerGatewayDebEnvOverrideOrThrow(
  getOverride: () => Record<string, string>,
  opts: Parameters<typeof hasOpenShellGatewayUserService>[0] = {},
): void {
  if (!writeDockerGatewayDebEnvOverride(getOverride, opts)) {
    throw new Error("OpenShell gateway user service env file is not available");
  }
}

export function startPackageManagedDockerDriverGatewayWithEnvOverride({
  gatewayEnv,
  ...options
}: PackageManagedDockerDriverGatewayWithEnvOverrideOptions): Promise<boolean> {
  assertDockerDriverGatewayAuthConfigSafe(gatewayEnv);
  return startPackageManagedDockerDriverGateway({
    ...options,
    prepareOpenShellGatewayUserServiceEnv: () =>
      writeDockerGatewayDebEnvOverrideFile(() => gatewayEnv),
  });
}
