// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  DockerContainerInspect,
  DockerGpuCloneRunOptions,
  DockerGpuPatchMode,
} from "./docker-gpu-patch-types";
import { openshellSandboxCommandEnvValue } from "./docker-startup-command-env";

const OPENSHELL_SANDBOX_COMMAND_ENV = "OPENSHELL_SANDBOX_COMMAND";
const GPU_ENV_KEYS = new Set([
  "NVIDIA_VISIBLE_DEVICES",
  "NVIDIA_DRIVER_CAPABILITIES",
  "NVIDIA_REQUIRE_CUDA",
  "NVIDIA_DISABLE_REQUIRE",
]);

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

function pushNumberFlag(args: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
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

export function sameContainerId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.startsWith(right) || right.startsWith(left);
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

export function buildDockerGpuCloneRunArgs(
  inspect: DockerContainerInspect,
  mode: DockerGpuPatchMode,
  options: DockerGpuCloneRunOptions = {},
): string[] {
  const config = inspect.Config || {};
  const host = inspect.HostConfig || {};
  const image = String(options.image || config.Image || "").trim();
  if (!image) throw new Error("Docker inspect output did not include Config.Image.");

  const args: string[] = ["--name", dockerContainerName(inspect), ...mode.args];
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

  const sandboxCommand = openshellSandboxCommandEnvValue(options.openshellSandboxCommand);
  let sawSandboxCommand = false;
  for (const env of stringArray(config.Env).filter(
    (entry) => !gpuAugment || !GPU_ENV_KEYS.has(envKey(entry)),
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

  const labels = config.Labels || {};
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value !== undefined && value !== null) args.push("--label", `${key}=${value}`);
  }
  for (const bind of stringArray(host.Binds)) args.push("--volume", bind);
  const networkMode = options.networkMode ?? host.NetworkMode;
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
  if (networkMode !== "host") {
    const dnsServers = stringArray(host.Dns);
    for (const dns of dnsServers) args.push("--dns", dns);
    for (const dnsSearch of stringArray(host.DnsSearch)) args.push("--dns-search", dnsSearch);
    if (dnsServers.length === 0 && options.sandboxFallbackDns) {
      args.push("--dns", options.sandboxFallbackDns);
    }
  }

  pushNumberFlag(args, "--memory", host.Memory);
  pushNumberFlag(args, "--memory-reservation", host.MemoryReservation);
  pushNumberFlag(args, "--memory-swap", host.MemorySwap);
  pushNumberFlag(args, "--cpu-shares", host.CpuShares);
  pushNumberFlag(args, "--cpu-quota", host.CpuQuota);
  pushNumberFlag(args, "--cpu-period", host.CpuPeriod);
  pushNumberFlag(args, "--shm-size", host.ShmSize);
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
  if (entrypoint.length > 0) args.push("--entrypoint", entrypoint[0]);
  const commandArgs = sandboxCommand ? [] : [...entrypoint.slice(1), ...stringArray(config.Cmd)];
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
