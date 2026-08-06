// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { ensureConfigDir } from "../../state/config-io";
import { isPortableExperimentalProfile, PORTABLE_LOCAL_REGISTRY } from "../docker-driver-platform";

const REGISTRY_CONTAINER = "nemoclaw-portable-registry";
const REGISTRY_LABEL = "com.nvidia.nemoclaw.portable=1";
const REGISTRY_IMAGE =
  "docker.io/library/registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const HOST_COMMAND_TIMEOUT_MS = 30_000;
const REGISTRY_COMMAND_TIMEOUT_MS = 300_000;
const REGISTRY_FRAGMENT = `[[registry]]
location = "${PORTABLE_LOCAL_REGISTRY}"
insecure = true
`;
const PORTABLE_CONTAINERS_CONF = `[network]
default_rootless_network_cmd = "pasta"
firewall_driver = "iptables"

[engine]
env = ["NETAVARK_FW=iptables"]
`;

type SpawnResult = ReturnType<typeof spawnSync>;

export interface PortableHostPreparationDeps {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  systemctl?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  podman?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  docker?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
}

function commandDetail(result: SpawnResult): string {
  if (result.error) return result.error.message;
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  return stderr || stdout || `exit ${String(result.status)}`;
}

function requireCommand(result: SpawnResult, description: string): void {
  if (result.status === 0) return;
  throw new Error(`${description} failed: ${commandDetail(result)}`);
}

function resolvePodmanDockerHost(result: SpawnResult): string {
  requireCommand(result, "Resolving the rootless Podman API socket");
  const socket = String(result.stdout ?? "").trim();
  if (socket.startsWith("unix:///")) return socket;
  if (socket.startsWith("/")) return `unix://${socket}`;
  throw new Error(
    `Resolving the rootless Podman API socket failed: invalid socket path '${socket || "empty"}'`,
  );
}

function writePrivateConfig(filePath: string, value: string): void {
  ensureConfigDir(path.dirname(filePath));
  let file;
  try {
    file = openRegularFileNoFollow(filePath, { writable: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    file = openRegularFileNoFollow(filePath, {
      create: true,
      mode: 0o600,
      writable: true,
    });
  }
  try {
    file.replaceUtf8(value, 0o600);
  } finally {
    file.close();
  }
}

function writePortableRuntimeConfig(home: string, env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  writePrivateConfig(
    path.join(configHome, "containers", "registries.conf.d", "99-nemoclaw-portable.conf"),
    REGISTRY_FRAGMENT,
  );
  // Podman reads `containers.conf.d` drop-ins from its own default search path, so this drop-in
  // keeps `firewall_driver` in effect for a shell that starts without CONTAINERS_CONF. The
  // `systemctl --user set-environment` values below last only until the user manager restarts.
  writePrivateConfig(
    path.join(configHome, "containers", "containers.conf.d", "99-nemoclaw-portable.conf"),
    PORTABLE_CONTAINERS_CONF,
  );
  // The OpenShell gateway service and sandbox prebuild read this file through CONTAINERS_CONF.
  const containersConf = path.join(configHome, "nemoclaw", "portable", "containers.conf");
  writePrivateConfig(containersConf, PORTABLE_CONTAINERS_CONF);
  return containersConf;
}

function ensureRegistryContainer(
  env: NodeJS.ProcessEnv,
  docker: NonNullable<PortableHostPreparationDeps["docker"]>,
): void {
  const inspection = docker(
    [
      "inspect",
      "--format",
      '{{ index .Config.Labels "com.nvidia.nemoclaw.portable" }}',
      REGISTRY_CONTAINER,
    ],
    env,
  );
  if (inspection.error) {
    requireCommand(inspection, "Inspecting the managed portable registry");
  }
  const exists = inspection.status === 0;
  if (exists && String(inspection.stdout ?? "").trim() !== "1") {
    throw new Error(
      `Refusing to replace existing unmanaged container '${REGISTRY_CONTAINER}'. Rename or remove it and retry.`,
    );
  }
  if (exists) {
    requireCommand(
      docker(["rm", "-f", REGISTRY_CONTAINER], env),
      "Removing the previous managed portable registry",
    );
  }
  requireCommand(
    docker(
      [
        "run",
        "-d",
        "--name",
        REGISTRY_CONTAINER,
        "--label",
        REGISTRY_LABEL,
        "-p",
        "127.0.0.1:5000:5000",
        "--restart=always",
        REGISTRY_IMAGE,
      ],
      env,
    ),
    "Starting the managed portable registry",
  );
}

/** Prepare the user-scoped rootless runtime required by the hidden portable profile. */
export function preparePortableExperimentalHost(
  env: NodeJS.ProcessEnv = process.env,
  deps: PortableHostPreparationDeps = {},
): void {
  if (!isPortableExperimentalProfile(env)) return;
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("The portable experimental profile requires Linux.");
  }
  const uid = deps.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) {
    throw new Error("The portable experimental profile could not resolve the current user ID.");
  }
  const home = deps.home ?? env.HOME ?? os.homedir();
  env.NETAVARK_FW = "iptables";
  env.CONTAINERS_CONF = writePortableRuntimeConfig(home, env);

  const systemctl =
    deps.systemctl ??
    ((args, childEnv) =>
      spawnSync("systemctl", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: HOST_COMMAND_TIMEOUT_MS,
      }));
  requireCommand(
    systemctl(
      [
        "--user",
        "set-environment",
        "NETAVARK_FW=iptables",
        `CONTAINERS_CONF=${env.CONTAINERS_CONF}`,
      ],
      env,
    ),
    "Configuring the rootless container service environment",
  );
  requireCommand(
    systemctl(["--user", "try-restart", "podman.service"], env),
    "Refreshing the rootless container service",
  );
  requireCommand(
    systemctl(["--user", "enable", "--now", "podman.socket"], env),
    "Starting the rootless container socket",
  );

  const podman =
    deps.podman ??
    ((args, childEnv) =>
      spawnSync("podman", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: HOST_COMMAND_TIMEOUT_MS,
      }));
  env.DOCKER_HOST = resolvePodmanDockerHost(
    podman(["info", "--format", "{{.Host.RemoteSocket.Path}}"], env),
  );

  const docker =
    deps.docker ??
    ((args, childEnv) =>
      dockerSpawnSync(args, {
        encoding: "utf-8",
        env: childEnv,
        timeout: REGISTRY_COMMAND_TIMEOUT_MS,
      }));
  ensureRegistryContainer(env, docker);
}

export const portableHostPreparationInternals = {
  REGISTRY_CONTAINER,
  REGISTRY_IMAGE,
  REGISTRY_FRAGMENT,
  PORTABLE_CONTAINERS_CONF,
  resolvePodmanDockerHost,
};
