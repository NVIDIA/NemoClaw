// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
const REGISTRY_FRAGMENT = `[[registry]]
location = "${PORTABLE_LOCAL_REGISTRY}"
insecure = true
`;

type SpawnResult = ReturnType<typeof spawnSync>;

export interface PortableHostPreparationDeps {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  systemctl?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
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

function writeRegistryFragment(home: string, env: NodeJS.ProcessEnv): void {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  const fragmentDir = path.join(configHome, "containers", "registries.conf.d");
  const fragmentPath = path.join(fragmentDir, "99-nemoclaw-portable.conf");
  ensureConfigDir(fragmentDir);
  let file;
  try {
    file = openRegularFileNoFollow(fragmentPath, { writable: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    file = openRegularFileNoFollow(fragmentPath, {
      create: true,
      mode: 0o600,
      writable: true,
    });
  }
  try {
    file.replaceUtf8(REGISTRY_FRAGMENT, 0o600);
  } finally {
    file.close();
  }
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
  env.DOCKER_HOST = `unix:///run/user/${String(uid)}/podman/podman.sock`;
  writeRegistryFragment(home, env);

  const systemctl =
    deps.systemctl ??
    ((args, childEnv) => spawnSync("systemctl", [...args], { encoding: "utf-8", env: childEnv }));
  requireCommand(
    systemctl(["--user", "set-environment", "NETAVARK_FW=iptables"], env),
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

  const docker =
    deps.docker ??
    ((args, childEnv) => dockerSpawnSync(args, { encoding: "utf-8", env: childEnv }));
  ensureRegistryContainer(env, docker);
}

export const portableHostPreparationInternals = {
  REGISTRY_CONTAINER,
  REGISTRY_IMAGE,
  REGISTRY_FRAGMENT,
};
