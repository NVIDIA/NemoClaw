// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  dockerCapture,
  dockerRename,
  dockerRm,
  dockerRun,
  dockerRunDetached,
  dockerStop,
} from "../adapters/docker";
import type {
  DockerContainerInspect,
  DockerGpuCloneRunOptions,
  DockerGpuPatchDeps,
  DockerGpuPatchFailureContext,
  DockerGpuPatchMode,
  DockerGpuPatchResult,
} from "./docker-gpu-patch";
import {
  reconcileSupervisorReconnect,
  rollbackDockerGpuPatchOnRecreateFailure,
} from "./docker-gpu-patch-finalize";
import { selectDockerGpuPatchMode } from "./docker-gpu-patch-mode";
import { waitForOpenShellSupervisorReconnect } from "./docker-gpu-supervisor-reconnect";
import { findOpenShellDockerSandboxContainerIds } from "./openshell-docker-sandbox-containers";

const OPENSHELL_SANDBOX_COMMAND_ENV = "OPENSHELL_SANDBOX_COMMAND";
const DOCKER_GPU_PATCH_TIMEOUT_MS = 30_000;
const DOCKER_GPU_PATCH_WAIT_SECS = 180;
const MAX_DOCKER_CONTAINER_NAME_LENGTH = 253;
const GPU_ENV_KEYS = new Set([
  "NVIDIA_VISIBLE_DEVICES",
  "NVIDIA_DRIVER_CAPABILITIES",
  "NVIDIA_REQUIRE_CUDA",
  "NVIDIA_DISABLE_REQUIRE",
]);

export const DOCKER_GPU_PATCH_NETWORK_ENV = "NEMOCLAW_DOCKER_GPU_PATCH_NETWORK";

type RecreateDeps = Required<
  Pick<
    DockerGpuPatchDeps,
    | "dockerCapture"
    | "dockerRun"
    | "dockerRunDetached"
    | "dockerRename"
    | "dockerRm"
    | "dockerStop"
    | "sleep"
    | "now"
    | "detectSandboxFallbackDns"
    | "detectTegraDeviceGroupGids"
  >
> &
  DockerGpuPatchDeps;

function recreateDeps(deps: DockerGpuPatchDeps): RecreateDeps {
  return {
    dockerCapture,
    dockerRun,
    dockerRunDetached,
    dockerRename,
    dockerRm,
    dockerStop,
    sleep: (seconds: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
    },
    now: () => new Date(),
    detectSandboxFallbackDns: () => detectSandboxFallbackDns(),
    detectTegraDeviceGroupGids: () => detectTegraDeviceGroupGids(),
    ...deps,
  };
}

const TEGRA_GPU_DEVICE_NODES = [
  "/dev/nvmap",
  "/dev/nvhost-ctrl",
  "/dev/nvhost-ctrl-gpu",
  "/dev/nvhost-gpu",
  "/dev/nvhost-as-gpu",
  "/dev/nvhost-prof-gpu",
  "/dev/nvhost-dbg-gpu",
  "/dev/nvhost-tsg-gpu",
  "/dev/nvgpu/igpu0/ctrl",
  "/dev/nvgpu/igpu0/as",
  "/dev/nvgpu/igpu0/prof",
] as const;

export function detectTegraDeviceGroupGids(
  deps: { statDeviceGid?: (path: string) => number | null } = {},
): string[] {
  const statGid =
    deps.statDeviceGid ??
    ((path: string): number | null => {
      try {
        return fs.statSync(path).gid;
      } catch {
        return null;
      }
    });
  const gids = new Set<string>();
  for (const node of TEGRA_GPU_DEVICE_NODES) {
    const gid = statGid(node);
    if (gid !== null && gid > 0) gids.add(String(gid));
  }
  return [...gids].sort((left, right) => Number(left) - Number(right));
}

function resultText(
  result: {
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
  } | null,
): string {
  if (!result) return "";
  return `${String(result.stderr || "")} ${String(result.stdout || "")}`.trim();
}

function isZeroStatus(result: { status?: number | null } | null | undefined): boolean {
  return result?.status === 0;
}

function dockerContainerName(inspect: DockerContainerInspect): string {
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

function openshellSandboxCommandEnvValue(
  command: readonly string[] | null | undefined,
): string | null {
  const parts = (command || []).map((part) => String(part));
  if (parts.length === 0) return null;
  if (parts.some((part) => part.length === 0 || /[\s\u0085]/u.test(part))) {
    throw new Error(
      "OpenShell sandbox startup command tokens cannot be empty or contain whitespace.",
    );
  }
  return parts.join(" ");
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
  const hostEndpoint = endpoint ? dockerGpuHostEndpointFromOpenShellEndpoint(endpoint) : null;
  return hostEndpoint ? { networkMode: "host", openshellEndpoint: hostEndpoint } : {};
}

function parseResolvConfNameservers(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nameserver"))
    .map((line) => line.split(/\s+/)[1])
    .filter((ip): ip is string => Boolean(ip));
}

export function detectSandboxFallbackDns(
  deps: { readFile?: (path: string) => string | null } = {},
): string | null {
  const readFile =
    deps.readFile ??
    ((path: string): string | null => {
      try {
        return fs.readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    });
  const resolvConf = readFile("/etc/resolv.conf");
  if (!resolvConf) return null;
  const nameservers = parseResolvConfNameservers(resolvConf);
  if (nameservers.length === 0 || !nameservers.every((ip) => /^127\./.test(ip))) return null;
  const upstreamFile = readFile("/run/systemd/resolve/resolv.conf");
  return upstreamFile
    ? (parseResolvConfNameservers(upstreamFile).find((ip) => !/^127\./.test(ip)) ?? null)
    : null;
}

export function getDockerGpuPatchNetworkMode(
  env: Record<string, string | undefined> = process.env,
): "host" | "preserve" {
  const networkOverride = String(env[DOCKER_GPU_PATCH_NETWORK_ENV] || "")
    .trim()
    .toLowerCase();
  return networkOverride === "host" ? "host" : "preserve";
}

function sameContainerId(
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
  const image = String(config.Image || "").trim();
  if (!image) throw new Error("Docker inspect output did not include Config.Image.");

  const args: string[] = ["--name", dockerContainerName(inspect), ...mode.args];
  pushStringFlag(args, "--hostname", config.Hostname);
  pushStringFlag(args, "--user", config.User);
  pushStringFlag(args, "--workdir", config.WorkingDir);
  if (config.Tty) args.push("--tty");
  if (config.OpenStdin) args.push("--interactive");

  const sandboxCommand = openshellSandboxCommandEnvValue(options.openshellSandboxCommand);
  let sawSandboxCommand = false;
  for (const env of stringArray(config.Env).filter((entry) => !GPU_ENV_KEYS.has(envKey(entry)))) {
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
  capAdd.add("SYS_PTRACE");
  for (const cap of capAdd) args.push("--cap-add", cap);
  for (const cap of stringArray(host.CapDrop)) args.push("--cap-drop", cap);
  const securityOpt = new Set(stringArray(host.SecurityOpt));
  if (![...securityOpt].some((entry) => entry.startsWith("apparmor"))) {
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

function inspectDockerContainer(
  containerId: string,
  deps: DockerGpuPatchDeps,
): DockerContainerInspect {
  const capture = deps.dockerCapture ?? dockerCapture;
  const output = capture(["inspect", "--type", "container", containerId], {
    ignoreError: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  });
  return parseDockerInspectJson(output);
}

function buildBackupContainerName(originalName: string, now: Date): string {
  const suffix = `-nemoclaw-gpu-backup-${String(now.getTime())}`;
  const maxOriginalLength = MAX_DOCKER_CONTAINER_NAME_LENGTH - suffix.length;
  return `${originalName.slice(0, Math.max(1, maxOriginalLength))}${suffix}`;
}

function waitForNewContainerId(
  sandboxName: string,
  oldContainerId: string,
  timeoutSecs: number,
  deps: DockerGpuPatchDeps,
): string | null {
  const d = recreateDeps(deps);
  const deadline = Date.now() + Math.max(1, timeoutSecs) * 1000;
  while (Date.now() <= deadline) {
    const replacement = findOpenShellDockerSandboxContainerIds(sandboxName, deps).find(
      (id) => !sameContainerId(id, oldContainerId),
    );
    if (replacement) return replacement;
    d.sleep(2);
  }
  return null;
}

function decoratePatchError<T extends Error>(
  error: T,
  context: DockerGpuPatchFailureContext,
): T & { dockerGpuPatch?: DockerGpuPatchFailureContext } {
  (error as T & { dockerGpuPatch?: DockerGpuPatchFailureContext }).dockerGpuPatch = context;
  return error;
}

export function getDockerGpuPatchFailureContext(
  error: unknown,
): DockerGpuPatchFailureContext | null {
  if (error && typeof error === "object" && "dockerGpuPatch" in error) {
    return (error as { dockerGpuPatch?: DockerGpuPatchFailureContext }).dockerGpuPatch || null;
  }
  return null;
}

export function recreateOpenShellDockerSandboxWithGpu(
  options: {
    sandboxName: string;
    gpuDevice?: string | null;
    timeoutSecs?: number;
    waitForSupervisor?: boolean;
    openshellSandboxCommand?: readonly string[] | null;
    backend?: "generic" | "jetson";
    dockerDesktopWsl?: boolean;
  },
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchResult {
  const d = recreateDeps(deps);
  const context: DockerGpuPatchFailureContext = {
    sandboxName: options.sandboxName,
    modeAttempts: [],
  };
  try {
    const oldContainerId = findOpenShellDockerSandboxContainerIds(options.sandboxName, deps)[0];
    if (!oldContainerId) {
      throw new Error(
        `Could not find OpenShell Docker container for sandbox '${options.sandboxName}'.`,
      );
    }
    context.oldContainerId = oldContainerId;
    const inspect = inspectDockerContainer(oldContainerId, deps);
    const image = String(inspect.Config?.Image || "").trim();
    if (!image) throw new Error("OpenShell sandbox container inspect did not include an image.");

    const selection = selectDockerGpuPatchMode(
      {
        image,
        device: options.gpuDevice,
        backend: options.backend,
        dockerDesktopWsl: options.dockerDesktopWsl,
      },
      deps,
    );
    context.modeAttempts = selection.attempts;
    context.selectedMode = selection.mode;
    if (!selection.mode) {
      throw new Error(
        options.backend === "jetson"
          ? "Docker did not accept the Jetson NVIDIA runtime GPU mode."
          : "Docker did not accept --gpus, NVIDIA runtime, or CDI GPU modes.",
      );
    }

    const originalName = dockerContainerName(inspect);
    const backupContainerName = buildBackupContainerName(originalName, d.now());
    context.backupContainerName = backupContainerName;
    const cloneOptions = buildDockerGpuCloneRunOptions(inspect);
    cloneOptions.openshellSandboxCommand = options.openshellSandboxCommand ?? null;
    const sandboxFallbackDns = d.detectSandboxFallbackDns();
    if (sandboxFallbackDns) cloneOptions.sandboxFallbackDns = sandboxFallbackDns;
    if (options.backend === "jetson") {
      const tegraGroupGids = d.detectTegraDeviceGroupGids();
      if (tegraGroupGids.length > 0) {
        cloneOptions.extraGroupGids = tegraGroupGids;
        console.log(
          `  ✓ Granting sandbox user access to Jetson Tegra GPU device nodes via --group-add ${tegraGroupGids.join(
            ", ",
          )} (so CUDA can open /dev/nvmap)`,
        );
      } else {
        console.warn(
          "  ⚠ Could not resolve the group owning Jetson Tegra GPU device nodes (/dev/nvmap); CUDA may fail with NvRmMemInitNvmap permission denied. Confirm /dev/nvmap exists and is group-readable on the host.",
        );
      }
    }
    const cloneArgs = buildDockerGpuCloneRunArgs(inspect, selection.mode, cloneOptions);

    d.dockerStop(oldContainerId, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    const renameResult = d.dockerRename(oldContainerId, backupContainerName, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (!isZeroStatus(renameResult)) {
      throw new Error(
        `Could not move original sandbox container aside: ${resultText(renameResult)}`,
      );
    }

    const runResult = d.dockerRunDetached(cloneArgs, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (!isZeroStatus(runResult)) {
      context.rolledBack = rollbackDockerGpuPatchOnRecreateFailure(
        { newContainerId: originalName, backupContainerName, originalName },
        deps,
      );
      throw new Error(
        `Could not start GPU-enabled sandbox container: ${resultText(runResult)}; ${
          context.rolledBack
            ? "pre-patch sandbox restored"
            : "rollback failed; pre-patch sandbox was NOT restored"
        }`,
      );
    }

    const newContainerId =
      String(runResult.stdout || "").trim() ||
      waitForNewContainerId(
        options.sandboxName,
        oldContainerId,
        options.timeoutSecs ?? DOCKER_GPU_PATCH_WAIT_SECS,
        deps,
      );
    if (!newContainerId) {
      throw new Error("GPU-enabled sandbox container started, but Docker did not report its ID.");
    }
    context.newContainerId = newContainerId;
    const selectedMode = selection.mode;
    const result = (backupRemoved: boolean): DockerGpuPatchResult => ({
      applied: true,
      oldContainerId,
      newContainerId,
      originalName,
      backupContainerName,
      mode: selectedMode,
      backupRemoved,
    });
    if (options.waitForSupervisor === false) return result(false);

    const execReady = waitForOpenShellSupervisorReconnect(
      options.sandboxName,
      options.timeoutSecs ?? DOCKER_GPU_PATCH_WAIT_SECS,
      deps,
    );
    const reconcile = reconcileSupervisorReconnect(
      execReady,
      { newContainerId, backupContainerName, originalName },
      deps,
    );
    if (!reconcile.execReady) {
      context.rolledBack = reconcile.rolledBack;
      throw reconcile.error;
    }
    return result(reconcile.backupRemoved);
  } catch (error) {
    throw decoratePatchError(error instanceof Error ? error : new Error(String(error)), context);
  }
}
