// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";

import {
  buildContainerizedDockerDriverGatewayLaunch,
  logContainerizedDockerDriverGatewayLaunch,
  prepareContainerizedDockerDriverGatewayLaunch,
  shouldUseContainerizedGateway,
} from "./docker-driver-gateway-compat";
import {
  buildDockerDriverGatewayConfigToml,
  prepareDockerDriverGatewayConfigEnv,
} from "./docker-driver-gateway-config";
import {
  assertDockerDriverGatewayAuthConfigSafe,
  assertDockerDriverGatewayBindAddressSafe,
} from "./docker-driver-gateway-env";
import {
  buildDockerDriverGatewayLocalTlsEnv,
  ensureDockerDriverGatewayLocalTlsBundle,
} from "./docker-driver-gateway-local-tls";

export {
  compareDottedVersions,
  getDockerSocketPath,
  getHostGlibcVersion,
  maxDottedVersion,
  parseGlibcVersionsFromBinaryText,
  requiredGlibcVersionsForBinary,
  shouldUseContainerizedGateway,
} from "./docker-driver-gateway-compat";
export { buildDockerDriverGatewayConfigToml };

export type DockerDriverGatewayLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: "host" | "container";
  processGatewayBin: string | null;
  reason?: string;
  containerName?: string;
};

export type DockerDriverGatewayRuntimeIdentity = {
  launch: DockerDriverGatewayLaunch | null;
  desiredEnv: Record<string, string>;
  driftGatewayBin: string | null;
  identityGatewayBin: string | null;
};

export function openDockerDriverGatewayLog(
  logPath: string,
  options: { exitOnFailure?: boolean } = {},
): number {
  const appendNoFollow =
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
  try {
    return fs.openSync(logPath, appendNoFollow, 0o600);
  } catch (error) {
    console.error(
      `  Failed to open OpenShell Docker-driver gateway log '${logPath}': ${String(error)}`,
    );
    if (options.exitOnFailure) process.exit(1);
    throw error;
  }
}

export function spawnDockerDriverGateway(
  launch: DockerDriverGatewayLaunch,
  logFd: number,
): ChildProcess {
  try {
    return spawn(launch.command, launch.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: launch.env,
    });
  } finally {
    fs.closeSync(logFd);
  }
}

type BuildGatewayLaunchOptions = {
  gatewayBin: string;
  gatewayEnv: Record<string, string>;
  stateDir: string;
  sandboxBin?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hostGlibcVersion?: string | null;
  requiredGlibcVersions?: string[];
  ensureLocalTlsBundle?: boolean;
  // Default compatibility container name when NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_CONTAINER_NAME
  // is unset. Callers pass a per-gateway-port name so a second sandbox's compat
  // container (and its pre-launch `docker rm`) cannot tear down the first
  // sandbox's gateway container (#4422).
  compatContainerName?: string;
};

function buildGatewayProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  gatewayEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv, ...gatewayEnv };
  if (!("OPENSHELL_DISABLE_GATEWAY_AUTH" in gatewayEnv)) {
    delete env.OPENSHELL_DISABLE_GATEWAY_AUTH;
  }
  return env;
}

export function buildDockerDriverGatewayLaunch(
  options: BuildGatewayLaunchOptions,
): DockerDriverGatewayLaunch {
  const gatewayEnv = { ...options.gatewayEnv };
  if (options.ensureLocalTlsBundle) {
    ensureDockerDriverGatewayLocalTlsBundle({
      gatewayBin: options.gatewayBin,
      stateDir: options.stateDir,
    });
  }
  if (!gatewayEnv.OPENSHELL_LOCAL_TLS_DIR) {
    Object.assign(gatewayEnv, buildDockerDriverGatewayLocalTlsEnv(options.stateDir));
  }
  if (options.sandboxBin && !gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN) {
    gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN = options.sandboxBin;
  }
  assertDockerDriverGatewayBindAddressSafe(gatewayEnv);
  prepareDockerDriverGatewayConfigEnv(
    gatewayEnv,
    options.stateDir,
    options.sandboxBin || gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN,
  );
  assertDockerDriverGatewayAuthConfigSafe(gatewayEnv);
  const baseEnv = options.env ?? process.env;
  const compat = shouldUseContainerizedGateway(options);
  if (!compat.useContainer) {
    const env = buildGatewayProcessEnv(baseEnv, gatewayEnv);
    return {
      command: options.gatewayBin,
      args: [],
      env,
      mode: "host",
      processGatewayBin: options.gatewayBin,
    };
  }

  return buildContainerizedDockerDriverGatewayLaunch({
    gatewayBin: options.gatewayBin,
    gatewayEnv,
    stateDir: options.stateDir,
    sandboxBin: options.sandboxBin,
    compatContainerName: options.compatContainerName,
    baseEnv,
    reason: compat.reason,
  });
}

export function prepareDockerDriverGatewayLaunch(launch: DockerDriverGatewayLaunch): void {
  prepareContainerizedDockerDriverGatewayLaunch(launch);
}

export function buildDockerDriverGatewayRuntimeIdentity(
  options: BuildGatewayLaunchOptions,
): DockerDriverGatewayRuntimeIdentity {
  const launch = buildDockerDriverGatewayLaunch(options);
  const desiredEnv =
    launch.mode === "container"
      ? {
          ...options.gatewayEnv,
          ...Object.fromEntries(
            Object.entries(launch.env).filter(
              ([key, val]) => key in options.gatewayEnv && typeof val === "string",
            ) as [string, string][],
          ),
          ...(typeof launch.env.OPENSHELL_GATEWAY_CONFIG === "string"
            ? { OPENSHELL_GATEWAY_CONFIG: launch.env.OPENSHELL_GATEWAY_CONFIG }
            : {}),
        }
      : {
          ...options.gatewayEnv,
          ...(typeof launch.env.OPENSHELL_GATEWAY_CONFIG === "string"
            ? { OPENSHELL_GATEWAY_CONFIG: launch.env.OPENSHELL_GATEWAY_CONFIG }
            : {}),
        };
  return {
    launch,
    desiredEnv,
    driftGatewayBin: launch.processGatewayBin,
    identityGatewayBin: launch.processGatewayBin || options.gatewayBin,
  };
}

/**
 * Resolve the gateway binary used for the `/proc/<pid>/exe` drift comparison.
 *
 * In containerized Docker-compat mode the gateway runs as a host-side
 * `docker run ... /opt/nemoclaw/openshell-gateway` parent, so the parent
 * process's executable is `/usr/bin/docker`, not the host openshell-gateway
 * binary. `buildDockerDriverGatewayRuntimeIdentity()` encodes that with
 * `driftGatewayBin: null` to mean "skip the executable check". Callers must
 * preserve that deliberate `null` — coalescing it back to the host binary with
 * `??` makes the drift check compare `/usr/bin/docker` against the host
 * gateway path and falsely mark a healthy compat gateway as stale (#4520).
 */
export function resolveDriftGatewayBin(
  runtimeIdentity: DockerDriverGatewayRuntimeIdentity | null,
  gatewayBin: string | null,
): string | null {
  return runtimeIdentity ? runtimeIdentity.driftGatewayBin : gatewayBin;
}

export function prepareAndLogDockerDriverGatewayLaunch(
  launch: DockerDriverGatewayLaunch,
  log: (message: string) => void = console.log,
  warn: (message: string) => void = console.warn,
): void {
  logContainerizedDockerDriverGatewayLaunch(launch, log, warn);
}
