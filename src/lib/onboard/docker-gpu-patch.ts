// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  dockerCapture,
  dockerLogs,
  dockerRename,
  dockerRm,
  dockerRun,
  dockerRunDetached,
  dockerStop,
} from "../adapters/docker";
import { envInt } from "./env";

export const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
export const OPENSHELL_MANAGED_BY_VALUE = "openshell";
export const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

const DOCKER_GPU_PATCH_TIMEOUT_MS = 30_000;
const DOCKER_GPU_PATCH_WAIT_SECS = 180;
const DOCKER_GPU_SUPERVISOR_RECONNECT_MIN_SECS = 900;
export const DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT_ENV =
  "NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT";
export const DOCKER_GPU_PATCH_NETWORK_ENV = "NEMOCLAW_DOCKER_GPU_PATCH_NETWORK";
const MAX_DOCKER_CONTAINER_NAME_LENGTH = 253;
const GPU_ENV_KEYS = new Set([
  "NVIDIA_VISIBLE_DEVICES",
  "NVIDIA_DRIVER_CAPABILITIES",
  "NVIDIA_REQUIRE_CUDA",
  "NVIDIA_DISABLE_REQUIRE",
]);

type DockerRunResult = {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

type DockerRunOptions = Record<string, unknown>;
type DockerCaptureFn = (args: readonly string[], opts?: DockerRunOptions) => string;
type DockerRunFn = (args: readonly string[], opts?: DockerRunOptions) => DockerRunResult;
type DockerContainerFn = (containerName: string, opts?: DockerRunOptions) => DockerRunResult;
type DockerRenameFn = (
  oldContainerName: string,
  newContainerName: string,
  opts?: DockerRunOptions,
) => DockerRunResult;
type DockerLogsFn = (containerName: string, opts?: { tail?: number; timeout?: number }) => string;

export type DockerGpuPatchDeps = {
  dockerCapture?: DockerCaptureFn;
  dockerRun?: DockerRunFn;
  dockerRunDetached?: DockerRunFn;
  dockerRename?: DockerRenameFn;
  dockerRm?: DockerContainerFn;
  dockerStop?: DockerContainerFn;
  dockerLogs?: DockerLogsFn;
  runOpenshell?: (args: string[], opts?: Record<string, unknown>) => DockerRunResult;
  runCaptureOpenshell?: (args: string[], opts?: Record<string, unknown>) => string;
  sleep?: (seconds: number) => void;
  homedir?: () => string;
  now?: () => Date;
};

export type DockerGpuPatchModeKind = "gpus" | "nvidia-runtime" | "cdi";

export type DockerGpuPatchMode = {
  kind: DockerGpuPatchModeKind;
  label: string;
  device: string;
  args: string[];
};

export type DockerGpuPatchModeAttempt = {
  mode: DockerGpuPatchMode;
  ok: boolean;
  error: string | null;
};

export type DockerGpuPatchFailureContext = {
  sandboxName: string;
  oldContainerId?: string | null;
  newContainerId?: string | null;
  backupContainerName?: string | null;
  selectedMode?: DockerGpuPatchMode | null;
  modeAttempts?: DockerGpuPatchModeAttempt[];
};

export type DockerGpuPatchResult = {
  applied: true;
  oldContainerId: string;
  newContainerId: string;
  backupContainerName: string;
  mode: DockerGpuPatchMode;
};

export type DockerGpuCloneRunOptions = {
  networkMode?: string | null;
  openshellEndpoint?: string | null;
};

export type DockerGpuPatchDiagnostics = {
  dir: string;
  cleanupCommands: string[];
  summaryLines: string[];
};

export type DockerContainerInspect = {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    Entrypoint?: string[] | string | null;
    Cmd?: string[] | string | null;
    User?: string;
    WorkingDir?: string;
    Hostname?: string;
    Tty?: boolean;
    OpenStdin?: boolean;
  } | null;
  HostConfig?: {
    Binds?: string[] | null;
    NetworkMode?: string;
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    ExtraHosts?: string[] | null;
    Memory?: number;
    MemoryReservation?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    CpuShares?: number;
    CpuQuota?: number;
    CpuPeriod?: number;
    CpusetCpus?: string;
    CpusetMems?: string;
    Privileged?: boolean;
    Init?: boolean;
    IpcMode?: string;
    PidMode?: string;
    GroupAdd?: string[] | null;
    Dns?: string[] | null;
    DnsSearch?: string[] | null;
    ShmSize?: number;
  } | null;
  NetworkSettings?: {
    Networks?: Record<
      string,
      {
        IPAddress?: string;
        Gateway?: string;
        Aliases?: string[] | null;
      }
    > | null;
  } | null;
};

function depsWithDefaults(deps: DockerGpuPatchDeps): Required<
  Pick<
    DockerGpuPatchDeps,
    | "dockerCapture"
    | "dockerRun"
    | "dockerRunDetached"
    | "dockerRename"
    | "dockerRm"
    | "dockerStop"
    | "dockerLogs"
    | "sleep"
    | "homedir"
    | "now"
  >
> &
  DockerGpuPatchDeps {
  return {
    dockerCapture,
    dockerRun,
    dockerRunDetached,
    dockerRename,
    dockerRm,
    dockerStop,
    dockerLogs,
    sleep: (seconds: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
    },
    homedir: os.homedir,
    now: () => new Date(),
    ...deps,
  };
}

function resultText(result: DockerRunResult | null | undefined): string {
  if (!result) return "";
  return `${String(result.stderr || "")} ${String(result.stdout || "")}`.trim();
}

function isZeroStatus(result: DockerRunResult | null | undefined): boolean {
  return Number(result?.status ?? 0) === 0;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "sandbox";
}

function timestampForPath(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function dockerContainerName(inspect: DockerContainerInspect): string {
  const raw = String(inspect.Name || "").replace(/^\/+/, "").trim();
  if (!raw) throw new Error("Docker inspect output did not include a container name.");
  return raw;
}

function stringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function envKey(env: string): string {
  const idx = env.indexOf("=");
  return idx === -1 ? env : env.slice(0, idx);
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

function normalizeGpuDeviceForDocker(device: string | null | undefined): string {
  const raw = String(device || "").trim();
  if (!raw || raw === "nvidia.com/gpu=all") return "all";
  if (raw.startsWith("nvidia.com/gpu=")) return raw.slice("nvidia.com/gpu=".length) || "all";
  return raw;
}

function normalizeGpuDeviceForCdi(device: string | null | undefined): string {
  const dockerDevice = normalizeGpuDeviceForDocker(device);
  if (String(device || "").trim().startsWith("nvidia.com/gpu=")) {
    return String(device).trim();
  }
  return `nvidia.com/gpu=${dockerDevice || "all"}`;
}

export function buildDockerGpuMode(kind: DockerGpuPatchModeKind, device?: string | null): DockerGpuPatchMode {
  const dockerDevice = normalizeGpuDeviceForDocker(device);
  if (kind === "gpus") {
    const gpuValue = dockerDevice === "all" ? "all" : `device=${dockerDevice}`;
    return {
      kind,
      label: `--gpus ${gpuValue}`,
      device: dockerDevice,
      args: ["--gpus", gpuValue],
    };
  }
  if (kind === "nvidia-runtime") {
    return {
      kind,
      label: `--runtime nvidia (NVIDIA_VISIBLE_DEVICES=${dockerDevice})`,
      device: dockerDevice,
      args: ["--runtime", "nvidia", "--env", `NVIDIA_VISIBLE_DEVICES=${dockerDevice}`],
    };
  }
  const cdiDevice = normalizeGpuDeviceForCdi(device);
  return {
    kind,
    label: `--device ${cdiDevice}`,
    device: cdiDevice,
    args: ["--device", cdiDevice],
  };
}

export function buildDockerGpuModeCandidates(
  device?: string | null,
  options: { cdiAvailable?: boolean } = {},
): DockerGpuPatchMode[] {
  const candidates = [
    buildDockerGpuMode("gpus", device),
    buildDockerGpuMode("nvidia-runtime", device),
  ];
  if (options.cdiAvailable) candidates.push(buildDockerGpuMode("cdi", device));
  return candidates;
}

export function shouldApplyDockerGpuPatch(
  config: { sandboxGpuEnabled: boolean },
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    dockerDriverGateway?: boolean;
  } = {},
): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dockerDriverGateway = options.dockerDriverGateway ?? platform === "linux";
  return (
    config.sandboxGpuEnabled &&
    platform === "linux" &&
    dockerDriverGateway &&
    String(env.NEMOCLAW_DOCKER_GPU_PATCH || "").trim() !== "0"
  );
}

export function buildDockerGpuCloneRunOptions(
  inspect: DockerContainerInspect,
  env: Record<string, string | undefined> = process.env,
): DockerGpuCloneRunOptions {
  if (getDockerGpuPatchNetworkMode(env) !== "host") return {};

  const endpoint = envValue(inspect.Config?.Env, "OPENSHELL_ENDPOINT");
  const hostEndpoint = endpoint ? dockerGpuHostEndpointFromOpenShellEndpoint(endpoint) : null;
  if (!hostEndpoint) return {};
  return { networkMode: "host", openshellEndpoint: hostEndpoint };
}

export function getDockerGpuPatchNetworkMode(
  env: Record<string, string | undefined> = process.env,
): "host" | "preserve" {
  const networkOverride = String(env[DOCKER_GPU_PATCH_NETWORK_ENV] || "").trim().toLowerCase();
  if (networkOverride === "preserve" || networkOverride === "bridge") return "preserve";
  if (networkOverride && networkOverride !== "host") return "preserve";
  return "host";
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

  for (const env of stringArray(config.Env).filter((entry) => !GPU_ENV_KEYS.has(envKey(entry)))) {
    args.push("--env", replaceEnvValue(env, "OPENSHELL_ENDPOINT", options.openshellEndpoint));
  }

  const labels = config.Labels || {};
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value !== undefined && value !== null) args.push("--label", `${key}=${value}`);
  }

  for (const bind of stringArray(host.Binds)) args.push("--volume", bind);
  const networkMode = options.networkMode ?? host.NetworkMode;
  pushStringFlag(args, "--network", networkMode);
  for (const alias of dockerNetworkAliases(inspect, networkMode)) {
    args.push("--network-alias", alias);
  }

  const restart = host.RestartPolicy;
  if (restart?.Name && restart.Name !== "no") {
    const value =
      restart.Name === "on-failure" && restart.MaximumRetryCount
        ? `${restart.Name}:${restart.MaximumRetryCount}`
        : restart.Name;
    args.push("--restart", value);
  }

  // GPU bring-up requires writing to /proc/<pid>/task/<tid>/comm (see
  // PROC_COMM_WRITE_PROBE in initial-policy.ts).  On some Docker/distro
  // baselines, the OpenShell-created container that we inspect here lacks
  // SYS_PTRACE and/or apparmor=unconfined, which the kernel/LSM combination
  // requires for that write.  Augment the recreate flags to make the
  // GPU-capable container self-sufficient for the operations the GPU proof
  // checks, regardless of what the non-GPU baseline happened to set (#3511).
  const capAdd = new Set(stringArray(host.CapAdd));
  capAdd.add("SYS_PTRACE");
  for (const cap of capAdd) args.push("--cap-add", cap);
  for (const cap of stringArray(host.CapDrop)) args.push("--cap-drop", cap);
  const securityOpt = new Set(stringArray(host.SecurityOpt));
  // Only inject apparmor=unconfined when the baseline did not pin a specific
  // apparmor profile.  Docker rejects multiple `--security-opt apparmor=...`
  // entries, and a baseline that explicitly chose `apparmor=docker-default`
  // (or similar) should be respected — we are scoped to the GPU recreate
  // path, not to overriding deliberate operator choices.
  if (![...securityOpt].some((entry) => entry.startsWith("apparmor"))) {
    securityOpt.add("apparmor=unconfined");
  }
  for (const opt of securityOpt) args.push("--security-opt", opt);
  if (networkMode !== "host") {
    for (const hostEntry of stringArray(host.ExtraHosts)) args.push("--add-host", hostEntry);
  }
  for (const group of stringArray(host.GroupAdd)) args.push("--group-add", group);
  if (networkMode !== "host") {
    for (const dns of stringArray(host.Dns)) args.push("--dns", dns);
    for (const dnsSearch of stringArray(host.DnsSearch)) args.push("--dns-search", dnsSearch);
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
  const commandArgs = [...entrypoint.slice(1), ...stringArray(config.Cmd)];
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

export function findOpenShellDockerSandboxContainerIds(
  sandboxName: string,
  deps: DockerGpuPatchDeps = {},
): string[] {
  const d = depsWithDefaults(deps);
  const output = d.dockerCapture(
    [
      "ps",
      "-a",
      "--filter",
      `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
      "--filter",
      `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--format",
      "{{.ID}}",
    ],
    { ignoreError: true, timeout: DOCKER_GPU_PATCH_TIMEOUT_MS },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function inspectDockerContainer(containerId: string, deps: DockerGpuPatchDeps): DockerContainerInspect {
  const d = depsWithDefaults(deps);
  const output = d.dockerCapture(["inspect", "--type", "container", containerId], {
    ignoreError: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  });
  return parseDockerInspectJson(output);
}

function sameContainerId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function parseDockerCdiSpecDirs(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  if (!raw || raw === "<no value>") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
  } catch {
    return raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

function isLikelyNvidiaCdiSpecFile(filePath: string): boolean {
  if (!/\.(json|ya?ml)$/i.test(filePath)) return false;
  try {
    return /nvidia\.com\/gpu|nvidia-container|libcuda|cuda/i.test(
      fs.readFileSync(filePath, "utf-8"),
    );
  } catch {
    return false;
  }
}

export function dockerReportsNvidiaCdiDevices(deps: DockerGpuPatchDeps = {}): boolean {
  const d = depsWithDefaults(deps);
  let raw = "";
  try {
    raw = d.dockerCapture(["info", "--format", "{{json .CDISpecDirs}}"], {
      ignoreError: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
  } catch {
    return false;
  }
  for (const dir of parseDockerCdiSpecDirs(raw)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.some((entry) => isLikelyNvidiaCdiSpecFile(path.join(dir, entry)))) {
      return true;
    }
  }
  return false;
}

function probeDockerGpuMode(
  mode: DockerGpuPatchMode,
  image: string,
  deps: DockerGpuPatchDeps,
): { ok: boolean; error: string | null } {
  const d = depsWithDefaults(deps);
  const probeName = `nemoclaw-gpu-probe-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  try {
    const result = d.dockerRun(["create", "--name", probeName, ...mode.args, image, "true"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    return {
      ok: isZeroStatus(result),
      error: isZeroStatus(result) ? null : resultText(result) || `docker create failed`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    d.dockerRm(probeName, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
  }
}

export function selectDockerGpuPatchMode(
  options: { image: string; device?: string | null },
  deps: DockerGpuPatchDeps = {},
): { mode: DockerGpuPatchMode | null; attempts: DockerGpuPatchModeAttempt[] } {
  const cdiAvailable = dockerReportsNvidiaCdiDevices(deps);
  const attempts: DockerGpuPatchModeAttempt[] = [];
  for (const mode of buildDockerGpuModeCandidates(options.device, { cdiAvailable })) {
    const result = probeDockerGpuMode(mode, options.image, deps);
    const attempt = { mode, ok: result.ok, error: result.error };
    attempts.push(attempt);
    if (attempt.ok) return { mode, attempts };
  }
  return { mode: null, attempts };
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
  const d = depsWithDefaults(deps);
  const deadline = Date.now() + Math.max(1, timeoutSecs) * 1000;
  while (Date.now() <= deadline) {
    const ids = findOpenShellDockerSandboxContainerIds(sandboxName, deps);
    const replacement = ids.find((id) => !sameContainerId(id, oldContainerId));
    if (replacement) return replacement;
    d.sleep(2);
  }
  return null;
}

function waitForOpenShellSandboxExec(
  sandboxName: string,
  timeoutSecs: number,
  deps: DockerGpuPatchDeps,
): boolean {
  if (!deps.runOpenshell) return true;
  const d = depsWithDefaults(deps);
  const deadline = Date.now() + Math.max(1, timeoutSecs) * 1000;
  while (Date.now() <= deadline) {
    const result = deps.runOpenshell(
      ["sandbox", "exec", "-n", sandboxName, "--", "true"],
      { ignoreError: true, suppressOutput: true, timeout: DOCKER_GPU_PATCH_TIMEOUT_MS },
    );
    if (isZeroStatus(result)) return true;
    d.sleep(2);
  }
  return false;
}

export const waitForOpenShellSupervisorReconnect = waitForOpenShellSandboxExec;

export function getDockerGpuSupervisorReconnectTimeoutSecs(
  sandboxReadyTimeoutSecs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const readyTimeoutSecs = Number.isFinite(sandboxReadyTimeoutSecs)
    ? Math.max(1, Math.round(sandboxReadyTimeoutSecs))
    : 1;
  const fallback = Math.max(
    readyTimeoutSecs,
    DOCKER_GPU_SUPERVISOR_RECONNECT_MIN_SECS,
  );
  return Math.max(
    1,
    envInt(DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT_ENV, fallback, env),
  );
}

function decoratePatchError<T extends Error>(
  error: T,
  context: DockerGpuPatchFailureContext,
): T & { dockerGpuPatch?: DockerGpuPatchFailureContext } {
  (error as T & { dockerGpuPatch?: DockerGpuPatchFailureContext }).dockerGpuPatch = context;
  return error as T & { dockerGpuPatch?: DockerGpuPatchFailureContext };
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
  },
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchResult {
  const d = depsWithDefaults(deps);
  const context: DockerGpuPatchFailureContext = {
    sandboxName: options.sandboxName,
    modeAttempts: [],
  };
  try {
    const containerIds = findOpenShellDockerSandboxContainerIds(options.sandboxName, deps);
    const oldContainerId = containerIds[0];
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
      { image, device: options.gpuDevice },
      deps,
    );
    context.modeAttempts = selection.attempts;
    context.selectedMode = selection.mode;
    if (!selection.mode) {
      throw new Error("Docker did not accept --gpus, NVIDIA runtime, or CDI GPU modes.");
    }

    const originalName = dockerContainerName(inspect);
    const backupContainerName = buildBackupContainerName(originalName, d.now());
    context.backupContainerName = backupContainerName;

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
      throw new Error(`Could not move original sandbox container aside: ${resultText(renameResult)}`);
    }

    const cloneOptions = buildDockerGpuCloneRunOptions(inspect);
    const cloneArgs = buildDockerGpuCloneRunArgs(inspect, selection.mode, cloneOptions);
    const runResult = d.dockerRunDetached(cloneArgs, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    if (!isZeroStatus(runResult)) {
      d.dockerRm(originalName, {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      throw new Error(`Could not start GPU-enabled sandbox container: ${resultText(runResult)}`);
    }

    const stdoutId = String(runResult.stdout || "").trim();
    const newContainerId =
      stdoutId ||
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

    d.dockerRm(backupContainerName, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });

    if (options.waitForSupervisor !== false) {
      const execReady = waitForOpenShellSandboxExec(
        options.sandboxName,
        options.timeoutSecs ?? DOCKER_GPU_PATCH_WAIT_SECS,
        deps,
      );
      if (!execReady) {
        throw new Error("OpenShell supervisor did not reconnect to the GPU-enabled container.");
      }
    }

    return {
      applied: true,
      oldContainerId,
      newContainerId,
      backupContainerName,
      mode: selection.mode,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw decoratePatchError(err, context);
  }
}

export function dockerGpuPatchCleanupCommands(sandboxName: string): string[] {
  return [`openshell sandbox delete ${JSON.stringify(sandboxName)}`];
}

function printDockerGpuPatchCleanup(sandboxName: string): void {
  console.error("  The failed sandbox/container has been left in place for inspection.");
  console.error("  Manual cleanup:");
  for (const command of dockerGpuPatchCleanupCommands(sandboxName)) {
    console.error(`    ${command}`);
  }
}

export function applyDockerGpuPatchOrExit(
  options: {
    sandboxName: string;
    gpuDevice?: string | null;
    timeoutSecs: number;
  },
  deps: Pick<DockerGpuPatchDeps, "runOpenshell" | "runCaptureOpenshell" | "sleep">,
): DockerGpuPatchResult {
  console.log("  Recreating OpenShell Docker sandbox container with NVIDIA GPU access...");
  try {
    const result = recreateOpenShellDockerSandboxWithGpu(options, deps);
    console.log(`  ✓ Docker GPU mode selected: ${result.mode.label}`);
    return result;
  } catch (error) {
    printDockerGpuPatchFailureAndExit(options.sandboxName, error, {
      runCaptureOpenshell: deps.runCaptureOpenshell,
    });
  }
}

export function printDockerGpuPatchFailureAndExit(
  sandboxName: string,
  error: unknown,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell"> & {
    context?: DockerGpuPatchFailureContext | null;
    selectedMode?: DockerGpuPatchMode | null;
  },
): never {
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    { error, context: deps.context, selectedMode: deps.selectedMode },
    {
      runCaptureOpenshell: deps.runCaptureOpenshell,
    },
  );
  console.error("");
  console.error("  Docker GPU patch failed.");
  if (error instanceof Error && error.message) {
    console.error(`  ${error.message}`);
  }
  if (diagnostics) {
    console.error(`  Diagnostics saved: ${diagnostics.dir}`);
  }
  console.error("  Escape hatch: set NEMOCLAW_DOCKER_GPU_PATCH=0 to skip this patch.");
  printDockerGpuPatchCleanup(sandboxName);
  process.exit(1);
}

export function printDockerGpuReadinessFailure(
  sandboxName: string,
  selectedMode: DockerGpuPatchMode | null,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell">,
): void {
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    { selectedMode },
    {
      runCaptureOpenshell: deps.runCaptureOpenshell,
    },
  );
  if (diagnostics) {
    console.error(`  Docker GPU diagnostics saved: ${diagnostics.dir}`);
  }
  printDockerGpuPatchCleanup(sandboxName);
}

export function printDockerGpuProofFailure(
  sandboxName: string,
  error: unknown,
  selectedMode: DockerGpuPatchMode | null,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell">,
): void {
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    { error, selectedMode },
    {
      runCaptureOpenshell: deps.runCaptureOpenshell,
    },
  );
  if (diagnostics) {
    console.error(`  Diagnostics saved: ${diagnostics.dir}`);
  }
  printDockerGpuPatchCleanup(sandboxName);
}

function writeTextFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content.endsWith("\n") ? content : `${content}\n`, {
    mode: 0o600,
  });
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

const DIAGNOSTIC_ENV_KEYS = new Set([
  "OPENSHELL_ENDPOINT",
  "OPENSHELL_SANDBOX_ID",
  "OPENSHELL_SANDBOX",
  "OPENSHELL_LOG_LEVEL",
  "OPENSHELL_TLS_CA",
  "OPENSHELL_TLS_CERT",
  "OPENSHELL_TLS_KEY",
]);

function diagnosticEnvLines(env: string[] | null | undefined): string[] {
  return stringArray(env)
    .filter((entry) => DIAGNOSTIC_ENV_KEYS.has(envKey(entry)))
    .sort()
    .map((entry) => `  env.${envKey(entry)}=${entry.slice(envKey(entry).length + 1)}`);
}

export function formatDockerInspectNetworkSummary(
  target: string,
  inspect: DockerContainerInspect,
): string {
  const lines = [
    `target=${target}`,
    `id=${inspect.Id ?? "unknown"}`,
    `name=${String(inspect.Name || "").replace(/^\/+/, "") || "unknown"}`,
    `image=${inspect.Config?.Image ?? "unknown"}`,
    `network_mode=${inspect.HostConfig?.NetworkMode ?? "unknown"}`,
  ];
  const extraHosts = stringArray(inspect.HostConfig?.ExtraHosts);
  if (extraHosts.length > 0) {
    lines.push("extra_hosts:");
    for (const entry of extraHosts) lines.push(`  ${entry}`);
  }
  const envLines = diagnosticEnvLines(inspect.Config?.Env);
  if (envLines.length > 0) {
    lines.push("openshell_env:");
    lines.push(...envLines);
  }
  const networks = inspect.NetworkSettings?.Networks || {};
  const names = Object.keys(networks).sort();
  if (names.length > 0) {
    lines.push("networks:");
    for (const name of names) {
      const network = networks[name] || {};
      lines.push(
        `  ${name}: ip=${network.IPAddress || "unknown"} gateway=${network.Gateway || "unknown"}`,
      );
      const aliases = stringArray(network.Aliases);
      if (aliases.length > 0) lines.push(`    aliases=${aliases.join(",")}`);
    }
  }
  return lines.join("\n");
}

export function collectDockerGpuPatchDiagnostics(
  sandboxName: string,
  options: {
    error?: unknown;
    context?: DockerGpuPatchFailureContext | null;
    selectedMode?: DockerGpuPatchMode | null;
  } = {},
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchDiagnostics | null {
  const d = depsWithDefaults(deps);
  const now = d.now();
  const dir = path.join(
    d.homedir(),
    ".nemoclaw",
    "onboard-failures",
    `${timestampForPath(now)}-${sanitizePathPart(sandboxName)}-docker-gpu-patch`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }

  const context = options.context || getDockerGpuPatchFailureContext(options.error) || null;
  const cleanupCommands = dockerGpuPatchCleanupCommands(sandboxName);
  const errorText =
    options.error instanceof Error
      ? options.error.message
      : options.error
        ? String(options.error)
        : "none";
  const selectedMode = options.selectedMode || context?.selectedMode || null;
  const summaryLines = [
    `created_at=${now.toISOString()}`,
    `sandbox_name=${sandboxName}`,
    `error=${errorText}`,
    `selected_gpu_mode=${selectedMode?.label ?? "none"}`,
    `old_container_id=${context?.oldContainerId ?? "unknown"}`,
    `new_container_id=${context?.newContainerId ?? "unknown"}`,
    `backup_container_name=${context?.backupContainerName ?? "none"}`,
    "cleanup_commands:",
    ...cleanupCommands.map((command) => `  ${command}`),
  ];
  if (context?.modeAttempts?.length) {
    summaryLines.push("gpu_mode_attempts:");
    for (const attempt of context.modeAttempts) {
      summaryLines.push(
        `  ${attempt.mode.label}: ${attempt.ok ? "ok" : "failed"}${attempt.error ? `: ${attempt.error}` : ""}`,
      );
    }
  }
  writeTextFile(dir, "summary.txt", summaryLines.join("\n"));

  try {
    const ps = d.dockerCapture(
      [
        "ps",
        "-a",
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      ],
      { ignoreError: true, timeout: DOCKER_GPU_PATCH_TIMEOUT_MS },
    );
    if (ps.trim()) writeTextFile(dir, "docker-ps.txt", ps);
  } catch {
    /* best effort */
  }

  let discoveredContainerIds: string[] = [];
  try {
    discoveredContainerIds = findOpenShellDockerSandboxContainerIds(sandboxName, deps);
  } catch {
    discoveredContainerIds = [];
  }
  const containerTargets = uniqueStrings([
    ...(context ? [context.oldContainerId, context.newContainerId, context.backupContainerName] : []),
    ...discoveredContainerIds,
  ]);
  if (containerTargets.length > 0) {
    const inspectEntries: unknown[] = [];
    const networkSummaries: string[] = [];
    for (const target of containerTargets) {
      try {
        const inspect = d.dockerCapture(["inspect", target], {
          ignoreError: true,
          timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
        });
        if (!inspect.trim()) continue;
        const parsed = JSON.parse(inspect);
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        inspectEntries.push(...entries);
        for (const [index, entry] of entries.entries()) {
          networkSummaries.push(
            formatDockerInspectNetworkSummary(
              entries.length === 1 ? target : `${target}[${index}]`,
              entry,
            ),
          );
        }
      } catch {
        /* best effort */
      }
    }
    if (inspectEntries.length > 0) {
      writeTextFile(dir, "docker-inspect.json", JSON.stringify(inspectEntries, null, 2));
    }
    if (networkSummaries.length > 0) {
      writeTextFile(dir, "docker-network-summary.txt", networkSummaries.join("\n\n"));
    }
    const logs = containerTargets
      .map((target) => {
        try {
          return [`===== ${target} =====`, d.dockerLogs(target, { tail: 120 })].join("\n");
        } catch {
          return `===== ${target} =====\n(unavailable)`;
        }
      })
      .join("\n");
    if (logs.trim()) writeTextFile(dir, "docker-logs.txt", logs);
  }

  if (deps.runCaptureOpenshell) {
    const captures: Array<[string, string[]]> = [
      ["openshell-sandbox-get.txt", ["sandbox", "get", sandboxName]],
      ["openshell-sandbox-list.txt", ["sandbox", "list"]],
      ["openshell-logs.txt", ["doctor", "logs", "--name", "nemoclaw"]],
    ];
    for (const [fileName, args] of captures) {
      try {
        const output = deps.runCaptureOpenshell(args, {
          ignoreError: true,
          timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
        });
        if (output.trim()) writeTextFile(dir, fileName, output);
      } catch {
        /* best effort */
      }
    }
  }

  return { dir, cleanupCommands, summaryLines };
}
