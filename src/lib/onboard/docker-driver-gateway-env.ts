// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerCapture, dockerRun } from "../adapters/docker/run";
import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import {
  DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
  parseDockerNetworkIpamEntries,
} from "./experimental/docker-network-authority";
import {
  GATEWAY_BIND_ADDRESS,
  getGatewayConnectHost,
  getGatewayHttpsEndpoint,
  WILDCARD_GATEWAY_BIND_ADDRESS,
} from "../core/gateway-address";
import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../core/ports";
import { isSupportedGatewayDockerHost } from "../domain/docker-host";
import {
  DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
  prepareDockerDriverGatewayConfigEnv,
} from "./docker-driver-gateway-config";
import { buildDockerDriverGatewayLocalTlsEnv } from "./docker-driver-gateway-local-tls";
import {
  getOpenShellGatewayManagedServiceLogCommand,
  getOpenShellUserConfigHome,
  hasOpenShellGatewayUserService,
  OpenShellGatewayServiceEnvironmentError,
  type PackageManagedDockerDriverGatewayOptions,
  startPackageManagedDockerDriverGateway,
  stopOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";
import {
  isPortableExperimentalProfile,
  PORTABLE_HOST_GATEWAY_IP,
  resolveDockerDriverNetworkName,
} from "./docker-driver-platform";
import type {
  RuntimeProviderGatewayHostRuntime,
  RuntimeProviderGatewaySurface,
} from "./runtime-provider/contract";
import { resolveConfiguredRuntimeProvider } from "./runtime-provider/selection";

export { getGatewayHttpsEndpoint, startPackageManagedDockerDriverGateway };

/** Return the configured gateway port used by Docker-driver runtime helpers. */
export function getConfiguredGatewayPort(): number {
  return GATEWAY_PORT;
}

export const DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS = [
  "CONTAINERS_CONF",
  "DOCKER_HOST",
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
  "OPENSHELL_PODMAN_SOCKET",
  "OPENSHELL_GATEWAY_CONFIG",
  "OPENSHELL_VM_DRIVER_STATE_DIR",
  "OPENSHELL_DRIVER_DIR",
  "NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS",
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
  "NETAVARK_FW",
] as const;

export interface BuildDockerDriverGatewayEnvOptions {
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
  gatewayPort?: number;
  stateDir: string;
  dockerNetworkName?: string;
  podmanSocketPath?: string;
  gatewayHostRuntime?: RuntimeProviderGatewayHostRuntime;
  getDockerSupervisorImage: () => string;
  resolveSandboxBin: () => string | null;
  enableBindMounts?: boolean;
}

function preparePortableGatewayHostRuntime(
  socketPath?: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeProviderGatewayHostRuntime {
  const run = (args: readonly string[], timeoutMs: number) => {
    const result = dockerRun([...args], {
      timeout: timeoutMs,
      ignoreError: true,
      suppressOutput: true,
    });
    const error = result.error as NodeJS.ErrnoException | undefined;
    return {
      status: result.status ?? null,
      signal: result.signal,
      error: error?.message,
      errorCode: error?.code ?? null,
      timedOut: error?.code === "ETIMEDOUT",
      stderr: result.stderr,
      stdout: result.stdout,
    };
  };
  const inspectNetwork = (networkName: string) => {
    const raw = dockerCapture(
      ["network", "inspect", "--format", DOCKER_NETWORK_IPAM_INSPECT_FORMAT, networkName],
      { ignoreError: true },
    );
    return (parseDockerNetworkIpamEntries(raw) ?? []).find(
      ({ gatewayIp }) => gatewayIp && !gatewayIp.includes(":"),
    );
  };
  return {
    providerId: "docker",
    openShellDriver: "podman",
    bindAddress: WILDCARD_GATEWAY_BIND_ADDRESS,
    grpcHost: PORTABLE_HOST_GATEWAY_IP,
    sshGatewayHost: getGatewayConnectHost(),
    portCheckHost: WILDCARD_GATEWAY_BIND_ADDRESS,
    socketPath: socketPath ?? null,
    requiredServerIpSans: [PORTABLE_HOST_GATEWAY_IP],
    sandboxHostAddress: PORTABLE_HOST_GATEWAY_IP,
    usesHostGatewayRoute: true,
    // The portable compatibility profile historically discovers OpenShell's
    // Docker-compatible labels. Keep that independent from native Podman.
    resourceOwnership: {
      label: "openshell.ai/managed-by",
      value: "openshell",
    },
    gatewayConfig: {
      sandboxNamespace: "omitted",
      hostGatewayIp: PORTABLE_HOST_GATEWAY_IP,
      includeSupervisorBin: false,
      processOwnership: "scoped-namespace",
    },
    network: {
      sandboxSourceCidrs: () => {
        const network = inspectNetwork(resolveDockerDriverNetworkName());
        return network?.subnet ? [network.subnet] : [];
      },
      inspect: inspectNetwork,
      usesHostGatewayRoute: () => {
        if (platform !== "linux") return true;
        const info = dockerCapture(
          ["info", "--format", "{{.OperatingSystem}}\n{{range .Labels}}{{.}}\n{{end}}"],
          { ignoreError: true },
        );
        return /Docker Desktop|com\.docker\.desktop\./iu.test(info);
      },
      run,
      ensureProbeImageCached: (image) => {
        const inspect = run(["image", "inspect", image], 10_000);
        if (inspect.status === 0) return { ok: true, alreadyCached: true };
        if (inspect.status === null || inspect.errorCode) {
          return {
            ok: false,
            reason: "inspect_unavailable",
            details: inspect.error ?? String(inspect.stderr ?? "").trim(),
          };
        }
        const pull = run(["pull", image], 120_000);
        if (pull.status === 0) return { ok: true, alreadyCached: false };
        return {
          ok: false,
          reason: pull.timedOut ? "pull_timeout" : "pull_failed",
          details: pull.error ?? String(pull.stderr ?? "").trim(),
        };
      },
    },
  };
}

export interface PrepareConfiguredGatewayHostRuntimeOptions {
  architecture?: NodeJS.Architecture;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  socketPath?: string;
}

type SupportedRuntimeProviderGateway = Extract<RuntimeProviderGatewaySurface, { supported: true }>;

function requireConfiguredRuntimeProviderGateway(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  environment: NodeJS.ProcessEnv,
): SupportedRuntimeProviderGateway {
  const gateway = resolveConfiguredRuntimeProvider(platform, architecture, environment).gateway;
  if (!gateway.supported) {
    throw new Error("The selected runtime provider does not support a host-managed gateway.");
  }
  return gateway;
}

export function prepareConfiguredGatewayHostRuntime(
  options: PrepareConfiguredGatewayHostRuntimeOptions = {},
): RuntimeProviderGatewayHostRuntime {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (isPortableExperimentalProfile(environment)) {
    return preparePortableGatewayHostRuntime(options.socketPath, platform);
  }
  return requireConfiguredRuntimeProviderGateway(
    platform,
    architecture,
    environment,
  ).prepareHostRuntime({
    environment,
    platform,
    socketPath: options.socketPath,
  });
}

export function configuredRuntimeProviderOwnsHostReadiness(
  options: PrepareConfiguredGatewayHostRuntimeOptions = {},
): boolean {
  const environment = options.environment ?? process.env;
  if (isPortableExperimentalProfile(environment)) return false;
  const platform = options.platform ?? process.platform;
  const gateway = requireConfiguredRuntimeProviderGateway(
    platform,
    options.architecture ?? process.arch,
    environment,
  );
  return gateway.ownsHostReadiness;
}

export type PackageManagedDockerDriverGatewayWithEnvOverrideOptions = Omit<
  PackageManagedDockerDriverGatewayOptions,
  "prepareOpenShellGatewayUserServiceEnv"
> & {
  env?: NodeJS.ProcessEnv;
  gatewayEnv: Record<string, string>;
  home?: string;
};

export function getGatewayPortCheckOptions(env: NodeJS.ProcessEnv = process.env): { host: string } {
  return {
    host: prepareConfiguredGatewayHostRuntime({ environment: env }).portCheckHost,
  };
}

export function getGatewayStartNetworkEnv(
  gatewayPort: number = GATEWAY_PORT,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const runtime = prepareConfiguredGatewayHostRuntime({ environment: env, platform });
  return {
    OPENSHELL_BIND_ADDRESS: runtime.bindAddress,
    OPENSHELL_SERVER_PORT: String(gatewayPort),
    OPENSHELL_SSH_GATEWAY_HOST: runtime.sshGatewayHost,
    OPENSHELL_SSH_GATEWAY_PORT: String(gatewayPort),
  };
}

export function assertDockerDriverGatewayBindAddressSafe(
  gatewayEnv: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (gatewayEnv.OPENSHELL_BIND_ADDRESS !== WILDCARD_GATEWAY_BIND_ADDRESS) return;
  const selectedRuntime = prepareConfiguredGatewayHostRuntime({ environment, platform });
  if (
    selectedRuntime.sandboxHostAddress !== null &&
    gatewayEnv.OPENSHELL_GRPC_ENDPOINT ===
      `https://${selectedRuntime.grpcHost}:${gatewayEnv.OPENSHELL_SERVER_PORT}` &&
    gatewayEnv.OPENSHELL_SSH_GATEWAY_HOST === selectedRuntime.sshGatewayHost
  ) {
    return;
  }
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

export function assertDockerDriverGatewayAuthConfigSafe(
  gatewayEnv: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertDockerDriverGatewayBindAddressSafe(gatewayEnv, environment);
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
  architecture = process.arch,
  gatewayPort = GATEWAY_PORT,
  stateDir,
  dockerNetworkName,
  podmanSocketPath,
  gatewayHostRuntime,
  getDockerSupervisorImage,
  resolveSandboxBin,
  enableBindMounts = false,
}: BuildDockerDriverGatewayEnvOptions): Record<string, string> {
  const portable = isPortableExperimentalProfile();
  const runtime =
    gatewayHostRuntime ??
    prepareConfiguredGatewayHostRuntime({
      architecture,
      platform,
      socketPath: podmanSocketPath,
    });
  const resolvedDockerNetworkName = dockerNetworkName ?? resolveDockerDriverNetworkName();
  const env: Record<string, string> = {
    NEMOCLAW_RUNTIME_PROVIDER_ID: runtime.providerId,
    OPENSHELL_DRIVERS: runtime.openShellDriver,
    OPENSHELL_BIND_ADDRESS: runtime.bindAddress,
    OPENSHELL_SERVER_PORT: String(gatewayPort),
    OPENSHELL_SSH_GATEWAY_HOST: runtime.sshGatewayHost,
    OPENSHELL_SSH_GATEWAY_PORT: String(gatewayPort),
    ...buildDockerDriverGatewayLocalTlsEnv(stateDir),
    OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
    OPENSHELL_GRPC_ENDPOINT: `https://${runtime.grpcHost}:${gatewayPort}`,
    OPENSHELL_DOCKER_NETWORK_NAME: resolvedDockerNetworkName,
    OPENSHELL_DOCKER_SUPERVISOR_IMAGE: getDockerSupervisorImage(),
  };
  if (enableBindMounts) env.NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS = "1";
  if (portable) env.NETAVARK_FW = "iptables";
  if (runtime.socketPath !== null) {
    const rawSocketPath = String(runtime.socketPath);
    const normalizedSocketPath = rawSocketPath.trim();
    if (
      normalizedSocketPath === "" ||
      rawSocketPath !== normalizedSocketPath ||
      /[\0\r\n]/u.test(rawSocketPath) ||
      !path.isAbsolute(normalizedSocketPath) ||
      path.normalize(normalizedSocketPath) !== normalizedSocketPath
    ) {
      throw new Error("OpenShell Podman gateway socket must be a safe normalized absolute path.");
    }
    env.OPENSHELL_PODMAN_SOCKET = normalizedSocketPath;
  }
  if (portable) {
    const containersConf = process.env.CONTAINERS_CONF?.trim();
    if (containersConf) env.CONTAINERS_CONF = containersConf;
  }
  if (platform === "linux") {
    const sandboxBin = resolveSandboxBin();
    if (sandboxBin) {
      env.OPENSHELL_DOCKER_SUPERVISOR_BIN = sandboxBin;
    }
  }
  prepareDockerDriverGatewayConfigEnv(env, stateDir, env.OPENSHELL_DOCKER_SUPERVISOR_BIN, {
    // The installer sets this only after a strict pre-upgrade backup. OpenShell
    // 0.0.44 had a database but no authenticated config or JWT identity, so
    // prepared recovery may safely attach the first scoped identity to it.
    allowOpenShell0044PreAuthDatabase:
      process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE === "1",
    gatewayRuntime: runtime,
  });
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
  if (key === "DOCKER_HOST") {
    const dockerHost = normalizePackageServiceDockerHost(value);
    if (!dockerHost) throw new Error("Invalid empty DOCKER_HOST for the OpenShell gateway service");
    return `${key}='${dockerHost}'`;
  }
  return `${key}=${value}`;
}

function normalizePackageServiceDockerHost(value: string | undefined): string | undefined {
  const candidate = String(value || "").trim();
  if (!candidate) return undefined;
  if (isSupportedGatewayDockerHost(value)) {
    return candidate;
  }
  throw new Error(
    "Invalid DOCKER_HOST for the OpenShell gateway service; only safely serializable absolute unix:// Docker sockets are supported.",
  );
}

function errnoCode(error: unknown): string | null {
  return error instanceof Error && "code" in error ? String(error.code) : null;
}

function openDockerGatewayEnvFile(envFile: string) {
  try {
    return openRegularFileNoFollow(envFile, { writable: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      try {
        return openRegularFileNoFollow(envFile, {
          create: true,
          mode: 0o600,
          writable: true,
        });
      } catch (createError) {
        if (errnoCode(createError) !== "EEXIST" && errnoCode(createError) !== "ELOOP") {
          throw createError;
        }
        throw new Error(
          `Refusing to write OpenShell gateway env file because it changed during validation: ${envFile}`,
        );
      }
    }
    if (errnoCode(error) === "ELOOP") {
      throw new Error(`Refusing to write symlinked OpenShell gateway env file: ${envFile}`);
    }
    throw error;
  }
}

function writeDockerGatewayDebEnvOverrideFile(
  getOverride: () => Record<string, string>,
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): void {
  const override = getOverride();
  const env = opts.env ?? process.env;
  const home = opts.home ?? opts.env?.HOME ?? os.homedir();
  const envDir = path.join(getOpenShellUserConfigHome(home, env), "openshell");
  const envFile = path.join(envDir, "gateway.env");
  fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(envDir, 0o700);
  const file = openDockerGatewayEnvFile(envFile);
  try {
    const existing = file.readUtf8();
    file.replaceUtf8(buildDockerGatewayDebEnvFile(existing, override), 0o600);
  } finally {
    file.close();
  }
}

export function writeDockerGatewayDebEnvOverride(
  getOverride: () => Record<string, string>,
  opts: Parameters<typeof hasOpenShellGatewayUserService>[0] = {},
): boolean {
  if (!hasOpenShellGatewayUserService(opts)) return false;
  writeDockerGatewayDebEnvOverrideFile(getOverride, opts);
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

export function startPackageManagedDockerDriverGatewayWithEnvOverride(
  optionsWithEnv: PackageManagedDockerDriverGatewayWithEnvOverrideOptions,
): Promise<boolean> {
  const { env: _env, gatewayEnv, home, ...options } = optionsWithEnv;
  const env = optionsWithEnv.env ?? process.env;
  const gatewayPort = Number(gatewayEnv.OPENSHELL_SERVER_PORT ?? GATEWAY_PORT);
  if (gatewayPort !== DEFAULT_GATEWAY_PORT) return Promise.resolve(false);
  assertDockerDriverGatewayAuthConfigSafe(gatewayEnv, env);
  const effectiveHome = home ?? optionsWithEnv.env?.HOME ?? os.homedir();
  return startPackageManagedDockerDriverGateway({
    ...options,
    hasOpenShellGatewayUserService:
      options.hasOpenShellGatewayUserService ??
      (() => hasOpenShellGatewayUserService({ env, home: effectiveHome })),
    managedServiceLogCommand:
      options.managedServiceLogCommand ?? getOpenShellGatewayManagedServiceLogCommand(),
    prepareOpenShellGatewayUserServiceEnv: () => {
      try {
        const serviceGatewayEnv = { ...gatewayEnv };
        delete serviceGatewayEnv.DOCKER_HOST;
        const dockerHost = normalizePackageServiceDockerHost(env.DOCKER_HOST);
        if (dockerHost) serviceGatewayEnv.DOCKER_HOST = dockerHost;
        writeDockerGatewayDebEnvOverrideFile(() => serviceGatewayEnv, {
          env,
          home: effectiveHome,
        });
      } catch (error) {
        throw new OpenShellGatewayServiceEnvironmentError(error);
      }
    },
    stopOpenShellGatewayUserService:
      options.stopOpenShellGatewayUserService ??
      (() => stopOpenShellGatewayUserService({ env, home: effectiveHome })),
  });
}
