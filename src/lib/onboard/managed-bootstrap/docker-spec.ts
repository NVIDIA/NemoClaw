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

// Docker exposes each attach stream independently through `--attach`, so the
// clone renderer can preserve these Config booleans exactly. Keep them in the
// normalized launch spec and verify the stopped replacement before cutover.

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
): DockerContainerInspect["NetworkSettings"] {
  const networks = value?.Networks ?? {};
  return {
    Networks: Object.fromEntries(
      Object.entries(networks)
        .sort(([left], [right]) => byCodeUnit(left, right))
        .map(([name, network]) => [
          name,
          {
            Aliases: [...(network.Aliases ?? [])].sort(),
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
  // Docker API clients may omit inactive image-only fields while older Docker
  // CLIs serialize the same defaults as null, false, or an empty collection.
  // Active values are rejected above because the clone cannot reproduce them.
  for (const key of UNSUPPORTED_CONFIG_KEYS) {
    if (isEmptyDefault(normalized[key])) delete normalized[key];
  }
  return normalized;
}

function normalizedHostConfig(hostConfig: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...hostConfig };
  for (const key of NULLABLE_HOST_CONFIG_ARRAY_KEYS) {
    if (normalized[key] === null) normalized[key] = [];
  }
  if (normalized.OomKillDisable === null) normalized.OomKillDisable = false;
  for (const key of ["Binds", "MaskedPaths", "ReadonlyPaths"] as const) {
    if (key in normalized) normalized[key] = canonicalStringSet(normalized[key], key);
  }
  for (const key of ["CapAdd", "CapDrop"] as const) {
    if (key in normalized) normalized[key] = canonicalCapabilities(normalized[key], key);
  }
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
      HostConfig: normalizedHostConfig(hostConfig) as DockerContainerInspect["HostConfig"],
      NetworkSettings: normalizedNetworkSettings(inspect.NetworkSettings),
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
