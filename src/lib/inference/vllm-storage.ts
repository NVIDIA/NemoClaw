// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { dockerCapture } from "../adapters/docker";
import { runCapture } from "../runner";
import { buildVllmDockerEnv } from "./vllm-docker-env";

export const VLLM_STORAGE_OVERRIDE_ENV = "NEMOCLAW_IGNORE_VLLM_DISK_SPACE";

const GIB_BYTES = 1024n ** 3n;
const IMAGE_PULL_TEMP_HEADROOM_BYTES = 3n * GIB_BYTES;
const MODEL_MINIMUM_HEADROOM_BYTES = 2n * GIB_BYTES;
const DEFAULT_CONTAINERD_ROOT = "/var/lib/containerd";
const DEFAULT_CONTAINERD_CONFIG = "/etc/containerd/config.toml";
const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_SOCKET_PEER_PROBE_TIMEOUT_MS = 5_000;
// SO_PEERCRED translates the daemon PID into the caller's PID namespace. A
// hidden peer therefore exposes the namespace-local PID 1 topology directly,
// while equal mountinfo snapshots prove that client-side statfs sees the same
// mount table as the process serving the selected Docker socket.
const DOCKER_SOCKET_PEER_PROBE = String.raw`
import socket
import struct
import sys

def read_mountinfo(target):
    with open(target, "rb") as stream:
        return stream.read()

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(2)
try:
    sock.connect(sys.argv[1])
    size = struct.calcsize("3i")
    peer_pid, _, _ = struct.unpack(
        "3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size)
    )
    if peer_pid <= 0:
        print("unknown")
    else:
        own_before = read_mountinfo("/proc/self/mountinfo")
        peer = read_mountinfo(f"/proc/{peer_pid}/mountinfo")
        own_after = read_mountinfo("/proc/self/mountinfo")
        if own_before != own_after:
            print("unknown")
        else:
            print("shared" if own_before == peer else "different")
except (OSError, ValueError):
    print("unknown")
finally:
    sock.close()
`;

interface StorageProbeDeps {
  clientContainerized: boolean;
  dockerContext: string | undefined;
  dockerHost: string | undefined;
  dockerInfo: () => string;
  dockerReadBind: (image: string, sourcePath: string) => string;
  dockerSocketPeerSharesMountNamespace: () => boolean | null;
  exists: (target: string) => boolean;
  osRelease: string;
  platform: NodeJS.Platform;
  readFile: (target: string) => string;
  statfs: (target: string) => { bavail: bigint; bsize: bigint };
}

function clientLooksContainerized(): boolean {
  if (String(process.env.container ?? "").trim()) return true;
  if (
    fs.existsSync("/.dockerenv") ||
    fs.existsSync("/run/.containerenv") ||
    fs.existsSync("/run/systemd/container")
  ) {
    return true;
  }
  try {
    return /(?:^|[/:.-])(?:docker|kubepods|containerd|libpod|lxc)(?:$|[/:.-])/im.test(
      fs.readFileSync("/proc/self/cgroup", "utf8"),
    );
  } catch {
    return false;
  }
}

export function dockerSocketPeerSharesMountNamespace(
  socketPath: string,
  capture: (
    command: readonly string[],
    options: { ignoreError: true; timeout: number },
  ) => string = runCapture,
  platform: NodeJS.Platform = process.platform,
): boolean | null {
  if (platform !== "linux") return null;
  const result = capture(["python3", "-I", "-c", DOCKER_SOCKET_PEER_PROBE, socketPath], {
    ignoreError: true,
    timeout: DOCKER_SOCKET_PEER_PROBE_TIMEOUT_MS,
  }).trim();
  if (result === "shared") return true;
  if (result === "different") return false;
  return null;
}

function defaultStorageProbeDeps(): StorageProbeDeps {
  const dockerEnv = buildVllmDockerEnv();
  return {
    clientContainerized: clientLooksContainerized(),
    dockerContext: dockerEnv.DOCKER_CONTEXT,
    dockerHost: dockerEnv.DOCKER_HOST,
    dockerInfo: () =>
      dockerCapture(["info", "--format", "{{json .}}"], {
        env: dockerEnv,
        ignoreError: true,
        timeout: 10_000,
      }),
    dockerReadBind: (image, sourcePath) =>
      dockerCapture(
        [
          "run",
          "--rm",
          "--network=none",
          "--pull=never",
          "--entrypoint",
          "/bin/cat",
          "--mount",
          `type=bind,src=${sourcePath},dst=/nemoclaw-storage-sentinel,readonly`,
          image,
          "/nemoclaw-storage-sentinel",
        ],
        {
          env: dockerEnv,
          ignoreError: true,
          timeout: 30_000,
        },
      ),
    dockerSocketPeerSharesMountNamespace: () => {
      const endpoint = dockerEnv.DOCKER_HOST?.trim() ?? "";
      const socketPath = endpoint.startsWith("unix://")
        ? endpoint.slice("unix://".length)
        : path.isAbsolute(endpoint)
          ? endpoint
          : endpoint
            ? ""
            : DEFAULT_DOCKER_SOCKET;
      return socketPath ? dockerSocketPeerSharesMountNamespace(socketPath) : null;
    },
    exists: fs.existsSync,
    osRelease: os.release(),
    platform: process.platform,
    readFile: (target) => fs.readFileSync(target, "utf8"),
    statfs: (target) => fs.statfsSync(target, { bigint: true }),
  };
}

export interface StorageCapacity {
  availableBytes: bigint;
  path: string;
  source: string;
}

export type StorageProbeResult =
  | { ok: true; capacity: StorageCapacity }
  | { ok: false; reason: string; path?: string; source?: string };

export type DockerHostLocalityResult = { ok: true } | { ok: false; reason: string };

interface DockerInfoShape {
  ClientInfo?: { Context?: unknown };
  DockerRootDir?: unknown;
  Driver?: unknown;
  DriverStatus?: unknown;
  Name?: unknown;
  OperatingSystem?: unknown;
  OSType?: unknown;
  SecurityOptions?: unknown;
}

interface DockerStorageLocation {
  path: string;
  source: string;
}

function positiveBytes(value: number, label: string): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite byte count`);
  }
  return BigInt(Math.ceil(value));
}

/**
 * Containerd retains compressed content alongside an unpacked snapshot, and
 * pull staging can briefly coexist with both. Three times the advertised
 * compressed size plus a fixed staging allowance is intentionally
 * conservative for the pinned multi-gigabyte NGC images.
 */
export function imageStorageRequirementBytes(downloadSizeBytes: number): bigint {
  return (
    positiveBytes(downloadSizeBytes, "vLLM image download size") * 3n +
    IMAGE_PULL_TEMP_HEADROOM_BYTES
  );
}

/**
 * Hugging Face downloads need the published repository size plus temporary
 * write headroom. A local cache cannot prove which blobs a mutable remote
 * revision will reuse, so the estimate deliberately does not subtract it.
 */
export function modelStorageRequirementBytes(downloadSizeBytes: number): bigint {
  const downloadBytes = positiveBytes(downloadSizeBytes, "vLLM model download size");
  const tenPercent = (downloadBytes + 9n) / 10n;
  const headroom =
    tenPercent > MODEL_MINIMUM_HEADROOM_BYTES ? tenPercent : MODEL_MINIMUM_HEADROOM_BYTES;
  return downloadBytes + headroom;
}

export function formatStorageBytes(bytes: bigint): string {
  const roundedTenths = (bytes * 10n + GIB_BYTES / 2n) / GIB_BYTES;
  const whole = roundedTenths / 10n;
  const fraction = roundedTenths % 10n;
  return fraction === 0n ? `${String(whole)} GiB` : `${String(whole)}.${String(fraction)} GiB`;
}

function parseDockerInfo(raw: string): DockerInfoShape | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as DockerInfoShape) : null;
  } catch {
    return null;
  }
}

function isContainerdImageStore(info: DockerInfoShape): boolean {
  return (
    Array.isArray(info.DriverStatus) &&
    info.DriverStatus.some(
      (entry) =>
        Array.isArray(entry) &&
        entry[0] === "driver-type" &&
        entry[1] === "io.containerd.snapshotter.v1",
    )
  );
}

function absoluteString(value: unknown): string | null {
  return typeof value === "string" && path.isAbsolute(value) ? value : null;
}

type ContainerdRootResult = { ok: true; root: string } | { ok: false; reason: string };

function containerdRootFromConfig(deps: StorageProbeDeps): ContainerdRootResult {
  if (!deps.exists(DEFAULT_CONTAINERD_CONFIG)) {
    return { ok: true, root: DEFAULT_CONTAINERD_ROOT };
  }
  try {
    const parsed = parseToml(deps.readFile(DEFAULT_CONTAINERD_CONFIG)) as Record<string, unknown>;
    if (parsed.imports !== undefined) {
      if (!Array.isArray(parsed.imports)) {
        return { ok: false, reason: "containerd config declares malformed imports" };
      }
      if (parsed.imports.length > 0) {
        return {
          ok: false,
          reason: "containerd config imports other files that can override its image-store root",
        };
      }
    }
    const root = absoluteString(parsed.root);
    if (root) return { ok: true, root };
    if (parsed.root !== undefined) {
      return {
        ok: false,
        reason: "containerd config does not declare an absolute image-store root",
      };
    }
    return { ok: true, root: DEFAULT_CONTAINERD_ROOT };
  } catch (err) {
    return {
      ok: false,
      reason: `could not read ${DEFAULT_CONTAINERD_CONFIG}: ${(err as Error).message}`,
    };
  }
}

function nativeDockerHostProblem(info: DockerInfoShape, deps: StorageProbeDeps): string | null {
  if (deps.platform !== "linux") return `Docker runs behind a ${deps.platform} host boundary`;
  if (/microsoft|wsl/i.test(deps.osRelease)) return "Docker runs behind a WSL host boundary";
  if (deps.clientContainerized) {
    return "Docker client runs inside a container, so daemon bind-mount storage cannot be verified";
  }
  if (info.OSType !== "linux") return "Docker is not using a Linux engine";

  const product = `${String(info.Name ?? "")} ${String(info.OperatingSystem ?? "")}`;
  if (/docker desktop|colima|podman/i.test(product)) {
    return "Docker runs inside a VM or compatibility layer";
  }

  const dockerHost = deps.dockerHost?.trim() ?? "";
  // DOCKER_HOST takes precedence over DOCKER_CONTEXT in the Docker CLI.
  const explicitContext = dockerHost ? "" : deps.dockerContext?.trim();
  const reportedContext =
    typeof info.ClientInfo?.Context === "string" ? info.ClientInfo.Context.trim() : "";
  const context = explicitContext || reportedContext;
  if (!context) return "docker info did not report the effective Docker context";
  if (context !== "default") {
    return `Docker uses a named context (${context}) whose host filesystem cannot be verified`;
  }

  const endpoint = dockerHost;
  if (endpoint) {
    const localSocket = endpoint.startsWith("unix://") || path.isAbsolute(endpoint);
    if (!localSocket) return `Docker uses a remote endpoint (${endpoint})`;
    if (endpoint !== DEFAULT_DOCKER_SOCKET && endpoint !== `unix://${DEFAULT_DOCKER_SOCKET}`) {
      return `Docker uses a non-default socket (${endpoint}) whose daemon host filesystem cannot be verified`;
    }
  }

  const sharesPeerMountNamespace = deps.dockerSocketPeerSharesMountNamespace();
  if (sharesPeerMountNamespace === false) {
    return "Docker client and socket peer use different mount namespaces, so daemon filesystem identity cannot be verified";
  }
  if (sharesPeerMountNamespace === null) {
    return "Docker socket peer PID or mount namespace could not be verified";
  }
  return null;
}

export function probeDockerHostLocality(
  overrides: Partial<StorageProbeDeps> = {},
): DockerHostLocalityResult {
  const deps = { ...defaultStorageProbeDeps(), ...overrides };
  const info = parseDockerInfo(deps.dockerInfo());
  if (!info) return { ok: false, reason: "docker info did not return valid JSON" };
  const hostProblem = nativeDockerHostProblem(info, deps);
  return hostProblem ? { ok: false, reason: hostProblem } : { ok: true };
}

export function resolveDockerStorageLocations(
  rawInfo: string,
  overrides: Partial<StorageProbeDeps> = {},
): { ok: true; locations: DockerStorageLocation[] } | { ok: false; reason: string } {
  const deps = { ...defaultStorageProbeDeps(), ...overrides };
  const info = parseDockerInfo(rawInfo);
  if (!info) return { ok: false, reason: "docker info did not return valid JSON" };
  const hostProblem = nativeDockerHostProblem(info, deps);
  if (hostProblem) return { ok: false, reason: hostProblem };

  const dockerRoot = absoluteString(info.DockerRootDir);
  if (!dockerRoot) {
    return { ok: false, reason: "docker info did not report an absolute DockerRootDir" };
  }
  if (!isContainerdImageStore(info)) {
    const driver = typeof info.Driver === "string" ? info.Driver : "";
    const classicDrivers = new Set([
      "aufs",
      "btrfs",
      "devicemapper",
      "fuse-overlayfs",
      "overlay2",
      "vfs",
      "zfs",
    ]);
    if (!classicDrivers.has(driver)) {
      return {
        ok: false,
        reason: driver
          ? `docker reported ambiguous image-storage driver ${driver}`
          : "docker info did not report a recognized image-storage driver",
      };
    }
    return {
      ok: true,
      locations: [{ path: dockerRoot, source: "Docker root directory" }],
    };
  }

  if (
    Array.isArray(info.SecurityOptions) &&
    info.SecurityOptions.some((entry) => String(entry).includes("rootless"))
  ) {
    return {
      ok: false,
      reason:
        "rootless Docker detected; managed vLLM cannot verify the containerd image-store location",
    };
  }
  const containerd = containerdRootFromConfig(deps);
  if (!containerd.ok) return containerd;
  return {
    ok: true,
    locations: [
      { path: containerd.root, source: "containerd image store" },
      { path: dockerRoot, source: "Docker pull staging" },
    ],
  };
}

function capacityForLocation(
  location: DockerStorageLocation,
  statfs: StorageProbeDeps["statfs"],
): StorageProbeResult {
  try {
    const stats = statfs(location.path);
    const availableBytes = stats.bavail * stats.bsize;
    if (availableBytes < 0n) throw new Error("filesystem reported negative available space");
    return { ok: true, capacity: { ...location, availableBytes } };
  } catch (err) {
    return {
      ok: false,
      reason: `could not inspect ${location.path}: ${(err as Error).message}`,
      path: location.path,
      source: location.source,
    };
  }
}

export function probeDockerStorage(overrides: Partial<StorageProbeDeps> = {}): StorageProbeResult {
  const deps = { ...defaultStorageProbeDeps(), ...overrides };
  const rawInfo = deps.dockerInfo();
  const resolved = resolveDockerStorageLocations(rawInfo, deps);
  if (!resolved.ok) return resolved;

  let limiting: StorageCapacity | null = null;
  for (const location of resolved.locations) {
    const result = capacityForLocation(location, deps.statfs);
    if (!result.ok) return result;
    if (!limiting || result.capacity.availableBytes < limiting.availableBytes) {
      limiting = result.capacity;
    }
  }
  return limiting
    ? { ok: true, capacity: limiting }
    : { ok: false, reason: "docker info did not report a usable image-storage path" };
}

function nearestExistingPath(target: string, exists: (candidate: string) => boolean): string {
  let candidate = path.resolve(target);
  while (!exists(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

export function probeDockerBindIdentity(
  cacheDir: string,
  image: string,
  overrides: Partial<StorageProbeDeps> = {},
): DockerHostLocalityResult {
  const deps = { ...defaultStorageProbeDeps(), ...overrides };
  const info = parseDockerInfo(deps.dockerInfo());
  if (!info) return { ok: false, reason: "docker info did not return valid JSON" };
  const hostProblem = nativeDockerHostProblem(info, deps);
  if (hostProblem) return { ok: false, reason: hostProblem };

  const target = nearestExistingPath(cacheDir, deps.exists);
  const token = `nemoclaw-storage-token:${randomUUID()}`;
  const sentinelPath = path.join(target, `.nemoclaw-storage-probe-${randomUUID()}`);
  try {
    fs.writeFileSync(sentinelPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (deps.dockerReadBind(image, sentinelPath) !== token) {
      return {
        ok: false,
        reason:
          "Docker daemon could not read the client storage sentinel; bind-mount filesystem identity cannot be verified",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `could not verify Docker bind-mount filesystem identity at ${target}: ${(err as Error).message}`,
    };
  } finally {
    fs.rmSync(sentinelPath, { force: true });
  }
}

export function probeModelCacheStorage(
  cacheDir: string,
  overrides: Partial<StorageProbeDeps> = {},
): StorageProbeResult {
  const deps = { ...defaultStorageProbeDeps(), ...overrides };
  const target = nearestExistingPath(cacheDir, deps.exists);
  return capacityForLocation(
    {
      path: target,
      source: target === path.resolve(cacheDir) ? "model cache" : "model cache filesystem",
    },
    deps.statfs,
  );
}
