// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  DockerContainerInspect,
  DockerGpuCloneRunOptions,
  DockerGpuPatchMode,
  DockerUlimit,
} from "./docker-gpu-patch-types";
import { openshellSandboxCommandEnvValue } from "./docker-startup-command-env";

const OPENSHELL_SANDBOX_COMMAND_ENV = "OPENSHELL_SANDBOX_COMMAND";
const OPENSHELL_SANDBOX_ENTRYPOINT = "/opt/openshell/bin/openshell-sandbox";
const OPENSHELL_V0_0_99_WORKDIR_COMMAND = ["--workdir", "/sandbox"] as const;
const OPENSHELL_OCI_IMAGE_USER_ENV = "OPENSHELL_OCI_IMAGE_USER";
const OPENSHELL_SANDBOX_UID_ENV = "OPENSHELL_SANDBOX_UID";
const OPENSHELL_SANDBOX_GID_ENV = "OPENSHELL_SANDBOX_GID";
const NEMOCLAW_STARTUP_EXECUTABLES = new Set(["nemoclaw-start", "/usr/local/bin/nemoclaw-start"]);
const GPU_ENV_KEYS = new Set([
  "NVIDIA_VISIBLE_DEVICES",
  "NVIDIA_DRIVER_CAPABILITIES",
  "NVIDIA_REQUIRE_CUDA",
  "NVIDIA_DISABLE_REQUIRE",
]);
const DOCKER_DEFAULT_TMPFS_OPTIONS = new Set(["noexec", "nosuid", "nodev"]);
type DockerStructuredMount = NonNullable<
  NonNullable<DockerContainerInspect["HostConfig"]>["Mounts"]
>[number];

export const DOCKER_GPU_PATCH_NETWORK_ENV = "NEMOCLAW_DOCKER_GPU_PATCH_NETWORK";

export function dockerContainerName(inspect: DockerContainerInspect): string {
  const raw = String(inspect.Name || "")
    .replace(/^\/+/, "")
    .trim();
  if (!raw) throw new Error("Docker inspect output did not include a container name.");
  return raw;
}

function stringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function envKey(env: string): string {
  const index = env.indexOf("=");
  return index === -1 ? env : env.slice(0, index);
}

function envValue(env: string[] | null | undefined, key: string): string | null {
  const prefix = `${key}=`;
  const entry = stringArray(env).find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

function replaceEnvValue(entry: string, key: string, value: string | null | undefined): string {
  if (!value || envKey(entry) !== key) return entry;
  return `${key}=${value}`;
}

function dockerGpuHostEndpointFromOpenShellEndpoint(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.hostname !== "host.openshell.internal") return null;
    url.hostname = "127.0.0.1";
    return url.toString();
  } catch {
    return null;
  }
}

function pushStringFlag(args: string[], flag: string, value: unknown): void {
  const normalized = String(value ?? "").trim();
  if (normalized) args.push(flag, normalized);
}

function managedPortKey(value: string): string {
  const match = /^(\d{1,5})\/(tcp|udp|sctp)$/u.exec(value);
  const port = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Managed bootstrap Docker port '${value}' is invalid.`);
  }
  return value;
}

function managedPublishedPort(hostIp: unknown, hostPort: unknown, containerPort: string): string {
  const ip = String(hostIp ?? "").trim();
  const published = String(hostPort ?? "").trim();
  if (!/^\d{1,5}$/u.test(published) || Number(published) < 1 || Number(published) > 65_535) {
    throw new Error(`Managed bootstrap Docker binding for '${containerPort}' is invalid.`);
  }
  if (ip.includes("\0") || /\s/u.test(ip)) {
    throw new Error(`Managed bootstrap Docker binding for '${containerPort}' is invalid.`);
  }
  const address = ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
  return address ? `${address}:${published}:${containerPort}` : `${published}:${containerPort}`;
}

function pushManagedPortArgs(args: string[], inspect: DockerContainerInspect): void {
  const exposed = inspect.Config?.ExposedPorts ?? {};
  const bindings = inspect.HostConfig?.PortBindings ?? {};
  for (const port of new Set([...Object.keys(exposed), ...Object.keys(bindings)])) {
    const normalizedPort = managedPortKey(port);
    args.push("--expose", normalizedPort);
    const entries = bindings[port];
    if (entries === null || entries === undefined) continue;
    if (!Array.isArray(entries)) {
      throw new Error(`Managed bootstrap Docker bindings for '${port}' are invalid.`);
    }
    for (const entry of entries) {
      args.push(
        "--publish",
        managedPublishedPort(entry?.HostIp, entry?.HostPort, normalizedPort),
      );
    }
  }
}

function managedDuration(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Managed bootstrap Docker ${label} is invalid.`);
  }
  return `${String(value)}ns`;
}

function pushManagedHealthcheckArgs(args: string[], inspect: DockerContainerInspect): void {
  const healthcheck = inspect.Config?.Healthcheck;
  if (healthcheck === undefined || healthcheck === null) return;
  const test = healthcheck.Test ?? [];
  if (!Array.isArray(test) || test.some((entry) => typeof entry !== "string")) {
    throw new Error("Managed bootstrap Docker healthcheck command is invalid.");
  }
  if (test.length === 1 && test[0] === "NONE") {
    args.push("--no-healthcheck");
  } else if (test.length === 2 && test[0] === "CMD-SHELL" && test[1]) {
    args.push("--health-cmd", test[1]);
  } else {
    throw new Error("Managed bootstrap Docker healthcheck command cannot be reproduced exactly.");
  }
  for (const [flag, value, label] of [
    ["--health-interval", healthcheck.Interval, "healthcheck interval"],
    ["--health-timeout", healthcheck.Timeout, "healthcheck timeout"],
    ["--health-start-period", healthcheck.StartPeriod, "healthcheck start period"],
    ["--health-start-interval", healthcheck.StartInterval, "healthcheck start interval"],
  ] as const) {
    const duration = managedDuration(value, label);
    if (duration !== null) args.push(flag, duration);
  }
  if (healthcheck.Retries !== undefined && healthcheck.Retries !== null) {
    if (!Number.isSafeInteger(healthcheck.Retries) || healthcheck.Retries < 0) {
      throw new Error("Managed bootstrap Docker healthcheck retries are invalid.");
    }
    args.push("--health-retries", String(healthcheck.Retries));
  }
}

function managedNetworkMode(inspect: DockerContainerInspect, configured: unknown): string {
  const mode = String(configured ?? "").trim();
  const networks = Object.keys(inspect.NetworkSettings?.Networks ?? {});
  if (
    networks.length === 1 &&
    ["", "bridge", "default", "podman"].includes(mode) &&
    !["bridge", "default", "podman"].includes(networks[0]!)
  ) {
    return networks[0]!;
  }
  return mode;
}

function normalizeRequiredUlimit(ulimit: DockerUlimit): DockerUlimit {
  const name = String(ulimit.name).trim();
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
    throw new Error(`Invalid Docker ulimit name '${name}'.`);
  }
  if (
    !Number.isSafeInteger(ulimit.soft) ||
    ulimit.soft < 0 ||
    !Number.isSafeInteger(ulimit.hard) ||
    ulimit.hard < ulimit.soft
  ) {
    throw new Error(`Invalid Docker ulimit values for '${name}'.`);
  }
  return { name, soft: ulimit.soft, hard: ulimit.hard };
}

export function normalizeDockerUlimitName(name: unknown): string {
  const normalized = String(name ?? "").trim();
  return /^RLIMIT_[A-Z][A-Z0-9_]*$/u.test(normalized)
    ? normalized.slice("RLIMIT_".length).toLowerCase()
    : normalized;
}

export function validateRequiredDockerUlimits(
  required: readonly DockerUlimit[] | null | undefined,
): void {
  for (const ulimit of required ?? []) normalizeRequiredUlimit(ulimit);
}

function dockerUlimits(
  inspect: DockerContainerInspect,
  required: readonly DockerUlimit[] | null | undefined,
): DockerUlimit[] {
  const merged = new Map<string, DockerUlimit>();
  for (const ulimit of inspect.HostConfig?.Ulimits ?? []) {
    const name = normalizeDockerUlimitName(ulimit.Name);
    const soft = ulimit.Soft;
    const hard = ulimit.Hard;
    if (
      !name ||
      !Number.isSafeInteger(soft) ||
      (soft as number) < -1 ||
      !Number.isSafeInteger(hard) ||
      (hard as number) < -1 ||
      ((hard as number) !== -1 && (soft as number) > (hard as number))
    ) {
      continue;
    }
    merged.set(name, { name, soft: soft as number, hard: hard as number });
  }
  for (const ulimit of required ?? []) {
    const normalized = normalizeRequiredUlimit(ulimit);
    merged.set(normalized.name, normalized);
  }
  return [...merged.values()];
}

function mountValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`Docker structured mount ${label} must be a non-empty trimmed string.`);
  }
  if (/[\0,:]/u.test(value)) {
    throw new Error(`Docker structured mount ${label} contains an unsupported delimiter.`);
  }
  return value;
}

function optionalMountBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new Error(`Docker structured mount ${label} must be a boolean.`);
  }
  return value;
}

function assertUnusedMountOption(value: unknown, label: string): void {
  if (value !== undefined && value !== null) {
    throw new Error(`Docker structured mount has unexpected ${label}.`);
  }
}

function dockerTmpfsMountValue(mount: DockerStructuredMount): string {
  if (String(mount.Source ?? "") !== "") {
    throw new Error("Docker tmpfs mount must not include a source.");
  }
  if (String(mount.Consistency ?? "") !== "") {
    throw new Error("Docker tmpfs mount consistency is not supported during recreation.");
  }
  assertUnusedMountOption(mount.BindOptions, "BindOptions for a tmpfs mount");
  assertUnusedMountOption(mount.VolumeOptions, "VolumeOptions for a tmpfs mount");

  const target = mountValue(mount.Target, "target");
  if (!target.startsWith("/")) {
    throw new Error("Docker structured mount target must be an absolute container path.");
  }
  const values = [`type=tmpfs`, `dst=${target}`];
  if (optionalMountBoolean(mount.ReadOnly, "ReadOnly")) values.push("readonly");
  for (const parts of mount.TmpfsOptions?.Options ?? []) {
    if (!Array.isArray(parts) || parts.length !== 1) {
      throw new Error("Docker structured tmpfs options must contain exactly one value.");
    }
    const option = mountValue(parts[0], "tmpfs option");
    if (!DOCKER_DEFAULT_TMPFS_OPTIONS.has(option)) {
      throw new Error(
        `Docker structured tmpfs option '${option}' cannot be preserved during recreation.`,
      );
    }
  }

  const sizeBytes = mount.TmpfsOptions?.SizeBytes;
  if (sizeBytes !== undefined && sizeBytes !== null) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new Error("Docker tmpfs mount size must be a positive safe integer.");
    }
    values.push(`tmpfs-size=${sizeBytes}`);
  }
  const mode = mount.TmpfsOptions?.Mode;
  if (mode !== undefined && mode !== null) {
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new Error("Docker tmpfs mount mode must be a valid non-negative file mode.");
    }
    values.push(`tmpfs-mode=${mode.toString(8)}`);
  }
  return values.join(",");
}

function dockerVolumeMountValue(mount: DockerStructuredMount): string {
  if (String(mount.Consistency ?? "") !== "") {
    throw new Error("Docker volume mount consistency is not supported during recreation.");
  }
  assertUnusedMountOption(mount.BindOptions, "BindOptions for a volume mount");
  assertUnusedMountOption(mount.TmpfsOptions, "TmpfsOptions for a volume mount");

  const source = mountValue(mount.Source, "volume source");
  const target = mountValue(mount.Target, "target");
  if (!target.startsWith("/")) {
    throw new Error("Docker structured mount target must be an absolute container path.");
  }
  const values = [`type=volume`, `src=${source}`, `dst=${target}`];
  if (optionalMountBoolean(mount.ReadOnly, "ReadOnly")) values.push("readonly");
  const volumeOptions = mount.VolumeOptions;
  if (optionalMountBoolean(volumeOptions?.NoCopy, "VolumeOptions.NoCopy")) {
    values.push("volume-nocopy");
  }
  if (volumeOptions?.Subpath) {
    values.push(`volume-subpath=${mountValue(volumeOptions.Subpath, "volume subpath")}`);
  }
  if (volumeOptions?.Labels && Object.keys(volumeOptions.Labels).length > 0) {
    throw new Error("Docker volume mount labels are not supported during recreation.");
  }
  assertUnusedMountOption(volumeOptions?.DriverConfig, "VolumeOptions.DriverConfig");
  return values.join(",");
}

function dockerImageMountValue(mount: DockerStructuredMount): string {
  if (String(mount.Consistency ?? "") !== "") {
    throw new Error("Docker image mount consistency is not supported during recreation.");
  }
  assertUnusedMountOption(mount.BindOptions, "BindOptions for an image mount");
  assertUnusedMountOption(mount.VolumeOptions, "VolumeOptions for an image mount");
  assertUnusedMountOption(mount.TmpfsOptions, "TmpfsOptions for an image mount");

  const source = String(mount.Source ?? "").trim();
  if (!source || /[\0,]/u.test(source)) {
    throw new Error("Docker image mount source is invalid.");
  }
  const target = mountValue(mount.Target, "target");
  if (!target.startsWith("/")) {
    throw new Error("Docker structured mount target must be an absolute container path.");
  }
  if (!optionalMountBoolean(mount.ReadOnly, "ReadOnly")) {
    throw new Error("Docker image mounts must remain read-only during recreation.");
  }
  const values = [`type=image`, `src=${source}`, `dst=${target}`];
  // Podman's Docker-compatible API translates Docker's `readonly` flag to
  // `ro=true`, which its image-mount parser rejects. Image mounts default to
  // read-only when the option is omitted.
  return values.join(",");
}

function dockerStructuredMountArgs(inspect: DockerContainerInspect): string[] {
  const args: string[] = [];
  for (const mount of inspect.HostConfig?.Mounts ?? []) {
    switch (mount.Type) {
      case "tmpfs":
        // Docker applies noexec, nosuid, and nodev to tmpfs mounts by default.
        // Keep the structured representation so Docker inspect and later
        // recreation retain size and mode alongside that security posture.
        args.push("--mount", dockerTmpfsMountValue(mount));
        break;
      case "volume":
        args.push("--mount", dockerVolumeMountValue(mount));
        break;
      case "image":
        args.push("--mount", dockerImageMountValue(mount));
        break;
      default:
        throw new Error(`Unsupported Docker structured mount type '${String(mount.Type)}'.`);
    }
  }
  return args;
}

function pushNumberFlag(args: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    args.push(flag, String(value));
  }
}

function pushNonZeroIntegerFlag(args: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value !== 0) {
    args.push(flag, String(value));
  }
}

function dockerCpusFromNanoCpus(nanoCpus: number): string {
  return (nanoCpus / 1_000_000_000).toFixed(3).replace(/\.?0+$/, "");
}

export function buildDockerGpuCloneRunOptions(
  inspect: DockerContainerInspect,
  env: Record<string, string | undefined> = process.env,
): DockerGpuCloneRunOptions {
  if (getDockerGpuPatchNetworkMode(env) !== "host") return {};
  const endpoint = envValue(inspect.Config?.Env, "OPENSHELL_ENDPOINT");
  if (!endpoint) {
    throw new Error(
      `${DOCKER_GPU_PATCH_NETWORK_ENV}=host requires the inspected sandbox to include OPENSHELL_ENDPOINT.`,
    );
  }
  const hostEndpoint = dockerGpuHostEndpointFromOpenShellEndpoint(endpoint);
  if (!hostEndpoint) {
    throw new Error(
      `${DOCKER_GPU_PATCH_NETWORK_ENV}=host requires OPENSHELL_ENDPOINT to use host.openshell.internal so NemoClaw can rewrite it to host loopback.`,
    );
  }
  return { networkMode: "host", openshellEndpoint: hostEndpoint };
}

export function getDockerGpuPatchNetworkMode(
  env: Record<string, string | undefined> = process.env,
): "host" | "preserve" {
  const networkOverride = String(env[DOCKER_GPU_PATCH_NETWORK_ENV] || "")
    .trim()
    .toLowerCase();
  return networkOverride === "host" ? "host" : "preserve";
}

/**
 * Return the compatibility resolver that clone construction will inject.
 * Keep this decision shared with the pre-mutation DNS probe so explicit DNS
 * and host networking cannot be tested against an override they will not use.
 */
export function getDockerGpuCloneFallbackDns(
  inspect: DockerContainerInspect,
  options: DockerGpuCloneRunOptions = {},
): string | null {
  const host = inspect.HostConfig || {};
  const networkMode = options.networkMode ?? host.NetworkMode;
  if (networkMode === "host" || stringArray(host.Dns).length > 0) return null;
  const fallback = String(options.sandboxFallbackDns ?? "").trim();
  return fallback || null;
}

export function sameContainerId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.startsWith(right) || right.startsWith(left);
}

/** Return only a complete Docker container ID that is safe for exact-ID cleanup. */
export function fullDockerContainerId(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function dockerNetworkAliases(
  inspect: DockerContainerInspect,
  networkMode: string | null | undefined,
): string[] {
  const network = String(networkMode || "").trim();
  if (
    !network ||
    ["bridge", "default", "host", "none"].includes(network) ||
    network.includes(":")
  ) {
    return [];
  }
  const networkInfo = inspect.NetworkSettings?.Networks?.[network];
  const containerId = String(inspect.Id || "").trim();
  return Array.from(new Set(stringArray(networkInfo?.Aliases)))
    .map((alias) => alias.trim())
    .filter(Boolean)
    .filter((alias) => !sameContainerId(alias, containerId));
}

function exactArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactEnvironmentEntries(environment: readonly string[], key: string): string[] {
  return environment.filter((entry) => envKey(entry) === key);
}

function isExactNemoClawOciWorkspaceBoundary(
  config: NonNullable<DockerContainerInspect["Config"]>,
  intendedWorkloadArgv: readonly string[] | null | undefined,
): boolean {
  const entrypoint = stringArray(config.Entrypoint);
  const configuredCommand = stringArray(config.Cmd);
  const labels = config.Labels ?? {};
  const startupExecutable = intendedWorkloadArgv?.at(-1);
  return (
    config.User === "0" &&
    config.WorkingDir === "/" &&
    exactArrayEqual(entrypoint, [OPENSHELL_SANDBOX_ENTRYPOINT]) &&
    (configuredCommand.length === 0 ||
      exactArrayEqual(configuredCommand, OPENSHELL_V0_0_99_WORKDIR_COMMAND)) &&
    labels["openshell.ai/managed-by"] === "openshell" &&
    typeof startupExecutable === "string" &&
    NEMOCLAW_STARTUP_EXECUTABLES.has(startupExecutable)
  );
}

function validateOpenShellOciIdentityMetadata(environment: readonly string[]): boolean {
  const ociUsers = exactEnvironmentEntries(environment, OPENSHELL_OCI_IMAGE_USER_ENV);
  const sandboxUids = exactEnvironmentEntries(environment, OPENSHELL_SANDBOX_UID_ENV);
  const sandboxGids = exactEnvironmentEntries(environment, OPENSHELL_SANDBOX_GID_ENV);
  if (ociUsers.length === 0 && sandboxUids.length === 0 && sandboxGids.length === 0) {
    // OpenShell through v0.0.85 did not publish OCI identity metadata.
    return false;
  }
  if (
    ociUsers.length === 0 &&
    sandboxUids.length === 1 &&
    sandboxUids[0] === `${OPENSHELL_SANDBOX_UID_ENV}=` &&
    sandboxGids.length === 1 &&
    sandboxGids[0] === `${OPENSHELL_SANDBOX_GID_ENV}=`
  ) {
    // A prior reviewed recreation already removed only the OCI-user marker.
    return false;
  }
  const ociUserPrefix = `${OPENSHELL_OCI_IMAGE_USER_ENV}=`;
  if (
    ociUsers.length !== 1 ||
    !ociUsers[0]?.startsWith(ociUserPrefix) ||
    ociUsers[0] === ociUserPrefix ||
    sandboxUids.length !== 1 ||
    sandboxUids[0] !== `${OPENSHELL_SANDBOX_UID_ENV}=` ||
    sandboxGids.length !== 1 ||
    sandboxGids[0] !== `${OPENSHELL_SANDBOX_GID_ENV}=`
  ) {
    throw new Error(
      "OpenShell workspace identity metadata is not the reviewed Docker compatibility contract.",
    );
  }
  return true;
}

/**
 * OpenShell 0.0.99 began using `OPENSHELL_OCI_IMAGE_USER` presence to prepare
 * its default workspace. That preparation changes the `/sandbox` owner before
 * the workload starts, which breaks NemoClaw's Shields parent ownership
 * requirement. The recreated Docker supervisor retains NemoClaw's explicit
 * sandbox policy, so omitting only this marker replays the pre-0.0.99 workspace
 * behavior without changing the process identity selected by policy.
 */
export function shouldOmitOpenShellOciImageUser(
  inspect: DockerContainerInspect,
  intendedWorkloadArgv: readonly string[] | null | undefined,
): boolean {
  const config: NonNullable<DockerContainerInspect["Config"]> = inspect.Config ?? {};
  return isExactNemoClawOciWorkspaceBoundary(config, intendedWorkloadArgv)
    ? validateOpenShellOciIdentityMetadata(stringArray(config.Env))
    : false;
}

function dockerContainerCommandArgs(
  entrypoint: readonly string[],
  configuredCommand: readonly string[],
  sandboxCommand: string | null,
  commandOverride: readonly string[] | null | undefined,
): string[] {
  if (commandOverride != null) return [...commandOverride];
  if (!sandboxCommand) return [...entrypoint.slice(1), ...configuredCommand];

  // OpenShell through v0.0.85 cleared the image command, while v0.0.99
  // requires this exact supervisor workdir tuple. Preserve only the reviewed
  // release contract: replaying arbitrary image-controlled command arguments
  // at the root supervisor boundary would widen the recreation trust surface.
  if (!exactArrayEqual(entrypoint, [OPENSHELL_SANDBOX_ENTRYPOINT])) {
    throw new Error(
      "OpenShell sandbox supervisor command is not a reviewed restart-safe contract.",
    );
  }
  if (configuredCommand.length === 0) return [];
  if (exactArrayEqual(configuredCommand, OPENSHELL_V0_0_99_WORKDIR_COMMAND)) {
    return [...configuredCommand];
  }
  throw new Error("OpenShell sandbox supervisor command is not a reviewed restart-safe contract.");
}

export function buildDockerGpuCloneRunArgs(
  inspect: DockerContainerInspect,
  mode: DockerGpuPatchMode,
  options: DockerGpuCloneRunOptions = {},
): string[] {
  const config = inspect.Config || {};
  const host = inspect.HostConfig || {};
  const image = String(options.image || config.Image || "").trim();
  if (!image) throw new Error("Docker inspect output did not include Config.Image.");

  const containerName = String(options.containerName ?? dockerContainerName(inspect)).trim();
  if (
    containerName.length === 0 ||
    containerName.length > 253 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(containerName)
  ) {
    throw new Error("Docker clone container name is invalid.");
  }
  const args: string[] = ["--name", containerName, ...mode.args];
  const gpuAugment = mode.kind !== "startup-command";

  // Startup-command recreation must retain OpenShell's native CDI attachment.
  if (!gpuAugment) {
    const cdiDeviceIds = new Set(
      (host.DeviceRequests ?? [])
        .filter((request) => request.Driver === "cdi")
        .flatMap((request) => stringArray(request.DeviceIDs))
        .map((deviceId) => deviceId.trim())
        .filter(Boolean),
    );
    for (const deviceId of cdiDeviceIds) args.push("--device", deviceId);
  }
  pushStringFlag(args, "--hostname", config.Hostname);
  pushStringFlag(args, "--user", config.User);
  pushStringFlag(args, "--workdir", config.WorkingDir);
  if (config.Tty) args.push("--tty");
  if (config.OpenStdin) args.push("--interactive");
  if (options.preserveManagedLaunchSpec) {
    pushManagedPortArgs(args, inspect);
    pushManagedHealthcheckArgs(args, inspect);
    if (config.StopTimeout !== undefined && config.StopTimeout !== null) {
      if (!Number.isSafeInteger(config.StopTimeout) || config.StopTimeout < 0) {
        throw new Error("Managed bootstrap Docker stop timeout is invalid.");
      }
      args.push("--stop-timeout", String(config.StopTimeout));
    }
    if (host.OomScoreAdj !== undefined && host.OomScoreAdj !== null) {
      if (
        !Number.isSafeInteger(host.OomScoreAdj) ||
        host.OomScoreAdj < -1_000 ||
        host.OomScoreAdj > 1_000
      ) {
        throw new Error("Managed bootstrap Docker OOM score adjustment is invalid.");
      }
      // Native Podman is rootless and clamps an inspected request of zero to
      // the API-service user's effective floor when the container starts.
      // Request that stable effective value up front so stopped and running
      // inspection report one launch contract.
      const oomScoreAdj =
        host.Annotations?.["io.container.manager"] === "libpod" && host.OomScoreAdj === 0
          ? 500
          : host.OomScoreAdj;
      args.push("--oom-score-adj", String(oomScoreAdj));
    }
  }

  const sandboxCommand = openshellSandboxCommandEnvValue(options.openshellSandboxCommand);
  const omitOciImageUser = shouldOmitOpenShellOciImageUser(
    inspect,
    options.openshellSandboxCommand,
  );
  let sawSandboxCommand = false;
  for (const env of stringArray(config.Env).filter(
    (entry) =>
      (!gpuAugment || !GPU_ENV_KEYS.has(envKey(entry))) &&
      (!omitOciImageUser || envKey(entry) !== OPENSHELL_OCI_IMAGE_USER_ENV),
  )) {
    const key = envKey(env);
    if (key === OPENSHELL_SANDBOX_COMMAND_ENV && sandboxCommand) {
      sawSandboxCommand = true;
      args.push("--env", `${OPENSHELL_SANDBOX_COMMAND_ENV}=${sandboxCommand}`);
      continue;
    }
    args.push("--env", replaceEnvValue(env, "OPENSHELL_ENDPOINT", options.openshellEndpoint));
  }
  if (sandboxCommand && !sawSandboxCommand) {
    args.push("--env", `${OPENSHELL_SANDBOX_COMMAND_ENV}=${sandboxCommand}`);
  }

  const annotations = host.Annotations || {};
  for (const key of Object.keys(annotations).sort()) {
    const value = annotations[key];
    if (value !== undefined && value !== null) args.push("--annotation", `${key}=${value}`);
  }
  const labels = config.Labels || {};
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value !== undefined && value !== null) args.push("--label", `${key}=${value}`);
  }
  for (const bind of stringArray(host.Binds)) args.push("--volume", bind);
  args.push(...dockerStructuredMountArgs(inspect));
  const configuredNetworkMode = options.networkMode ?? host.NetworkMode;
  const networkMode = options.preserveManagedLaunchSpec
    ? managedNetworkMode(inspect, configuredNetworkMode)
    : configuredNetworkMode;
  pushStringFlag(args, "--network", networkMode);
  for (const alias of dockerNetworkAliases(inspect, networkMode))
    args.push("--network-alias", alias);

  const restart = host.RestartPolicy;
  if (restart?.Name && restart.Name !== "no") {
    const value =
      restart.Name === "on-failure" && restart.MaximumRetryCount
        ? `${restart.Name}:${restart.MaximumRetryCount}`
        : restart.Name;
    args.push("--restart", value);
  }

  const capAdd = new Set(stringArray(host.CapAdd));
  if (gpuAugment) capAdd.add("SYS_PTRACE");
  for (const cap of capAdd) args.push("--cap-add", cap);
  for (const cap of stringArray(host.CapDrop)) args.push("--cap-drop", cap);
  const securityOpt = new Set(stringArray(host.SecurityOpt));
  if (gpuAugment && ![...securityOpt].some((entry) => entry.startsWith("apparmor"))) {
    securityOpt.add("apparmor=unconfined");
  }
  for (const option of securityOpt) args.push("--security-opt", option);
  for (const hostEntry of stringArray(host.ExtraHosts)) args.push("--add-host", hostEntry);
  const groupAdds = new Set(stringArray(host.GroupAdd));
  for (const group of groupAdds) args.push("--group-add", group);
  for (const gid of options.extraGroupGids ?? []) {
    const normalized = String(gid).trim();
    if (normalized && !groupAdds.has(normalized)) {
      groupAdds.add(normalized);
      args.push("--group-add", normalized);
    }
  }
  for (const ulimit of dockerUlimits(inspect, options.requiredUlimits)) {
    args.push("--ulimit", `${ulimit.name}=${ulimit.soft}:${ulimit.hard}`);
  }
  if (networkMode !== "host") {
    const dnsServers = stringArray(host.Dns);
    for (const dns of dnsServers) args.push("--dns", dns);
    for (const dnsSearch of stringArray(host.DnsSearch)) args.push("--dns-search", dnsSearch);
    const fallbackDns = getDockerGpuCloneFallbackDns(inspect, options);
    if (fallbackDns) args.push("--dns", fallbackDns);
  }

  pushNumberFlag(args, "--memory", host.Memory);
  pushNumberFlag(args, "--memory-reservation", host.MemoryReservation);
  pushNumberFlag(args, "--memory-swap", host.MemorySwap);
  pushNumberFlag(args, "--cpu-shares", host.CpuShares);
  pushNumberFlag(args, "--cpu-quota", host.CpuQuota);
  pushNumberFlag(args, "--cpu-period", host.CpuPeriod);
  pushNumberFlag(args, "--shm-size", host.ShmSize);
  pushNonZeroIntegerFlag(args, "--pids-limit", host.PidsLimit);
  if (typeof host.NanoCpus === "number" && host.NanoCpus > 0) {
    args.push("--cpus", dockerCpusFromNanoCpus(host.NanoCpus));
  }
  pushStringFlag(args, "--cpuset-cpus", host.CpusetCpus);
  pushStringFlag(args, "--cpuset-mems", host.CpusetMems);
  pushStringFlag(args, "--ipc", host.IpcMode);
  pushStringFlag(args, "--pid", host.PidMode);
  if (host.Privileged) args.push("--privileged");
  if (host.Init) args.push("--init");

  const entrypoint = stringArray(config.Entrypoint);
  const replacementEntrypoint = String(options.containerEntrypoint ?? "").trim();
  if (replacementEntrypoint) {
    args.push("--entrypoint", replacementEntrypoint);
  } else if (entrypoint.length > 0) {
    args.push("--entrypoint", entrypoint[0]);
  }
  const commandArgs = dockerContainerCommandArgs(
    entrypoint,
    stringArray(config.Cmd),
    sandboxCommand,
    options.containerCommand,
  );
  args.push(image, ...commandArgs);
  return args;
}

export function parseDockerInspectJson(output: string): DockerContainerInspect {
  const parsed = JSON.parse(output);
  const inspect = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!inspect || typeof inspect !== "object") {
    throw new Error("Docker inspect did not return a container object.");
  }
  return inspect as DockerContainerInspect;
}
