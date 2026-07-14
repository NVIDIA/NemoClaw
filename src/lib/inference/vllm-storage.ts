// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { dockerCapture } from "../adapters/docker";
import { buildVllmDockerEnv } from "./vllm-docker-env";

export const VLLM_STORAGE_OVERRIDE_ENV = "NEMOCLAW_IGNORE_VLLM_DISK_SPACE";

const GIB_BYTES = 1024n ** 3n;
const IMAGE_PULL_TEMP_HEADROOM_BYTES = 3n * GIB_BYTES;
const DEFAULT_CONTAINERD_ROOT = "/var/lib/containerd";
const DEFAULT_CONTAINERD_CONFIG = "/etc/containerd/config.toml";
const DEFAULT_DOCKER_SOCKET_PATHS = new Set(["/var/run/docker.sock", "/run/docker.sock"]);

interface StorageProbeDeps {
  dockerContext: string | undefined;
  dockerHost: string | undefined;
  dockerInfo: () => string;
  exists: (target: string) => boolean;
  platform: NodeJS.Platform;
  readFile: (target: string) => string;
  statfs: (target: string) => { bavail: bigint; bsize: bigint };
}

function defaultStorageProbeDeps(): StorageProbeDeps {
  const dockerEnv = buildVllmDockerEnv();
  return {
    dockerContext: dockerEnv.DOCKER_CONTEXT,
    dockerHost: dockerEnv.DOCKER_HOST,
    dockerInfo: () =>
      dockerCapture(["info", "--format", "{{json .}}"], {
        env: dockerEnv,
        ignoreError: true,
        timeout: 10_000,
      }),
    exists: fs.existsSync,
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

interface DockerInfoShape {
  ClientInfo?: { Context?: unknown };
  DockerRootDir?: unknown;
  Driver?: unknown;
  DriverStatus?: unknown;
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

function isDefaultDockerSocket(endpoint: string): boolean {
  const socketPath = endpoint.startsWith("unix://") ? endpoint.slice("unix://".length) : endpoint;
  return DEFAULT_DOCKER_SOCKET_PATHS.has(socketPath);
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

function localDockerHostProblem(info: DockerInfoShape, deps: StorageProbeDeps): string | null {
  if (deps.platform !== "linux") return `Docker runs behind a ${deps.platform} host boundary`;
  if (info.OSType !== "linux") return "Docker is not using a Linux engine";

  const dockerHost = deps.dockerHost?.trim() ?? "";
  // An explicit DOCKER_CONTEXT overrides DOCKER_HOST in the Docker CLI.
  const explicitContext = deps.dockerContext?.trim() ?? "";
  if (explicitContext) {
    if (explicitContext !== "default") {
      return `Docker uses a named context (${explicitContext}) whose host filesystem cannot be inspected`;
    }
    return null;
  }

  if (dockerHost) {
    if (isDefaultDockerSocket(dockerHost)) return null;
    if (dockerHost.startsWith("unix://") || path.isAbsolute(dockerHost)) {
      return `Docker uses a non-default socket (${dockerHost}) whose host filesystem cannot be inspected`;
    }
    return `Docker uses a remote endpoint (${dockerHost})`;
  }

  const reportedContext =
    typeof info.ClientInfo?.Context === "string" ? info.ClientInfo.Context.trim() : "";
  if (reportedContext && reportedContext !== "default") {
    return `Docker uses a named context (${reportedContext}) whose host filesystem cannot be inspected`;
  }
  return null;
}

export function resolveDockerStorageLocations(
  rawInfo: string,
  overrides: Partial<StorageProbeDeps> = {},
): { ok: true; locations: DockerStorageLocation[] } | { ok: false; reason: string } {
  const deps = { ...defaultStorageProbeDeps(), ...overrides };
  const info = parseDockerInfo(rawInfo);
  if (!info) return { ok: false, reason: "docker info did not return valid JSON" };
  const hostProblem = localDockerHostProblem(info, deps);
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
        "rootless Docker detected; managed vLLM cannot inspect the containerd image-store location",
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
  const resolved = resolveDockerStorageLocations(deps.dockerInfo(), deps);
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
