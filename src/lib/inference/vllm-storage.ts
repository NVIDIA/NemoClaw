// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { dockerCapture } from "../adapters/docker";
import { buildVllmDockerEnv } from "./vllm-docker-env";

const GIB_BYTES = 1024n ** 3n;
const GB_BYTES = 1000n ** 3n;
const DOWNLOAD_TEMP_HEADROOM_BYTES = 3n * GIB_BYTES;
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
  stat: (target: string) => { dev: bigint | number };
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
    stat: (target) => fs.statSync(target, { bigint: true }),
    statfs: (target) => fs.statfsSync(target, { bigint: true }),
  };
}

export interface StorageCapacity {
  availableBytes: bigint;
  filesystemId?: string;
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
    positiveBytes(downloadSizeBytes, "vLLM image download size") * 3n + DOWNLOAD_TEMP_HEADROOM_BYTES
  );
}

/**
 * Hugging Face downloads stream into the target cache before atomically
 * promoting the completed blobs. Reserve the pinned snapshot size plus the
 * same fixed staging allowance used by the managed-image guard.
 */
export function modelStorageRequirementBytes(downloadSizeBytes: number): bigint {
  return (
    positiveBytes(downloadSizeBytes, "vLLM model download size") + DOWNLOAD_TEMP_HEADROOM_BYTES
  );
}

export function formatStorageBytes(bytes: bigint): string {
  const roundedTenths = (bytes * 10n + GIB_BYTES / 2n) / GIB_BYTES;
  const whole = roundedTenths / 10n;
  const fraction = roundedTenths % 10n;
  return fraction === 0n ? `${String(whole)} GiB` : `${String(whole)}.${String(fraction)} GiB`;
}

export function formatStorageDecimalBytes(bytes: bigint): string {
  const roundedThousandths = (bytes * 1000n + GB_BYTES / 2n) / GB_BYTES;
  const whole = roundedThousandths / 1000n;
  const fraction = String(roundedThousandths % 1000n)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return fraction ? `${String(whole)}.${fraction} GB` : `${String(whole)} GB`;
}

export interface ManagedVllmStorageEstimate {
  imageCompressedBytes: bigint;
  imageUnpackedBytes: bigint;
  modelBytes: bigint;
  modelStagingBytes: bigint;
  totalBytes: bigint;
  writableAllowanceBytes: bigint;
}

export function managedVllmStorageEstimateBytes({
  imageCompressedBytes,
  imageUnpackedBytes,
  includeImage,
  includeModel = true,
  modelBytes,
  writableAllowanceBytes,
}: {
  imageCompressedBytes: number;
  imageUnpackedBytes: number;
  includeImage: boolean;
  includeModel?: boolean;
  modelBytes: number;
  writableAllowanceBytes: number;
}): ManagedVllmStorageEstimate {
  const imageCompressed = includeImage
    ? positiveBytes(imageCompressedBytes, "vLLM image compressed size")
    : 0n;
  const imageUnpacked = includeImage
    ? positiveBytes(imageUnpackedBytes, "vLLM image unpacked size")
    : 0n;
  const model = includeModel ? positiveBytes(modelBytes, "vLLM model file size") : 0n;
  const modelStaging = includeModel ? modelStorageRequirementBytes(modelBytes) - model : 0n;
  const writable = includeModel
    ? positiveBytes(writableAllowanceBytes, "vLLM writable allowance")
    : 0n;
  return {
    imageCompressedBytes: imageCompressed,
    imageUnpackedBytes: imageUnpacked,
    modelBytes: model,
    modelStagingBytes: modelStaging,
    totalBytes: imageCompressed + imageUnpacked + model + modelStaging + writable,
    writableAllowanceBytes: writable,
  };
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
  stat: StorageProbeDeps["stat"],
  statfs: StorageProbeDeps["statfs"],
  probePath = location.path,
): StorageProbeResult {
  try {
    const stats = statfs(probePath);
    const availableBytes = stats.bavail * stats.bsize;
    if (availableBytes < 0n) throw new Error("filesystem reported negative available space");
    let filesystemId: string | undefined;
    try {
      filesystemId = String(stat(probePath).dev);
    } catch {
      filesystemId = undefined;
    }
    return {
      ok: true,
      capacity: {
        ...location,
        availableBytes,
        ...(filesystemId ? { filesystemId } : {}),
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `could not inspect ${probePath}: ${(err as Error).message}`,
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
    const result = capacityForLocation(location, deps.stat, deps.statfs);
    if (!result.ok) return result;
    if (!limiting || result.capacity.availableBytes < limiting.availableBytes) {
      limiting = result.capacity;
    }
  }
  return limiting
    ? { ok: true, capacity: limiting }
    : { ok: false, reason: "docker info did not report a usable image-storage path" };
}

interface HostStorageProbeDeps {
  exists: (target: string) => boolean;
  stat: (target: string) => { dev: bigint | number };
  statfs: (target: string) => { bavail: bigint; bsize: bigint };
}

interface DirectorySizeEntry {
  kind: "directory" | "file" | "symlink" | "other";
  name: string;
}

interface WritableTreeDeps {
  canWrite: (target: string, directory: boolean) => boolean;
  list: (target: string) => DirectorySizeEntry[];
  exists: (target: string) => boolean;
}

function defaultWritableTreeDeps(): WritableTreeDeps {
  return {
    canWrite: (target, directory) => {
      try {
        const mode = fs.constants.R_OK | fs.constants.W_OK | (directory ? fs.constants.X_OK : 0);
        fs.accessSync(target, mode);
        return true;
      } catch {
        return false;
      }
    },
    list: defaultDirectorySizeDeps().list,
    exists: fs.existsSync,
  };
}

/**
 * Return the first path in a cache tree that the current host user cannot
 * read and write. Directories additionally require search permission. This
 * catches legacy cache trees created by a root-run Docker downloader before
 * a host-UID downloader is started. Symlinks are not followed because their
 * targets are checked separately under the cache's blobs directory.
 */
export function findUnwritableTreePath(
  targetPath: string,
  overrides: Partial<WritableTreeDeps> = {},
  options: { recursive?: boolean } = {},
): string | null {
  const deps = { ...defaultWritableTreeDeps(), ...overrides };
  const recursive = options.recursive ?? true;
  const pending = [targetPath];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (!deps.canWrite(directory, true)) return directory;
    if (!recursive) continue;
    let entries: DirectorySizeEntry[];
    try {
      entries = deps.list(directory);
    } catch {
      return directory;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.kind === "directory") {
        pending.push(entryPath);
      } else if (entry.kind === "file" && !deps.canWrite(entryPath, false)) {
        return entryPath;
      }
    }
  }
  return null;
}

/**
 * Return the first path that would block a managed onboard for one model,
 * scoped to what onboard actually writes: the cache root, its `hub`
 * directory, and the target model's own cache subtree (including the
 * download lock directory `hub/.locks/<model>` the Hugging Face client
 * creates alongside it). Unrelated sibling model directories and lock
 * subtrees are not walked, so a root-owned artifact left by a previous
 * model's download cannot block onboarding a different model.
 */
export function findUnwritableModelCachePath(
  cacheDir: string,
  modelCacheDir: string | null,
  overrides: Partial<WritableTreeDeps> = {},
): string | null {
  const deps = { ...defaultWritableTreeDeps(), ...overrides };
  if (!deps.canWrite(cacheDir, true)) return cacheDir;
  const hubDir = path.join(cacheDir, "hub");
  if (!deps.exists(hubDir)) return null;
  if (!deps.canWrite(hubDir, true)) return hubDir;
  if (modelCacheDir === null) return null;
  if (deps.exists(modelCacheDir)) {
    const blockedPath = findUnwritableTreePath(modelCacheDir, deps);
    if (blockedPath) return blockedPath;
  }
  const locksDir = path.join(hubDir, ".locks");
  const lockDir = path.join(locksDir, path.basename(modelCacheDir));
  if (deps.exists(lockDir)) {
    return findUnwritableTreePath(lockDir, deps);
  }
  if (deps.exists(locksDir) && !deps.canWrite(locksDir, true)) return locksDir;
  return null;
}

interface DirectorySizeDeps {
  exists: (target: string) => boolean;
  list: (target: string) => DirectorySizeEntry[];
  statFileSize: (target: string) => bigint | null;
}

function defaultDirectorySizeDeps(): DirectorySizeDeps {
  return {
    exists: fs.existsSync,
    list: (target) =>
      fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
        kind: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
        name: entry.name,
      })),
    statFileSize: (target) => {
      const stat = fs.statSync(target, { bigint: true });
      return stat.isFile() ? stat.size : null;
    },
  };
}

/**
 * Return the logical bytes represented by regular files in a directory tree.
 * Symlinks are followed only when they resolve to files; directory symlinks
 * are never traversed, avoiding cycles. Any unreadable or malformed tree
 * returns zero so callers conservatively plan for a full download.
 */
export function measureDirectorySizeBytes(
  targetPath: string,
  overrides: Partial<DirectorySizeDeps> = {},
): bigint {
  const deps = { ...defaultDirectorySizeDeps(), ...overrides };
  if (!deps.exists(targetPath)) return 0n;
  function walk(directory: string): bigint {
    let total = 0n;
    for (const entry of deps.list(directory)) {
      const entryPath = path.join(directory, entry.name);
      if (entry.kind === "directory") {
        total += walk(entryPath);
      } else if (entry.kind === "file" || entry.kind === "symlink") {
        total += deps.statFileSize(entryPath) ?? 0n;
      }
    }
    return total;
  }
  try {
    return walk(targetPath);
  } catch {
    return 0n;
  }
}

/**
 * Measure the filesystem that will contain a host cache path. On a fresh
 * install the cache directory may not exist yet, so walk to its nearest
 * existing ancestor without creating anything before the capacity decision.
 */
export function probeHostStorage(
  targetPath: string,
  source: string,
  overrides: Partial<HostStorageProbeDeps> = {},
): StorageProbeResult {
  if (!path.isAbsolute(targetPath)) {
    return {
      ok: false,
      reason: `storage path is not absolute: ${targetPath}`,
      path: targetPath,
      source,
    };
  }
  const deps: HostStorageProbeDeps = {
    exists: fs.existsSync,
    stat: (target) => fs.statSync(target, { bigint: true }),
    statfs: (target) => fs.statfsSync(target, { bigint: true }),
    ...overrides,
  };
  let probePath = path.normalize(targetPath);
  while (!deps.exists(probePath)) {
    const parent = path.dirname(probePath);
    if (parent === probePath) break;
    probePath = parent;
  }
  return capacityForLocation({ path: targetPath, source }, deps.stat, deps.statfs, probePath);
}
