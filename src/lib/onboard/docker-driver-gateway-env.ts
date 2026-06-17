// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_GATEWAY_BIND_ADDRESS,
  type GatewayBindAddress,
  getGatewayConnectHost,
  getGatewayHttpEndpoint,
  getGatewayHttpsEndpoint,
  parseGatewayBindAddress,
  WILDCARD_GATEWAY_BIND_ADDRESS,
} from "../core/gateway-address";
import { GATEWAY_PORT } from "../core/ports";
import {
  hasOpenShellGatewayUserService,
  type PackageManagedDockerDriverGatewayOptions,
  startPackageManagedDockerDriverGateway,
} from "./docker-driver-gateway-service";
import {
  detectWslDockerDesktopStatus,
  type WslDockerDesktopDetectionDeps,
  type WslDockerDesktopStatus,
} from "./wsl-docker-desktop-gpu";

export { getGatewayHttpsEndpoint, startPackageManagedDockerDriverGateway };

export const DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS = [
  "OPENSHELL_DRIVERS",
  "OPENSHELL_BIND_ADDRESS",
  "OPENSHELL_SERVER_PORT",
  "OPENSHELL_DISABLE_TLS",
  "OPENSHELL_DISABLE_GATEWAY_AUTH",
  "OPENSHELL_DB_URL",
  "OPENSHELL_GRPC_ENDPOINT",
  "OPENSHELL_SSH_GATEWAY_HOST",
  "OPENSHELL_SSH_GATEWAY_PORT",
  "OPENSHELL_DOCKER_NETWORK_NAME",
  "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
  "OPENSHELL_DOCKER_SUPERVISOR_BIN",
  "OPENSHELL_VM_DRIVER_STATE_DIR",
  "OPENSHELL_DRIVER_DIR",
] as const;

export interface BuildDockerDriverGatewayEnvOptions {
  platform?: NodeJS.Platform;
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

export type GatewayBindAddressDeps = WslDockerDesktopDetectionDeps & {
  /**
   * Override the Docker Desktop WSL probe (defaults to the real detector).
   * Tests inject a stub to stay deterministic without invoking `docker info`.
   */
  detectStatus?: (deps: WslDockerDesktopDetectionDeps) => WslDockerDesktopStatus;
};

// Memoized real-host detection so a single onboard run performs at most one
// `docker info` for the gateway bind decision (the resolver is consulted by the
// preflight port check, the gateway env build, and the wildcard-bind warning).
let cachedWslDockerDesktopStatus: WslDockerDesktopStatus | null = null;

function resolveWslDockerDesktopStatus(deps: GatewayBindAddressDeps): WslDockerDesktopStatus {
  const { detectStatus, ...detectionDeps } = deps;
  if (detectStatus) return detectStatus(detectionDeps);
  // Real-host probe: memoize the argless production call so onboard runs
  // `docker info` at most once; deps-bearing calls bypass the cache. A prior
  // "unknown" (e.g. docker not yet reachable when the preflight port check ran)
  // is not sticky — re-probe so a later definitive result still drives the bind.
  if (Object.keys(detectionDeps).length > 0) return detectWslDockerDesktopStatus(detectionDeps);
  if (cachedWslDockerDesktopStatus === null || cachedWslDockerDesktopStatus === "unknown") {
    cachedWslDockerDesktopStatus = detectWslDockerDesktopStatus(detectionDeps);
  }
  return cachedWslDockerDesktopStatus;
}

export function resetGatewayBindAddressDetectionCacheForTests(): void {
  cachedWslDockerDesktopStatus = null;
}

/**
 * Resolve the effective OpenShell gateway bind address.
 *
 * An explicit `NEMOCLAW_GATEWAY_BIND_ADDRESS` always wins. With no override,
 * Docker Desktop WSL must bind the wildcard address: sandbox containers reach
 * the gateway via Docker's `host-gateway` route, which Docker Desktop maps to
 * its own bridge IP rather than the WSL distro loopback, so a 127.0.0.1 bind is
 * unreachable and the onboard [2/8] sandbox-bridge reachability probe fails
 * 100% of the time (#5513). The container compatibility path already binds
 * 0.0.0.0 for the same reason; this brings the host-mode gateway in line.
 */
export function resolveGatewayBindAddress(deps: GatewayBindAddressDeps = {}): GatewayBindAddress {
  const env = deps.env ?? process.env;
  const explicit = env.NEMOCLAW_GATEWAY_BIND_ADDRESS;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return parseGatewayBindAddress(
      "NEMOCLAW_GATEWAY_BIND_ADDRESS",
      DEFAULT_GATEWAY_BIND_ADDRESS,
      env,
    );
  }
  if (resolveWslDockerDesktopStatus(deps) === "docker-desktop") {
    return WILDCARD_GATEWAY_BIND_ADDRESS;
  }
  return DEFAULT_GATEWAY_BIND_ADDRESS;
}

export function getGatewayPortCheckOptions(deps: GatewayBindAddressDeps = {}): {
  host: string;
} {
  return { host: resolveGatewayBindAddress(deps) };
}

export function getGatewayStartNetworkEnv(
  deps: GatewayBindAddressDeps = {},
): Record<string, string> {
  const bindAddress = resolveGatewayBindAddress(deps);
  return {
    OPENSHELL_BIND_ADDRESS: bindAddress,
    OPENSHELL_SERVER_PORT: String(GATEWAY_PORT),
    OPENSHELL_SSH_GATEWAY_HOST: getGatewayConnectHost(bindAddress),
    OPENSHELL_SSH_GATEWAY_PORT: String(GATEWAY_PORT),
  };
}

export function getDockerDriverGatewayEndpoint(): string {
  return getGatewayHttpEndpoint();
}

export function warnIfGatewayWildcardBindAddress(deps: GatewayBindAddressDeps = {}): void {
  if (resolveGatewayBindAddress(deps) !== WILDCARD_GATEWAY_BIND_ADDRESS) return;
  console.log(
    "  ! OpenShell gateway bind address set to 0.0.0.0; the gateway may be reachable from other hosts on this network.",
  );
}

export function buildDockerDriverGatewayEnv({
  platform = process.platform,
  stateDir,
  dockerNetworkName = "openshell-docker",
  getDockerSupervisorImage,
  resolveSandboxBin,
}: BuildDockerDriverGatewayEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    OPENSHELL_DRIVERS: "docker",
    ...getGatewayStartNetworkEnv(),
    OPENSHELL_DISABLE_TLS: "true",
    OPENSHELL_DISABLE_GATEWAY_AUTH: "true",
    OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
    OPENSHELL_GRPC_ENDPOINT: getDockerDriverGatewayEndpoint(),
    OPENSHELL_DOCKER_NETWORK_NAME: dockerNetworkName,
    OPENSHELL_DOCKER_SUPERVISOR_IMAGE: getDockerSupervisorImage(),
  };
  if (platform === "linux") {
    const sandboxBin = resolveSandboxBin();
    if (sandboxBin) {
      env.OPENSHELL_DOCKER_SUPERVISOR_BIN = sandboxBin;
    }
  }
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
  return startPackageManagedDockerDriverGateway({
    ...options,
    prepareOpenShellGatewayUserServiceEnv: () =>
      writeDockerGatewayDebEnvOverrideFile(() => gatewayEnv),
  });
}
