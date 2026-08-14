// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
  hardenPodmanSocketDirectory,
  localPodmanEnvironment,
  type PodmanSocketAuthority,
} from "../../adapters/podman";
import { ensureConfigDir } from "../../state/config-io";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { isPortableExperimentalProfile, PORTABLE_LOCAL_REGISTRY } from "../docker-driver-platform";
import { qualifyPodmanHost } from "../runtime-provider/podman-preflight";

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
const PORTABLE_CONFIG_RELATIVE_FILES = [
  "containers/registries.conf.d/99-nemoclaw-portable.conf",
  "containers/containers.conf.d/99-nemoclaw-portable.conf",
  "nemoclaw/portable/containers.conf",
] as const;

type SpawnResult = ReturnType<typeof spawnSync>;

export interface PortableHostPreparationDeps {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  systemctl?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  podman?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  docker?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  hardenSocketDirectory?: (socketPath: string, uid: number) => void;
  captureSocketAuthority?: (socketPath: string, uid: number) => PodmanSocketAuthority;
  assertSocketAuthority?: (authority: PodmanSocketAuthority) => void;
  qualifyPodman?: (authority: PodmanSocketAuthority) => void;
  validateConfigAuthority?: (input: {
    homeDir: string;
    configHome: string;
    runtimeDir: string;
    socketPath: string | null;
    uid: number;
  }) => void;
}

export interface PortableHostPreparationResult {
  readonly authority: CheckpointPortableRuntimeAuthority;
  readonly socketAuthority: PodmanSocketAuthority | null;
  readonly containersConf: string;
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

/**
 * The portable profile points DOCKER_HOST at the rootless Podman socket but still
 * drives the managed registry — and the rest of onboarding's runtime preflight —
 * through the `docker` CLI. On a genuinely Podman-only host that CLI is absent,
 * so the first docker spawn fails with a cryptic `spawnSync docker ENOENT`
 * instead of an actionable message (#8453). Detect that up front and tell the
 * user to install the docker-compatible shim the profile expects.
 */
function requireDockerCompatibleCli(
  docker: NonNullable<PortableHostPreparationDeps["docker"]>,
  env: NodeJS.ProcessEnv,
): void {
  const probe = docker(["--version"], env);
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return;
  throw new Error(
    "The portable experimental profile drives Podman through a docker-compatible CLI, but no " +
      "`docker` command was found on PATH. On a Podman-only host, install the podman-docker shim " +
      "(Debian/Ubuntu: `sudo apt install podman-docker`; Fedora: `sudo dnf install podman-docker`), " +
      "then rerun `nemoclaw onboard --experimental-profile portable`.",
  );
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

function assertSocketInsideRuntime(runtimeDir: string, socketPath: string): void {
  const relativeSocket = path.relative(runtimeDir, socketPath);
  if (
    relativeSocket === "" ||
    path.isAbsolute(relativeSocket) ||
    relativeSocket === ".." ||
    relativeSocket.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Portable Podman socket is outside the current user runtime directory.");
  }
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

function writePortableRuntimeConfig(configHome: string): string {
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

function canonicalAbsolute(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (resolved !== value || !path.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error(`Portable runtime ${label} must be a normalized absolute path.`);
  }
  return resolved;
}

function validateOwnedConfigAuthority(input: {
  homeDir: string;
  configHome: string;
  runtimeDir: string;
  socketPath: string | null;
  uid: number;
}): void {
  const { homeDir, configHome, runtimeDir, socketPath, uid } = input;
  const assertDirectory = (directory: string, owner: number | null): fs.Stats => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Portable runtime path '${directory}' is not a real directory.`);
    }
    if (owner !== null && stat.uid !== owner) {
      throw new Error(`Portable runtime path '${directory}' is not owned by the current user.`);
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`Portable runtime path '${directory}' has unsafe write permissions.`);
    }
    return stat;
  };
  const assertSystemAncestors = (directory: string): void => {
    for (let current = path.dirname(directory); ; current = path.dirname(current)) {
      assertDirectory(current, null);
      const parent = path.dirname(current);
      if (parent === current) break;
    }
  };
  const assertOwnedRoot = (directory: string): void => {
    assertDirectory(directory, uid);
    assertSystemAncestors(directory);
  };
  const assertOwnedDescendants = (root: string, target: string): void => {
    const relative = path.relative(root, target);
    if (
      relative === "" ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      if (relative === "") return;
      throw new Error(`Portable runtime path '${target}' is outside '${root}'.`);
    }
    let current = root;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      try {
        assertDirectory(current, uid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  };
  const assertConfigRoot = (): void => {
    try {
      assertOwnedRoot(configHome);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let anchor = path.dirname(configHome);
    while (true) {
      try {
        assertOwnedRoot(anchor);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = path.dirname(anchor);
      if (parent === anchor) break;
      anchor = parent;
    }
    throw new Error("Portable runtime config root has no validated owned ancestor.");
  };
  const assertExistingConfigFile = (filePath: string): void => {
    try {
      const stat = fs.lstatSync(filePath);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.uid !== uid ||
        stat.nlink !== 1 ||
        (stat.mode & 0o022) !== 0
      ) {
        throw new Error(`Portable runtime config '${filePath}' is not a safe owned file.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  assertOwnedRoot(homeDir);
  assertOwnedRoot(runtimeDir);
  assertConfigRoot();
  for (const relative of PORTABLE_CONFIG_RELATIVE_FILES) {
    const filePath = path.join(configHome, relative);
    assertOwnedDescendants(configHome, path.dirname(filePath));
    assertExistingConfigFile(filePath);
  }
  if (socketPath) assertOwnedDescendants(runtimeDir, path.dirname(socketPath));
}

function ensureRegistryContainer(
  env: NodeJS.ProcessEnv,
  docker: NonNullable<PortableHostPreparationDeps["docker"]>,
): void {
  const inspection = docker(
    [
      "inspect",
      "--format",
      '{{ index .Config.Labels "com.nvidia.nemoclaw.portable" }} {{.State.Running}}',
      REGISTRY_CONTAINER,
    ],
    env,
  );
  if (inspection.error) {
    requireCommand(inspection, "Inspecting the managed portable registry");
  }
  const exists = inspection.status === 0;
  const [owner, running] = String(inspection.stdout ?? "")
    .trim()
    .split(/\s+/u);
  if (exists && owner !== "1") {
    throw new Error(
      `Refusing to replace existing unmanaged container '${REGISTRY_CONTAINER}'. Rename or remove it and retry.`,
    );
  }
  if (exists && running === "true") return;
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
  expectedAuthority?: CheckpointPortableRuntimeAuthority | null,
): PortableHostPreparationResult | null {
  if (!isPortableExperimentalProfile(env)) return null;
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("The portable experimental profile requires Linux.");
  }
  const uid = deps.uid ?? process.geteuid?.() ?? process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) {
    throw new Error("The portable experimental profile could not resolve the current user ID.");
  }
  const currentHome = canonicalAbsolute(deps.home ?? os.userInfo().homedir, "home directory");
  const home = canonicalAbsolute(expectedAuthority?.homeDir ?? currentHome, "home directory");
  const configHome = path.join(home, ".config");
  const runtimeDir = canonicalAbsolute(
    expectedAuthority?.runtimeDir ?? path.join("/run/user", String(uid)),
    "user runtime directory",
  );
  const expectedSocketPath = expectedAuthority
    ? canonicalAbsolute(expectedAuthority.socketPath, "socket path")
    : null;
  if (expectedAuthority) {
    if (expectedAuthority.configHome !== configHome) {
      throw new Error(
        "Portable runtime authority configuration root does not match the current OS user home.",
      );
    }
    if (
      expectedAuthority.uid !== Number(uid) ||
      expectedAuthority.kind !== "podman" ||
      expectedAuthority.ownership !== "current-user" ||
      home !== currentHome ||
      runtimeDir !== path.join("/run/user", String(uid))
    ) {
      throw new Error(
        "Portable runtime authority does not match the current user or runtime kind.",
      );
    }
  }
  const validateConfigAuthority = deps.validateConfigAuthority ?? validateOwnedConfigAuthority;
  validateConfigAuthority({
    homeDir: home,
    configHome,
    runtimeDir,
    socketPath: expectedSocketPath,
    uid: Number(uid),
  });
  if (expectedSocketPath) {
    try {
      (
        deps.captureSocketAuthority ??
        ((socketPath, ownerUid) => capturePodmanSocketAuthority(socketPath, { uid: ownerUid }))
      )(expectedSocketPath, Number(uid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const podman =
    deps.podman ??
    ((args, childEnv) =>
      spawnSync("podman", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: HOST_COMMAND_TIMEOUT_MS,
      }));
  const discoverSocket = (childEnv: NodeJS.ProcessEnv): string =>
    resolvePodmanDockerHost(
      podman(["info", "--format", "{{.Host.RemoteSocket.Path}}"], childEnv),
    ).slice("unix://".length);
  const admissionSocketPath = discoverSocket(localPodmanEnvironment(env));
  assertSocketInsideRuntime(runtimeDir, admissionSocketPath);
  if (expectedAuthority && admissionSocketPath !== expectedAuthority.socketPath) {
    throw new Error("Portable Podman socket path does not match the onboarding checkpoint.");
  }

  env.NETAVARK_FW = "iptables";
  env.CONTAINERS_CONF = writePortableRuntimeConfig(configHome);

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

  const podmanEnv = localPodmanEnvironment(env);
  const socketPath = discoverSocket(podmanEnv);
  const dockerHost = `unix://${socketPath}`;
  if (expectedAuthority && socketPath !== expectedAuthority.socketPath) {
    throw new Error("Portable Podman socket path does not match the onboarding checkpoint.");
  }
  assertSocketInsideRuntime(runtimeDir, socketPath);
  (deps.hardenSocketDirectory ?? hardenPodmanSocketDirectory)(socketPath, Number(uid));
  const socketAuthority = deps.captureSocketAuthority
    ? deps.captureSocketAuthority(socketPath, Number(uid))
    : deps.hardenSocketDirectory
      ? null
      : capturePodmanSocketAuthority(socketPath, { uid: Number(uid) });
  if (socketAuthority) {
    (
      deps.qualifyPodman ??
      ((authority) => {
        qualifyPodmanHost(
          createPodmanContainerEngine({ operation: "host-doctor", socketAuthority: authority }),
        );
      })
    )(socketAuthority);
  }
  env.DOCKER_HOST = dockerHost;
  podmanEnv.DOCKER_HOST = dockerHost;

  const docker =
    deps.docker ??
    ((args, childEnv) =>
      dockerSpawnSync(args, {
        encoding: "utf-8",
        env: childEnv,
        timeout: REGISTRY_COMMAND_TIMEOUT_MS,
      }));
  requireDockerCompatibleCli(docker, podmanEnv);
  ensureRegistryContainer(podmanEnv, docker);
  if (socketAuthority) {
    (deps.assertSocketAuthority ?? assertPodmanSocketAuthority)(socketAuthority);
  }
  return {
    authority: {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid: Number(uid),
      homeDir: home,
      configHome,
      runtimeDir,
      socketPath,
    },
    socketAuthority,
    containersConf: env.CONTAINERS_CONF,
  };
}

export const portableHostPreparationInternals = {
  REGISTRY_CONTAINER,
  REGISTRY_IMAGE,
  REGISTRY_FRAGMENT,
  PORTABLE_CONTAINERS_CONF,
  validateOwnedConfigAuthority,
  resolvePodmanDockerHost,
};
