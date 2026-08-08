// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { hardenPodmanSocketDirectory, localPodmanEnvironment } from "../../adapters/podman";
import { ensureConfigDir } from "../../state/config-io";
import { isPortableExperimentalProfile, PORTABLE_LOCAL_REGISTRY } from "../docker-driver-platform";

const REGISTRY_CONTAINER = "nemoclaw-portable-registry";
const REGISTRY_LABEL = "com.nvidia.nemoclaw.portable=1";
const REGISTRY_IMAGE =
  "docker.io/library/registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const HOST_COMMAND_TIMEOUT_MS = 30_000;
const REGISTRY_COMMAND_TIMEOUT_MS = 300_000;
const MAX_STORAGE_CONFIG_BYTES = 128 * 1024;
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
const PORTABLE_GATEWAY_SYSTEMD_DROP_IN = `[Unit]
Requires=podman.socket
After=podman.socket
Before=podman-restart.service
`;

type SpawnResult = ReturnType<typeof spawnSync>;

interface PodmanStorageInfo {
  transientStore: boolean;
  driver: string;
  graphRoot: string;
  runRoot: string;
}

export interface PortableHostPreparationDeps {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  systemctl?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  podman?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  docker?: (args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult;
  hardenSocketDirectory?: (socketPath: string, uid: number) => void;
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

function readStorageConfig(filePath: string): string | null {
  let file;
  try {
    file = openRegularFileNoFollow(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return file.readUtf8(MAX_STORAGE_CONFIG_BYTES);
  } finally {
    file.close();
  }
}

function readPodmanStorageInfo(
  podman: NonNullable<PortableHostPreparationDeps["podman"]>,
  env: NodeJS.ProcessEnv,
): PodmanStorageInfo {
  const result = podman(
    [
      "info",
      "--format",
      "{{.Store.TransientStore}}|{{.Store.GraphDriverName}}|{{.Store.GraphRoot}}|{{.Store.RunRoot}}",
    ],
    env,
  );
  requireCommand(result, "Reading the rootless Podman storage mode");
  const [transientStore, driver, graphRoot, runRoot, ...extra] = String(result.stdout ?? "")
    .trim()
    .split("|")
    .map((value) => value.trim());
  if (
    extra.length > 0 ||
    (transientStore !== "true" && transientStore !== "false") ||
    !driver ||
    !path.isAbsolute(graphRoot ?? "") ||
    !path.isAbsolute(runRoot ?? "")
  ) {
    throw new Error("Reading the rootless Podman storage mode returned invalid data");
  }
  return {
    transientStore: transientStore === "true",
    driver,
    graphRoot: graphRoot!,
    runRoot: runRoot!,
  };
}

function persistentStorageConfig(
  source: string,
  info: PodmanStorageInfo,
  durableGraphRoot: string,
  durableImageStore: string,
): string {
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const storageStart = lines.findIndex((line) => /^\s*\[storage\]\s*(?:#.*)?$/u.test(line));
  if (storageStart < 0) {
    throw new Error("The active Podman storage configuration has no [storage] table");
  }
  const nextTable = lines.findIndex(
    (line, index) => index > storageStart && /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(line),
  );
  const storageEnd = nextTable < 0 ? lines.length : nextTable;
  const values: Readonly<Record<string, string>> = {
    driver: JSON.stringify(info.driver),
    graphroot: JSON.stringify(durableGraphRoot),
    imagestore: JSON.stringify(durableImageStore),
    runroot: JSON.stringify(info.runRoot),
    transient_store: "false",
  };
  const seen = new Set<string>();
  for (let index = storageStart + 1; index < storageEnd; index += 1) {
    const match = /^\s*(driver|graphroot|imagestore|runroot|transient_store)\s*=/u.exec(
      lines[index] ?? "",
    );
    if (!match) continue;
    const key = match[1]!;
    if (!Object.hasOwn(values, key)) continue;
    lines[index] = `${key} = ${values[key]}`;
    seen.add(key);
  }
  const missing = Object.keys(values)
    .filter((key) => !seen.has(key))
    .map((key) => `${key} = ${values[key]}`);
  lines.splice(storageStart + 1, 0, ...missing);
  return `${lines.join("\n").replace(/\n*$/u, "")}\n`;
}

function configuredImageStore(source: string): string | null {
  const storageStart = source.search(/^\s*\[storage\]\s*(?:#.*)?$/mu);
  if (storageStart < 0) return null;
  const storage = source.slice(storageStart);
  const nextTable = storage.slice(1).search(/^\s*\[[^\]]+\]\s*(?:#.*)?$/mu);
  const table = nextTable < 0 ? storage : storage.slice(0, nextTable + 1);
  const match = /^\s*imagestore\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/mu.exec(table);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]!);
    return typeof value === "string" && path.isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

function ensurePersistentPodmanStore(
  home: string,
  env: NodeJS.ProcessEnv,
  podman: NonNullable<PortableHostPreparationDeps["podman"]>,
): string | null {
  const before = readPodmanStorageInfo(podman, env);
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  const target = path.join(configHome, "containers", "storage.conf");
  const sourceCandidates = [
    env.CONTAINERS_STORAGE_CONF?.trim(),
    target,
    "/etc/containers/storage.conf",
    "/usr/share/containers/storage.conf",
  ].filter((candidate): candidate is string => Boolean(candidate));
  let source: string | null = null;
  for (const candidate of new Set(sourceCandidates)) {
    source = readStorageConfig(candidate);
    if (source !== null) break;
  }
  source ??= "[storage]\n";
  const currentImageStore = configuredImageStore(source) ?? before.graphRoot;
  const durableGraphRoot = path.join(home, ".nemoclaw", "portable-podman-v2");
  const durableImageStore =
    currentImageStore === "/kiosk-persistent" ||
    currentImageStore.startsWith("/kiosk-persistent/")
      ? "/kiosk-persistent/nemoclaw-images-v2"
      : path.join(home, ".nemoclaw", "portable-images-v2");
  if (
    !before.transientStore &&
    before.graphRoot === durableGraphRoot &&
    currentImageStore === durableImageStore
  ) {
    return null;
  }

  const existingContainers = podman(["ps", "-a", "--format", "{{.Names}}"], env);
  requireCommand(existingContainers, "Checking the current Podman container store");
  const names = String(existingContainers.stdout ?? "")
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length > 0) {
    throw new Error(
      `The portable profile cannot migrate a non-empty Podman store safely (containers: ${names.join(", ")}). Uninstall those containers, then rerun the portable installer.`,
    );
  }

  writePrivateConfig(
    target,
    persistentStorageConfig(source, before, durableGraphRoot, durableImageStore),
  );
  env.CONTAINERS_STORAGE_CONF = target;

  const after = readPodmanStorageInfo(podman, env);
  if (
    after.transientStore ||
    after.driver !== before.driver ||
    after.graphRoot !== durableGraphRoot ||
    after.runRoot !== before.runRoot
  ) {
    throw new Error(
      "The portable profile could not configure durable Podman metadata and isolated image storage",
    );
  }
  return target;
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
  writePrivateConfig(
    path.join(
      configHome,
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service.d",
      "portable.conf",
    ),
    PORTABLE_GATEWAY_SYSTEMD_DROP_IN,
  );
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
  const podman =
    deps.podman ??
    ((args, childEnv) =>
      spawnSync("podman", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: HOST_COMMAND_TIMEOUT_MS,
      }));
  const podmanEnv = localPodmanEnvironment(env);
  const storageConf = ensurePersistentPodmanStore(home, podmanEnv, podman);
  if (storageConf) {
    env.CONTAINERS_STORAGE_CONF = storageConf;
    podmanEnv.CONTAINERS_STORAGE_CONF = storageConf;
  }

  const systemctl =
    deps.systemctl ??
    ((args, childEnv) =>
      spawnSync("systemctl", [...args], {
        encoding: "utf-8",
        env: childEnv,
        timeout: HOST_COMMAND_TIMEOUT_MS,
      }));
  requireCommand(
    systemctl(["--user", "daemon-reload"], env),
    "Reloading the portable user services",
  );
  requireCommand(
    systemctl(
      [
        "--user",
        "set-environment",
        "NETAVARK_FW=iptables",
        `CONTAINERS_CONF=${env.CONTAINERS_CONF}`,
        ...(env.CONTAINERS_STORAGE_CONF
          ? [`CONTAINERS_STORAGE_CONF=${env.CONTAINERS_STORAGE_CONF}`]
          : []),
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
  requireCommand(
    systemctl(["--user", "enable", "podman-restart.service"], env),
    "Enabling rootless container restart after login",
  );

  const dockerHost = resolvePodmanDockerHost(
    podman(["info", "--format", "{{.Host.RemoteSocket.Path}}"], podmanEnv),
  );
  const socketPath = dockerHost.slice("unix://".length);
  (deps.hardenSocketDirectory ?? hardenPodmanSocketDirectory)(socketPath, Number(uid));
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
}

export const portableHostPreparationInternals = {
  REGISTRY_CONTAINER,
  REGISTRY_IMAGE,
  REGISTRY_FRAGMENT,
  PORTABLE_CONTAINERS_CONF,
  PORTABLE_GATEWAY_SYSTEMD_DROP_IN,
  resolvePodmanDockerHost,
};
