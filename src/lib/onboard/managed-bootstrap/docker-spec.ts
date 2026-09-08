// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { DockerContainerInspect } from "../docker-gpu-patch-types";

const CONFIG_KEYS = new Set([
  "ArgsEscaped",
  "AttachStderr",
  "AttachStdin",
  "AttachStdout",
  "Cmd",
  "Domainname",
  "Entrypoint",
  "Env",
  "ExposedPorts",
  "Healthcheck",
  "Hostname",
  "Image",
  "Labels",
  "MacAddress",
  "NetworkDisabled",
  "OnBuild",
  "OpenStdin",
  "Shell",
  "StdinOnce",
  "StopSignal",
  "StopTimeout",
  "Tty",
  "User",
  "Volumes",
  "WorkingDir",
]);

const HOST_CONFIG_KEYS = new Set([
  "Annotations",
  "AutoRemove",
  "Binds",
  "BlkioDeviceReadBps",
  "BlkioDeviceReadIOps",
  "BlkioDeviceWriteBps",
  "BlkioDeviceWriteIOps",
  "BlkioWeight",
  "BlkioWeightDevice",
  "CapAdd",
  "CapDrop",
  "Cgroup",
  "CgroupParent",
  "CgroupnsMode",
  "ConsoleSize",
  "ContainerIDFile",
  "CpuCount",
  "CpuPercent",
  "CpuPeriod",
  "CpuQuota",
  "CpuRealtimePeriod",
  "CpuRealtimeRuntime",
  "CpuShares",
  "CpusetCpus",
  "CpusetMems",
  "DeviceCgroupRules",
  "DeviceRequests",
  "Devices",
  "Dns",
  "DnsOptions",
  "DnsSearch",
  "ExtraHosts",
  "GroupAdd",
  "IOMaximumBandwidth",
  "IOMaximumIOps",
  "Init",
  "IpcMode",
  "Isolation",
  "Links",
  "LogConfig",
  "MaskedPaths",
  "Memory",
  "MemoryReservation",
  "MemorySwap",
  "MemorySwappiness",
  "Mounts",
  "NanoCpus",
  "NetworkMode",
  "OomKillDisable",
  "OomScoreAdj",
  "PidMode",
  "PidsLimit",
  "PortBindings",
  "Privileged",
  "PublishAllPorts",
  "ReadonlyPaths",
  "ReadonlyRootfs",
  "RestartPolicy",
  "Runtime",
  "SecurityOpt",
  "ShmSize",
  "StorageOpt",
  "Sysctls",
  "Tmpfs",
  "UTSMode",
  "Ulimits",
  "UsernsMode",
  "VolumeDriver",
  "VolumesFrom",
]);

const UNSUPPORTED_CONFIG_KEYS = new Set([
  "ArgsEscaped",
  "MacAddress",
  "OnBuild",
  "Shell",
  "Volumes",
]);

// AttachStdin/AttachStdout/AttachStderr describe the Docker client's create-time
// attachment request, not the container's durable launch state. In particular,
// the Docker CLI defaults stdout/stderr to true and cannot express an empty
// attachment set, while OpenShell's Engine API create request records all three
// as false. OpenStdin and Tty remain hash-bound below because they do affect the
// durable container configuration.

const UNSUPPORTED_HOST_CONFIG_KEYS = new Set([
  "BlkioDeviceReadBps",
  "BlkioDeviceReadIOps",
  "BlkioDeviceWriteBps",
  "BlkioDeviceWriteIOps",
  "BlkioWeight",
  "BlkioWeightDevice",
  "Cgroup",
  "ContainerIDFile",
  "CpuCount",
  "CpuPercent",
  "CpuRealtimePeriod",
  "CpuRealtimeRuntime",
  "IOMaximumBandwidth",
  "IOMaximumIOps",
  "Isolation",
  "Links",
  "MemorySwappiness",
  "StorageOpt",
  "VolumeDriver",
  "VolumesFrom",
]);

const NULLABLE_HOST_CONFIG_ARRAY_KEYS = [
  "Binds",
  "BlkioDeviceReadBps",
  "BlkioDeviceReadIOps",
  "BlkioDeviceWriteBps",
  "BlkioDeviceWriteIOps",
  "BlkioWeightDevice",
  "CapAdd",
  "CapDrop",
  "DeviceCgroupRules",
  "DeviceRequests",
  "Devices",
  "Dns",
  "DnsOptions",
  "DnsSearch",
  "ExtraHosts",
  "GroupAdd",
  "Links",
  "MaskedPaths",
  "Mounts",
  "ReadonlyPaths",
  "SecurityOpt",
  "Ulimits",
  "VolumesFrom",
] as const;

const DOCKER_DEFAULT_TMPFS_OPTIONS = new Set(["noexec", "nosuid", "nodev"]);
const PODMAN_PIDS_LIMIT_ANNOTATION = "io.podman.annotations.pids-limit";
const PODMAN_RUNTIME_NETNS_TMPFS = "rw,nosuid,nodev,rprivate,tmpcopyup";

// Docker derives ConsoleSize, MaskedPaths, and ReadonlyPaths when it creates a
// container. They have no corresponding create flags, but the adapter inspects
// the stopped replacement and compares its complete normalized spec before it
// stops the original. Keep these runtime-derived security fields hash-bound so
// a daemon-default mismatch fails before cutover instead of rejecting defaults
// that Docker can reproduce exactly.

export interface DockerManagedBootstrapLaunchSpec {
  readonly schemaVersion: 1;
  readonly inspect: Pick<
    DockerContainerInspect,
    "Name" | "Config" | "HostConfig" | "NetworkSettings"
  > & { readonly Platform?: string };
}

function isEmptyDefault(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "" || value === 0) {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function exactObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Managed bootstrap Docker ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Managed bootstrap Docker ${label} contains unsupported fields: ${unknown.sort().join(", ")}.`,
    );
  }
}

function assertUnsupportedDefaults(host: Record<string, unknown>): void {
  const active = [...UNSUPPORTED_HOST_CONFIG_KEYS].filter((key) => !isEmptyDefault(host[key]));
  if (active.length > 0) {
    throw new Error(
      `Managed bootstrap refuses Docker launch fields it cannot reproduce exactly: ${active
        .sort()
        .join(", ")}.`,
    );
  }
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedNetworkSettings(
  value: DockerContainerInspect["NetworkSettings"],
  runtimeId: string | undefined,
): DockerContainerInspect["NetworkSettings"] {
  const networks = value?.Networks ?? {};
  const normalizedRuntimeId = String(runtimeId ?? "").trim().toLowerCase();
  return {
    Networks: Object.fromEntries(
      Object.entries(networks)
        .sort(([left], [right]) => byCodeUnit(left, right))
        .map(([name, network]) => [
          name,
          {
            Aliases: [
              ...new Set(
                (network.Aliases ?? []).filter((alias) => {
                  const normalizedAlias = alias.trim().toLowerCase();
                  return !(
                    /^[0-9a-f]{64}$/u.test(normalizedRuntimeId) &&
                    /^[0-9a-f]{12,64}$/u.test(normalizedAlias) &&
                    (normalizedRuntimeId.startsWith(normalizedAlias) ||
                      normalizedAlias.startsWith(normalizedRuntimeId))
                  );
                }),
              ),
            ].sort(),
          },
        ]),
    ),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => byCodeUnit(left, right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonicalCapability(value: unknown, label: string): string {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  const normalized = raw === "ALL" || raw.startsWith("CAP_") ? raw : `CAP_${raw}`;
  if (normalized !== "ALL" && !/^CAP_[A-Z0-9_]+$/u.test(normalized)) {
    throw new Error(`Managed bootstrap Docker ${label} contains an invalid capability.`);
  }
  return normalized;
}

function canonicalCapabilities(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Managed bootstrap Docker ${label} must be an array.`);
  }
  const normalized = value.map((entry) => canonicalCapability(entry, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Managed bootstrap Docker ${label} contains duplicate capabilities.`);
  }
  return normalized.sort();
}

function canonicalStringSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Managed bootstrap Docker ${label} must be a string array.`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`Managed bootstrap Docker ${label} contains duplicate entries.`);
  }
  return [...value].sort();
}

function normalizedConfig(config: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...config };
  delete normalized.AttachStdin;
  delete normalized.AttachStdout;
  delete normalized.AttachStderr;
  // Docker API clients may omit inactive image-only fields while older Docker
  // CLIs serialize the same defaults as null, false, or an empty collection.
  // Active values are rejected above because the clone cannot reproduce them.
  for (const key of UNSUPPORTED_CONFIG_KEYS) {
    if (isEmptyDefault(normalized[key])) delete normalized[key];
  }
  return normalized;
}

function normalizedStructuredMounts(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
    const mount = { ...(entry as Record<string, unknown>) };
    if (mount.Type !== "tmpfs") return mount;
    if (
      typeof mount.TmpfsOptions !== "object" ||
      mount.TmpfsOptions === null ||
      Array.isArray(mount.TmpfsOptions)
    ) {
      return mount;
    }
    const tmpfsOptions = { ...(mount.TmpfsOptions as Record<string, unknown>) };
    const options = tmpfsOptions.Options;
    if (
      options === undefined ||
      options === null ||
      (Array.isArray(options) && options.length === 0) ||
      (Array.isArray(options) &&
        options.every(
          (parts) =>
            Array.isArray(parts) &&
            parts.length === 1 &&
            typeof parts[0] === "string" &&
            DOCKER_DEFAULT_TMPFS_OPTIONS.has(parts[0]),
        ))
    ) {
      // Docker enforces these tmpfs security options by default, but Engine
      // inspect inconsistently reports an explicitly requested default after
      // recreation. Bind the effective size/mode/read-only state while
      // treating an explicit Docker default and its omission as equivalent.
      delete tmpfsOptions.Options;
    }
    mount.TmpfsOptions = tmpfsOptions;
    return mount;
  });
}

function normalizedImageMounts(value: DockerContainerInspect["Mounts"]): Array<{
  Type: "image";
  Source: string;
  Target: string;
  ReadOnly: boolean;
}> {
  return (value ?? [])
    .filter((mount) => mount.Type === "image")
    .map((mount) => {
      const source = String(mount.Source ?? "").trim();
      const target = String(mount.Destination ?? "").trim();
      if (!source || !target.startsWith("/") || typeof mount.RW !== "boolean") {
        throw new Error("Managed bootstrap Docker image mount is invalid.");
      }
      return { Type: "image", Source: source, Target: target, ReadOnly: !mount.RW };
    });
}

function dockerBindTarget(bind: string): string {
  const sourceDelimiter = bind.indexOf(":");
  if (sourceDelimiter < 0) return "";
  const optionsDelimiter = bind.indexOf(":", sourceDelimiter + 1);
  return bind.slice(sourceDelimiter + 1, optionsDelimiter < 0 ? undefined : optionsDelimiter);
}

function normalizedHostConfig(
  hostConfig: Record<string, unknown>,
  imageMounts: ReturnType<typeof normalizedImageMounts>,
  networkSettings: DockerContainerInspect["NetworkSettings"],
): Record<string, unknown> {
  const normalized = { ...hostConfig };
  for (const key of NULLABLE_HOST_CONFIG_ARRAY_KEYS) {
    if (normalized[key] === null) normalized[key] = [];
  }
  if (normalized.OomKillDisable === null) normalized.OomKillDisable = false;
  // Docker's Engine API can retain an absent port-binding map as null, while
  // `docker create` serializes the same no-bindings state as an empty object.
  // Active bindings remain present and hash-bound.
  if (normalized.PortBindings === null || normalized.PortBindings === undefined) {
    normalized.PortBindings = {};
  }
  const annotations =
    typeof normalized.Annotations === "object" &&
    normalized.Annotations !== null &&
    !Array.isArray(normalized.Annotations)
      ? { ...(normalized.Annotations as Record<string, unknown>) }
      : null;
  if (
    annotations &&
    Number.isSafeInteger(normalized.PidsLimit) &&
    String(annotations[PODMAN_PIDS_LIMIT_ANNOTATION] ?? "") === String(normalized.PidsLimit)
  ) {
    delete annotations[PODMAN_PIDS_LIMIT_ANNOTATION];
    normalized.Annotations = annotations;
  }
  // The native Podman provider is rootless. Podman preserves an Engine API
  // request of zero while stopped, then rewrites it to the current user's
  // effective floor (500) on start. Both values describe that same enforced
  // runtime setting; use the stable effective value in the launch contract.
  if (
    annotations?.["io.container.manager"] === "libpod" &&
    normalized.OomScoreAdj === 0
  ) {
    normalized.OomScoreAdj = 500;
  }
  const tmpfs =
    typeof normalized.Tmpfs === "object" &&
    normalized.Tmpfs !== null &&
    !Array.isArray(normalized.Tmpfs)
      ? { ...(normalized.Tmpfs as Record<string, unknown>) }
      : {};
  if (tmpfs["/run/netns"] === PODMAN_RUNTIME_NETNS_TMPFS) delete tmpfs["/run/netns"];
  normalized.Tmpfs = tmpfs;
  const attachedNetworks = Object.keys(networkSettings?.Networks ?? {});
  const configuredNetworkMode = String(normalized.NetworkMode ?? "").trim();
  if (
    attachedNetworks.length === 1 &&
    ["", "bridge", "default", "podman"].includes(configuredNetworkMode) &&
    !["bridge", "default", "podman"].includes(attachedNetworks[0]!)
  ) {
    normalized.NetworkMode = attachedNetworks[0];
  }
  // Podman reports its default private PID namespace as `private`, while the
  // Docker CLI represents the same default by omitting `--pid` and rejects
  // `--pid private`.
  if (normalized.PidMode === "private") normalized.PidMode = "";
  if (
    typeof normalized.NanoCpus === "number" &&
    normalized.NanoCpus > 0 &&
    ((typeof normalized.CpuPeriod === "number" && normalized.CpuPeriod !== 0) ||
      (typeof normalized.CpuQuota === "number" && normalized.CpuQuota !== 0))
  ) {
    if (
      !Number.isSafeInteger(normalized.NanoCpus) ||
      !Number.isSafeInteger(normalized.CpuPeriod) ||
      !Number.isSafeInteger(normalized.CpuQuota) ||
      (normalized.CpuPeriod as number) <= 0 ||
      (normalized.CpuQuota as number) <= 0 ||
      normalized.NanoCpus * (normalized.CpuPeriod as number) !==
        (normalized.CpuQuota as number) * 1_000_000_000
    ) {
      throw new Error("Managed bootstrap Docker CPU limit representations conflict.");
    }
    // Podman exposes the quota derived from NanoCpus in all three fields. The
    // Docker create API rejects receiving NanoCpus together with that exact
    // derived period/quota pair, so retain the canonical NanoCpus form only.
    normalized.CpuPeriod = 0;
    normalized.CpuQuota = 0;
  }
  for (const key of ["Binds", "MaskedPaths", "ReadonlyPaths"] as const) {
    if (key in normalized) normalized[key] = canonicalStringSet(normalized[key], key);
  }
  if (imageMounts.length > 0) {
    const imageTargets = new Set(imageMounts.map((mount) => mount.Target));
    const binds = Array.isArray(normalized.Binds) ? (normalized.Binds as string[]) : [];
    normalized.Binds = binds.filter(
      (bind) => !imageTargets.has(dockerBindTarget(bind)),
    );
    const existingMounts = normalizedStructuredMounts(normalized.Mounts ?? []);
    if (!Array.isArray(existingMounts)) {
      throw new Error("Managed bootstrap Docker HostConfig.Mounts must be an array.");
    }
    normalized.Mounts = [...existingMounts, ...imageMounts];
  }
  for (const key of ["CapAdd", "CapDrop"] as const) {
    if (key in normalized) normalized[key] = canonicalCapabilities(normalized[key], key);
  }
  if ("Mounts" in normalized) normalized.Mounts = normalizedStructuredMounts(normalized.Mounts);
  return normalized;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function parseExactDockerContainerInspect(output: string): DockerContainerInspect {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Managed bootstrap Docker inspect output is malformed.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Managed bootstrap Docker inspect must return exactly one workload.");
  }
  return exactObject(parsed[0], "inspect") as DockerContainerInspect;
}

export function normalizeDockerManagedBootstrapLaunchSpec(inspect: DockerContainerInspect): {
  readonly canonicalJson: string;
  readonly hash: string;
  readonly spec: DockerManagedBootstrapLaunchSpec;
} {
  const raw = inspect as DockerContainerInspect & Record<string, unknown>;
  const config = exactObject(raw.Config, "Config");
  const hostConfig = exactObject(raw.HostConfig, "HostConfig");
  const imageMounts = normalizedImageMounts(inspect.Mounts);
  assertKnownKeys(config, CONFIG_KEYS, "Config");
  assertKnownKeys(hostConfig, HOST_CONFIG_KEYS, "HostConfig");
  const unsupportedConfig = [...UNSUPPORTED_CONFIG_KEYS].filter(
    (key) => !isEmptyDefault(config[key]),
  );
  if (unsupportedConfig.length > 0) {
    throw new Error(
      `Managed bootstrap refuses Docker config fields it cannot reproduce exactly: ${unsupportedConfig
        .sort()
        .join(", ")}.`,
    );
  }
  assertUnsupportedDefaults(hostConfig);

  if (config.NetworkDisabled === true) {
    throw new Error("Managed bootstrap does not support Config.NetworkDisabled.");
  }
  if (config.StdinOnce === true) {
    throw new Error("Managed bootstrap does not support Config.StdinOnce.");
  }
  if (hostConfig.AutoRemove === true) {
    throw new Error("Managed bootstrap cannot preserve an auto-remove held workload.");
  }
  if (hostConfig.PublishAllPorts === true) {
    throw new Error("Managed bootstrap requires explicit Docker port bindings.");
  }
  if (Object.keys(inspect.NetworkSettings?.Networks ?? {}).length > 1) {
    throw new Error("Managed bootstrap refuses a Docker workload with multiple attached networks.");
  }

  const spec: DockerManagedBootstrapLaunchSpec = {
    schemaVersion: 1,
    inspect: {
      Name: inspect.Name,
      Config: normalizedConfig(config) as DockerContainerInspect["Config"],
      HostConfig: normalizedHostConfig(
        hostConfig,
        imageMounts,
        inspect.NetworkSettings,
      ) as DockerContainerInspect["HostConfig"],
      NetworkSettings: normalizedNetworkSettings(inspect.NetworkSettings, inspect.Id),
      ...("Platform" in raw && typeof raw.Platform === "string" ? { Platform: raw.Platform } : {}),
    },
  };
  const canonicalSpec = deepFreeze(canonicalize(spec) as DockerManagedBootstrapLaunchSpec);
  const canonicalJson = `${JSON.stringify(canonicalSpec)}\n`;
  return Object.freeze({
    canonicalJson,
    hash: createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
    spec: canonicalSpec,
  });
}

export function parseDockerManagedBootstrapLaunchSpec(
  canonicalJson: string,
): DockerManagedBootstrapLaunchSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson);
  } catch {
    throw new Error("Managed bootstrap Docker launch snapshot is malformed.");
  }
  const record = exactObject(parsed, "launch snapshot");
  if (
    Object.keys(record).sort().join(",") !== ["inspect", "schemaVersion"].join(",") ||
    record.schemaVersion !== 1
  ) {
    throw new Error("Managed bootstrap Docker launch snapshot schema is invalid.");
  }
  const normalized = normalizeDockerManagedBootstrapLaunchSpec(
    exactObject(record.inspect, "launch snapshot inspect") as DockerContainerInspect,
  );
  if (normalized.canonicalJson !== canonicalJson) {
    throw new Error("Managed bootstrap Docker launch snapshot is not canonical.");
  }
  return normalized.spec;
}
