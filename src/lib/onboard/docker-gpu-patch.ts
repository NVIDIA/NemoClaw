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
import { reconcileSupervisorReconnect } from "./docker-gpu-patch-finalize";
import {
  DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE_ENV,
  DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT_ENV,
  type DockerGpuSupervisorReconnectDeps,
  getDockerGpuSupervisorReconnectErrorDebouncePolls,
  getDockerGpuSupervisorReconnectTimeoutSecs,
  waitForOpenShellSupervisorReconnect,
} from "./docker-gpu-supervisor-reconnect";

export type { DockerGpuSupervisorReconnectDeps };
export {
  DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE_ENV,
  DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT_ENV,
  getDockerGpuSupervisorReconnectErrorDebouncePolls,
  getDockerGpuSupervisorReconnectTimeoutSecs,
  waitForOpenShellSupervisorReconnect,
};

export const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
export const OPENSHELL_MANAGED_BY_VALUE = "openshell";
export const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
const OPENSHELL_SANDBOX_COMMAND_ENV = "OPENSHELL_SANDBOX_COMMAND";

const DOCKER_GPU_PATCH_TIMEOUT_MS = 30_000;
const DOCKER_GPU_PATCH_WAIT_SECS = 180;
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
  dockerStart?: DockerContainerFn;
  dockerStop?: DockerContainerFn;
  dockerLogs?: DockerLogsFn;
  runOpenshell?: (args: string[], opts?: Record<string, unknown>) => DockerRunResult;
  runCaptureOpenshell?: (args: string[], opts?: Record<string, unknown>) => string;
  sleep?: (seconds: number) => void;
  homedir?: () => string;
  now?: () => Date;
  detectSandboxFallbackDns?: () => string | null;
  /**
   * Resolve the host group ID(s) that own the Jetson/Tegra GPU device nodes
   * (`/dev/nvmap`, `/dev/nvhost-*`). Used by the Jetson recreate to grant the
   * sandbox user matching `--group-add` membership so CUDA can open them
   * (#4231). Injectable so the Jetson permission path is testable without
   * Tegra hardware.
   */
  detectTegraDeviceGroupGids?: () => string[];
  /** Injectable directory lister for unit testing CDI spec discovery. */
  readDir?: (dirPath: string) => string[] | null;
  /** Injectable file reader for unit testing CDI spec content checks. */
  readFile?: (filePath: string) => string | null;
  /**
   * Forwarded to the supervisor-reconnect wait. See
   * `DockerGpuSupervisorReconnectDeps.errorPhaseDebouncePolls`.
   */
  errorPhaseDebouncePolls?: number;
};

export type DockerGpuPatchModeKind = "gpus" | "nvidia-runtime" | "cdi";
export type DockerGpuPatchBackend = "generic" | "jetson";

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
  rolledBack?: boolean;
};

export type DockerGpuPatchResult = {
  applied: true;
  oldContainerId: string;
  newContainerId: string;
  originalName: string;
  backupContainerName: string;
  mode: DockerGpuPatchMode;
  // True when the patch path also confirmed supervisor reconnect AND removed
  // the backup container. False when the caller deferred the reconnect wait
  // (via `waitForSupervisor: false`); the backup is still in place and the
  // caller is responsible for calling `finalizeDockerGpuPatchBackup` after
  // its own supervisor wait completes.
  backupRemoved: boolean;
};

export type DockerGpuCloneRunOptions = {
  networkMode?: string | null;
  openshellEndpoint?: string | null;
  sandboxFallbackDns?: string | null;
  openshellSandboxCommand?: readonly string[] | null;
  /**
   * Extra supplementary group IDs to add to the recreated container via
   * `--group-add`. On Jetson these are the host group(s) owning the Tegra GPU
   * device nodes (`/dev/nvmap`, `/dev/nvhost-*`); granting the sandbox user
   * membership lets CUDA's nvmap init open them instead of failing with
   * `NvRmMemInitNvmap ... Permission denied` (#4231).
   */
  extraGroupGids?: readonly string[] | null;
};

export type DockerGpuPatchDiagnostics = {
  dir: string;
  cleanupCommands: string[];
  summaryLines: string[];
};

/**
 * Subset of `docker inspect --format '{{json .State}}'` fields surfaced when
 * the patched GPU sandbox container fails to become executable. We capture
 * just the runtime/exit/health state — not the full inspect — because that
 * is what tells the user *why* the patched create option broke (e.g. a
 * non-zero ExitCode with `Error: "could not select device driver"`).
 */
export type DockerContainerState = {
  Status?: string;
  Running?: boolean;
  Paused?: boolean;
  Restarting?: boolean;
  OOMKilled?: boolean;
  Dead?: boolean;
  ExitCode?: number;
  Error?: string;
  StartedAt?: string;
  FinishedAt?: string;
  Health?: { Status?: string; FailingStreak?: number } | null;
};

/**
 * Snapshot of "is the patched sandbox even runnable?" — sandbox phase from
 * OpenShell plus the patched Docker container's State. This is the data the
 * caller needs to tell the user whether the failure is at the OpenShell
 * sandbox layer (Error phase) vs. the Docker container layer (non-zero exit
 * with a driver/runtime error) — see #4316.
 */
export type DockerGpuPatchSandboxSnapshot = {
  sandboxPhase: string | null;
  sandboxListLine: string | null;
  patchedContainerState: DockerContainerState | null;
};

export type DockerGpuPatchFailureKind =
  | "patched_container_failed"
  | "sandbox_error_phase"
  | "supervisor_unreachable"
  | "proof_failure"
  | "unknown";

export type DockerGpuPatchFailureClassification = {
  kind: DockerGpuPatchFailureKind;
  headline: string;
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
    ReadonlyPaths?: string[] | null;
    MaskedPaths?: string[] | null;
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

function depsWithDefaults(
  deps: DockerGpuPatchDeps,
): Required<
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
    | "detectSandboxFallbackDns"
    | "detectTegraDeviceGroupGids"
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
    detectSandboxFallbackDns: () => detectSandboxFallbackDns(),
    detectTegraDeviceGroupGids: () => detectTegraDeviceGroupGids(),
    ...deps,
  };
}

// Jetson/Tegra device nodes that CUDA opens during driver initialization.
// `/dev/nvmap` is the memory manager whose `NvRmMemInitNvmap` failure the
// reporter hit (#4231); the `nvhost-*`/`nvgpu` nodes are the compute/control
// channels. On L4T these are owned by a non-root group (typically `video`,
// mode `crw-rw----`).
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

/**
 * Resolve the host group ID(s) that own the Jetson/Tegra GPU device nodes.
 *
 * The NVIDIA Container Runtime bind-mounts these nodes into the sandbox
 * preserving the host's numeric owner/group, but the OpenShell sandbox runs
 * the agent as an unprivileged user that is not a member of that group — so
 * CUDA's nvmap init fails with `Permission denied` and `cuInit(0)` returns 999
 * even though the devices are present (#4231). Returning the owning GID(s)
 * lets the recreate grant the sandbox user matching `--group-add` membership.
 *
 * Numeric GIDs (not group names) are returned on purpose: the sandbox image's
 * group database need not define a `video`/`render` group at the host's GID,
 * and `docker run --group-add <gid>` adds the supplementary group by ID
 * regardless of whether a matching name exists inside the container.
 */
export function detectTegraDeviceGroupGids(
  deps: { statDeviceGid?: (path: string) => number | null } = {},
): string[] {
  const statGid =
    deps.statDeviceGid ??
    ((p: string): number | null => {
      try {
        return fs.statSync(p).gid;
      } catch {
        return null;
      }
    });
  const gids = new Set<string>();
  for (const node of TEGRA_GPU_DEVICE_NODES) {
    const gid = statGid(node);
    // Skip missing nodes and root-owned (gid 0) nodes: `--group-add 0` would
    // not help an unprivileged user, and root already has access regardless.
    if (gid !== null && gid > 0) gids.add(String(gid));
  }
  return [...gids].sort((a, b) => Number(a) - Number(b));
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

function openshellSandboxCommandEnvValue(
  command: readonly string[] | null | undefined,
): string | null {
  const parts = (command || []).map((part) => String(part)).filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
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
  if (
    String(device || "")
      .trim()
      .startsWith("nvidia.com/gpu=")
  ) {
    return String(device).trim();
  }
  return `nvidia.com/gpu=${dockerDevice || "all"}`;
}

export function buildDockerGpuMode(
  kind: DockerGpuPatchModeKind,
  device?: string | null,
  options: { backend?: DockerGpuPatchBackend } = {},
): DockerGpuPatchMode {
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
    const args = ["--runtime", "nvidia", "--env", `NVIDIA_VISIBLE_DEVICES=${dockerDevice}`];
    if (options.backend === "jetson") {
      args.push("--env", "NVIDIA_DRIVER_CAPABILITIES=compute,utility");
    }
    return {
      kind,
      label: `--runtime nvidia (NVIDIA_VISIBLE_DEVICES=${dockerDevice})`,
      device: dockerDevice,
      args,
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
  options: { cdiAvailable?: boolean; backend?: DockerGpuPatchBackend } = {},
): DockerGpuPatchMode[] {
  if (options.backend === "jetson") {
    return [buildDockerGpuMode("nvidia-runtime", device, { backend: "jetson" })];
  }
  // When the host advertises an NVIDIA CDI spec, prefer the CDI mode
  // (`--device nvidia.com/gpu=all`) ahead of --gpus. OpenShell's gateway owns
  // supervisor GPU injection and wires Docker-CDI hosts from that spec; this
  // NemoClaw patch only chooses the recreate mode while matching that source
  // boundary. On Docker-CDI hosts `docker create --gpus all` is accepted (the
  // create-only probe passes), but the legacy --gpus injection diverges from
  // gateway wiring and the supervisor never reconnects (#4948). Keep --gpus
  // and the NVIDIA runtime as fallbacks until OpenShell exposes an
  // authoritative GPU mode contract that can replace CDI-spec probing.
  const candidates: DockerGpuPatchMode[] = [];
  if (options.cdiAvailable) candidates.push(buildDockerGpuMode("cdi", device));
  candidates.push(buildDockerGpuMode("gpus", device), buildDockerGpuMode("nvidia-runtime", device));
  return candidates;
}

export function shouldApplyDockerGpuPatch(
  config: { sandboxGpuEnabled: boolean },
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    dockerDriverGateway?: boolean;
    dockerDesktopWsl?: boolean;
    log?: (message: string) => void;
  } = {},
): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dockerDriverGateway = options.dockerDriverGateway ?? platform === "linux";
  if (!(config.sandboxGpuEnabled && platform === "linux" && dockerDriverGateway)) {
    return false;
  }
  const optedOut = String(env.NEMOCLAW_DOCKER_GPU_PATCH || "").trim() === "0";
  if (optedOut && options.dockerDesktopWsl) {
    const log = options.log ?? ((message: string) => console.warn(message));
    log(
      "  NEMOCLAW_DOCKER_GPU_PATCH=0 ignored on Docker Desktop WSL: GPU passthrough on this runtime requires the patch.",
    );
    log("  Skip GPU passthrough entirely with --no-gpu or NEMOCLAW_SANDBOX_GPU=0.");
    return true;
  }
  return !optedOut;
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

function parseResolvConfNameservers(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nameserver"))
    .map((line) => line.split(/\s+/)[1])
    .filter((ip): ip is string => Boolean(ip));
}

// #3579: when the host's /etc/resolv.conf points only at 127.0.0.x (e.g.
// 127.0.0.53 from systemd-resolved), a sandbox in its own network namespace
// can't reach that resolver — systemd-resolved listens in the host namespace
// only. Return the first non-loopback nameserver from
// /run/systemd/resolve/resolv.conf so the caller can inject it via --dns
// rather than relying on inherited /etc/resolv.conf.
export function detectSandboxFallbackDns(
  deps: { readFile?: (path: string) => string | null } = {},
): string | null {
  const readFile =
    deps.readFile ??
    ((p: string): string | null => {
      try {
        return fs.readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    });
  const resolvConf = readFile("/etc/resolv.conf");
  if (!resolvConf) return null;
  const nameservers = parseResolvConfNameservers(resolvConf);
  if (nameservers.length === 0) return null;
  if (!nameservers.every((ip) => /^127\./.test(ip))) return null;
  const upstreamFile = readFile("/run/systemd/resolve/resolv.conf");
  if (!upstreamFile) return null;
  return parseResolvConfNameservers(upstreamFile).find((ip) => !/^127\./.test(ip)) ?? null;
}

export function getDockerGpuPatchNetworkMode(
  env: Record<string, string | undefined> = process.env,
): "host" | "preserve" {
  const networkOverride = String(env[DOCKER_GPU_PATCH_NETWORK_ENV] || "")
    .trim()
    .toLowerCase();
  if (networkOverride === "host") return "host";
  if (networkOverride === "preserve" || networkOverride === "bridge") return "preserve";
  return "preserve";
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

  const openshellSandboxCommandEnv = openshellSandboxCommandEnvValue(
    options.openshellSandboxCommand,
  );
  let sawOpenShellSandboxCommandEnv = false;
  for (const env of stringArray(config.Env).filter((entry) => !GPU_ENV_KEYS.has(envKey(entry)))) {
    const key = envKey(env);
    if (key === OPENSHELL_SANDBOX_COMMAND_ENV && openshellSandboxCommandEnv) {
      sawOpenShellSandboxCommandEnv = true;
      args.push("--env", `${OPENSHELL_SANDBOX_COMMAND_ENV}=${openshellSandboxCommandEnv}`);
      continue;
    }
    args.push("--env", replaceEnvValue(env, "OPENSHELL_ENDPOINT", options.openshellEndpoint));
  }
  if (openshellSandboxCommandEnv && !sawOpenShellSandboxCommandEnv) {
    args.push("--env", `${OPENSHELL_SANDBOX_COMMAND_ENV}=${openshellSandboxCommandEnv}`);
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
  // --add-host writes to the container's /etc/hosts (mount namespace), not
  // the network stack, so OpenShell's host.openshell.internal mapping must
  // survive even when the caller explicitly opts into --network=host via
  // NEMOCLAW_DOCKER_GPU_PATCH_NETWORK=host (#3562, #3568).
  for (const hostEntry of stringArray(host.ExtraHosts)) args.push("--add-host", hostEntry);
  const groupAdds = new Set(stringArray(host.GroupAdd));
  for (const group of groupAdds) args.push("--group-add", group);
  // Jetson/Tegra: grant the sandbox user membership in the host group(s) that
  // own /dev/nvmap and the nvhost device nodes so CUDA's nvmap init can open
  // them. Without this the unprivileged agent user hits EACCES on /dev/nvmap
  // and cuInit(0) returns 999 even though the GPU devices are mounted (#4231).
  // Dedupe against any GroupAdd the baseline container already carried.
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
    // #3579: when the host has only a loopback resolver (systemd-resolved),
    // inject the real upstream so the sandbox doesn't inherit an unreachable
    // 127.0.0.53. Only kicks in if OpenShell didn't already set --dns.
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
  const commandArgs =
    options.openshellSandboxCommand && options.openshellSandboxCommand.length > 0
      ? [...options.openshellSandboxCommand]
      : [...entrypoint.slice(1), ...stringArray(config.Cmd)];
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

function inspectDockerContainer(
  containerId: string,
  deps: DockerGpuPatchDeps,
): DockerContainerInspect {
  const d = depsWithDefaults(deps);
  const output = d.dockerCapture(["inspect", "--type", "container", containerId], {
    ignoreError: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  });
  return parseDockerInspectJson(output);
}

function sameContainerId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
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

/**
 * Docker's well-known default CDI spec directories. Docker reads CDI specs
 * from these paths even when `docker info` reports an empty `CDISpecDirs`
 * (for example, on Docker 29 hosts with `nvidia-container-toolkit` installed
 * but no `/etc/docker/daemon.json`). Scanning them lets us detect that the
 * `cdi` GPU mode is viable when the docker-info detection alone would miss
 * it (NemoClaw issue #3575).
 */
export const DEFAULT_DOCKER_CDI_SPEC_DIRS = ["/etc/cdi", "/var/run/cdi"] as const;

function readCdiSpecContent(
  filePath: string,
  readFile?: (p: string) => string | null,
): string | null {
  if (readFile) return readFile(filePath);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function isLikelyNvidiaCdiSpecFile(
  filePath: string,
  readFile?: (p: string) => string | null,
): boolean {
  if (!/\.(json|ya?ml)$/i.test(filePath)) return false;
  const content = readCdiSpecContent(filePath, readFile);
  if (content === null) return false;
  return /nvidia\.com\/gpu|nvidia-container|libcuda|cuda/i.test(content);
}

function listDirEntries(
  dirPath: string,
  readDir?: (p: string) => string[] | null,
): string[] | null {
  if (readDir) return readDir(dirPath);
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return null;
  }
}

/**
 * Returns the set of directories to scan for CDI specs: those reported by
 * `docker info` (if any), plus Docker's well-known defaults. Deduplicated
 * so a host that surfaces `/etc/cdi` explicitly is not scanned twice.
 */
function resolveCdiScanDirs(reportedDirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const dir of [...reportedDirs, ...DEFAULT_DOCKER_CDI_SPEC_DIRS]) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
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
    // `docker info` failed, but the default CDI dirs may still hold a valid
    // spec (e.g. issue #3575). Continue with the defaults below.
  }
  const reported = parseDockerCdiSpecDirs(raw);
  for (const dir of resolveCdiScanDirs(reported)) {
    const entries = listDirEntries(dir, deps.readDir);
    if (!entries) continue;
    if (entries.some((entry) => isLikelyNvidiaCdiSpecFile(path.join(dir, entry), deps.readFile))) {
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
  options: { image: string; device?: string | null; backend?: DockerGpuPatchBackend },
  deps: DockerGpuPatchDeps = {},
): { mode: DockerGpuPatchMode | null; attempts: DockerGpuPatchModeAttempt[] } {
  const cdiAvailable = options.backend === "jetson" ? false : dockerReportsNvidiaCdiDevices(deps);
  const attempts: DockerGpuPatchModeAttempt[] = [];
  for (const mode of buildDockerGpuModeCandidates(options.device, {
    cdiAvailable,
    backend: options.backend,
  })) {
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
    openshellSandboxCommand?: readonly string[] | null;
    backend?: DockerGpuPatchBackend;
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
      { image, device: options.gpuDevice, backend: options.backend },
      deps,
    );
    context.modeAttempts = selection.attempts;
    context.selectedMode = selection.mode;
    if (!selection.mode) {
      const modeMessage =
        options.backend === "jetson"
          ? "Docker did not accept the Jetson NVIDIA runtime GPU mode."
          : "Docker did not accept --gpus, NVIDIA runtime, or CDI GPU modes.";
      throw new Error(modeMessage);
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
      throw new Error(
        `Could not move original sandbox container aside: ${resultText(renameResult)}`,
      );
    }

    const cloneOptions = buildDockerGpuCloneRunOptions(inspect);
    cloneOptions.openshellSandboxCommand = options.openshellSandboxCommand ?? null;
    const sandboxFallbackDns = d.detectSandboxFallbackDns();
    if (sandboxFallbackDns) cloneOptions.sandboxFallbackDns = sandboxFallbackDns;
    // On Jetson the Tegra GPU device nodes (`/dev/nvmap`, `/dev/nvhost-*`) are
    // owned by a non-root group, but the sandbox user is not a member — so
    // CUDA fails with `NvRmMemInitNvmap ... Permission denied` and `cuInit(0)`
    // returns 999 even though the devices are mounted (#4231). Grant the
    // sandbox user the owning group(s) so CUDA can initialize.
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

    const selectedMode = selection.mode;
    const buildPatchResult = (backupRemoved: boolean): DockerGpuPatchResult => ({
      applied: true,
      oldContainerId,
      newContainerId,
      originalName,
      backupContainerName,
      mode: selectedMode,
      backupRemoved,
    });

    // Deferred: caller will run the supervisor wait and call
    // `finalizeDockerGpuPatchBackup` (success → remove the backup, failure →
    // roll back to it). Removing the backup here would strand the user with
    // a deleted-backup / failed-new sandbox if the deferred reconnect fails.
    if (options.waitForSupervisor === false) return buildPatchResult(false);

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
    return buildPatchResult(reconcile.backupRemoved);
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
    // Forwarded to `recreateOpenShellDockerSandboxWithGpu` so the Jetson
    // backend selects the NVIDIA runtime mode AND grants the Tegra device-node
    // group(s) to the sandbox user (#4231). Without threading this through, the
    // `ensureApplied` fallback path would recreate the container without
    // /dev/nvmap group access.
    backend?: DockerGpuPatchBackend;
    openshellSandboxCommand?: readonly string[] | null;
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

function printDockerGpuPatchClassificationLines(
  classification: DockerGpuPatchFailureClassification | null,
): void {
  if (!classification) return;
  if (classification.headline) console.error(`  ${classification.headline}`);
  for (const line of classification.summaryLines) console.error(`    ${line}`);
}

function patchedContainerIdFromContext(
  context?: DockerGpuPatchFailureContext | null,
): string | null {
  // Snapshot only the newly created GPU-enabled container. Falling back to
  // `oldContainerId` here would inspect the original (or its renamed backup)
  // and mis-attribute its State as the patched container's — see #4316
  // review feedback.
  if (!context) return null;
  return context.newContainerId || null;
}

function snapshotInspectDeps(
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture">,
): Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> {
  // `depsWithDefaults` spreads the caller's `deps`, so passing an explicit
  // `dockerCapture: undefined` would shadow the module's default Docker
  // adapter and disable downstream `docker ps`/`inspect`/`logs` capture.
  // Build the inner deps object with only the keys the caller actually
  // supplied so defaults stay in place.
  const inner: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> = {};
  if (deps.runCaptureOpenshell) inner.runCaptureOpenshell = deps.runCaptureOpenshell;
  if (deps.dockerCapture) inner.dockerCapture = deps.dockerCapture;
  return inner;
}

export function printDockerGpuPatchFailureAndExit(
  sandboxName: string,
  error: unknown,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> & {
    context?: DockerGpuPatchFailureContext | null;
    selectedMode?: DockerGpuPatchMode | null;
  },
): never {
  const context = deps.context || getDockerGpuPatchFailureContext(error) || null;
  const selectedMode = deps.selectedMode || context?.selectedMode || null;
  const inspectDeps = snapshotInspectDeps(deps);
  const snapshot = captureDockerGpuPatchSandboxSnapshot(
    sandboxName,
    { patchedContainerId: patchedContainerIdFromContext(context) },
    inspectDeps,
  );
  const classification = classifyDockerGpuPatchFailure(snapshot, selectedMode);
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    { error, context, selectedMode, snapshot, classification },
    inspectDeps,
  );
  console.error("");
  console.error("  Docker GPU patch failed.");
  if (error instanceof Error && error.message) {
    console.error(`  ${error.message}`);
  }
  printDockerGpuPatchClassificationLines(classification);
  if (diagnostics) {
    console.error(`  Diagnostics saved: ${diagnostics.dir}`);
  }
  console.error("  Escape hatches:");
  console.error(
    "    NEMOCLAW_DOCKER_GPU_PATCH=0  skip this Docker GPU patch (Linux native Docker only; ignored on Docker Desktop WSL where the patch is required).",
  );
  console.error(
    "    NEMOCLAW_SANDBOX_GPU=0      skip GPU passthrough entirely (or rerun with --no-gpu).",
  );
  printDockerGpuPatchCleanup(sandboxName);
  process.exit(1);
}

export function printDockerGpuReadinessFailure(
  sandboxName: string,
  selectedMode: DockerGpuPatchMode | null,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> & {
    context?: DockerGpuPatchFailureContext | null;
  },
): void {
  const context = deps.context ?? null;
  const inspectDeps = snapshotInspectDeps(deps);
  const snapshot = captureDockerGpuPatchSandboxSnapshot(
    sandboxName,
    { patchedContainerId: patchedContainerIdFromContext(context) },
    inspectDeps,
  );
  const classification = classifyDockerGpuPatchFailure(snapshot, selectedMode);
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    { selectedMode, context, snapshot, classification },
    inspectDeps,
  );
  printDockerGpuPatchClassificationLines(classification);
  if (diagnostics) {
    console.error(`  Docker GPU diagnostics saved: ${diagnostics.dir}`);
  }
  printDockerGpuPatchCleanup(sandboxName);
}

export function printDockerGpuProofFailure(
  sandboxName: string,
  error: unknown,
  selectedMode: DockerGpuPatchMode | null,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> & {
    context?: DockerGpuPatchFailureContext | null;
  },
): void {
  const context = deps.context ?? null;
  const inspectDeps = snapshotInspectDeps(deps);
  const snapshot = captureDockerGpuPatchSandboxSnapshot(
    sandboxName,
    { patchedContainerId: patchedContainerIdFromContext(context) },
    inspectDeps,
  );
  const classification = classifyDockerGpuPatchFailure(snapshot, selectedMode, {
    proofError: error,
  });
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    { error, selectedMode, context, snapshot, classification },
    inspectDeps,
  );
  printDockerGpuPatchClassificationLines(classification);
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

const SANDBOX_FAILURE_PHASE_TOKENS = new Set(["Error", "Failed", "CrashLoopBackOff"]);

const SANDBOX_LIVE_PHASE_TOKENS = new Set(["Ready", "Running"]);

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function parseSandboxRowForName(output: string, sandboxName: string): string[] | null {
  if (typeof output !== "string") return null;
  for (const line of stripAnsi(output).split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === sandboxName) return cols;
  }
  return null;
}

function findSandboxListLine(output: string, sandboxName: string): string | null {
  if (typeof output !== "string") return null;
  for (const line of stripAnsi(output).split("\n")) {
    if (line.trim().split(/\s+/)[0] === sandboxName) return line.trim();
  }
  return null;
}

function parseSandboxPhaseFromGetOutput(output: string): string | null {
  if (typeof output !== "string") return null;
  const match = stripAnsi(output).match(/^\s*Phase:\s+(\S+)/m);
  return match ? match[1] : null;
}

function parseSandboxPhaseFromListOutput(output: string, sandboxName: string): string | null {
  const cols = parseSandboxRowForName(output, sandboxName);
  if (!cols) return null;
  return (
    cols.find((col) => SANDBOX_FAILURE_PHASE_TOKENS.has(col)) ??
    cols.find((col) => SANDBOX_LIVE_PHASE_TOKENS.has(col)) ??
    cols[1] ??
    null
  );
}

function isFailurePhase(phase: string | null | undefined): boolean {
  return typeof phase === "string" && SANDBOX_FAILURE_PHASE_TOKENS.has(phase);
}

function parseDockerContainerState(json: string): DockerContainerState | null {
  if (!json.trim()) return null;
  try {
    const parsed = JSON.parse(json);
    // `docker inspect --format '{{json .State}}'` returns the State object
    // directly; `docker inspect <id>` returns an array of full container
    // descriptors with `.State` nested. Accept both shapes.
    if (parsed && typeof parsed === "object") {
      if ("Status" in parsed || "ExitCode" in parsed || "Running" in parsed) {
        return parsed as DockerContainerState;
      }
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first && typeof first === "object" && "State" in first) {
        const state = (first as { State?: unknown }).State;
        if (state && typeof state === "object") return state as DockerContainerState;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Capture the current sandbox phase from OpenShell and the patched
 * container's runtime State from Docker. Either field may be null when the
 * external CLI is unavailable or the named target no longer exists; callers
 * (notably `classifyDockerGpuPatchFailure`) treat null defensively.
 *
 * When `deps.dockerCapture` is not supplied, this helper falls back to the
 * module's default Docker adapter so the patched-container State is still
 * captured in production paths that only thread `runCaptureOpenshell`
 * through (e.g. `applyDockerGpuPatchOrExit`).
 */
export function captureDockerGpuPatchSandboxSnapshot(
  sandboxName: string,
  options: {
    patchedContainerId?: string | null;
  } = {},
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> = {},
): DockerGpuPatchSandboxSnapshot {
  let sandboxPhase: string | null = null;
  let sandboxListLine: string | null = null;
  if (deps.runCaptureOpenshell) {
    try {
      const getOutput = deps.runCaptureOpenshell(["sandbox", "get", sandboxName], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      sandboxPhase = parseSandboxPhaseFromGetOutput(getOutput);
    } catch {
      /* best effort */
    }
    try {
      const listOutput = deps.runCaptureOpenshell(["sandbox", "list"], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      sandboxListLine = findSandboxListLine(listOutput, sandboxName);
      // Prefer the `sandbox list` phase whenever the named row is present.
      // The list row is the operator-facing gateway state and avoids letting
      // a stale `sandbox get` response drive the Docker-GPU failure
      // classification (#4316 CodeRabbit feedback).
      if (sandboxListLine) {
        const listPhase = parseSandboxPhaseFromListOutput(listOutput, sandboxName);
        if (listPhase) sandboxPhase = listPhase;
      }
    } catch {
      /* best effort */
    }
  }

  let patchedContainerState: DockerContainerState | null = null;
  const target = String(options.patchedContainerId || "").trim();
  if (target) {
    const capture = deps.dockerCapture ?? dockerCapture;
    try {
      const stateJson = capture(["inspect", "--format", "{{json .State}}", target], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      patchedContainerState = parseDockerContainerState(stateJson);
    } catch {
      /* best effort */
    }
  }

  return { sandboxPhase, sandboxListLine, patchedContainerState };
}

function describePatchedContainerState(state: DockerContainerState | null): string[] {
  if (!state) return [];
  const lines: string[] = [];
  if (state.Status) lines.push(`patched_container_status=${state.Status}`);
  if (typeof state.ExitCode === "number")
    lines.push(`patched_container_exit_code=${state.ExitCode}`);
  if (state.OOMKilled) lines.push("patched_container_oom_killed=true");
  if (state.Error) lines.push(`patched_container_error=${state.Error}`);
  if (state.Health?.Status) lines.push(`patched_container_health=${state.Health.Status}`);
  if (state.FinishedAt && state.FinishedAt !== "0001-01-01T00:00:00Z") {
    lines.push(`patched_container_finished_at=${state.FinishedAt}`);
  }
  return lines;
}

function patchedContainerLooksFailed(state: DockerContainerState | null): boolean {
  if (!state) return false;
  if (state.Dead === true) return true;
  if (state.OOMKilled === true) return true;
  if (typeof state.ExitCode === "number" && state.ExitCode !== 0) return true;
  if (state.Error && state.Error.length > 0) return true;
  // `exited`/`dead`/`removing` indicate a container that did not stay up.
  // `running` and `restarting` are live states we do not classify as failed.
  if (typeof state.Status === "string") {
    const status = state.Status.toLowerCase();
    if (status === "exited" || status === "dead" || status === "removing") return true;
  }
  return false;
}

/**
 * Turn the snapshot + selected GPU mode into a user-facing classification
 * that distinguishes "the patched container itself died" from "the sandbox
 * never reached a live phase" from "the OpenShell supervisor cannot reach
 * the container" from "the GPU proof itself reported a runtime failure".
 *
 * This is the contract NemoClaw uses to tell users *which* part of the
 * GPU patch path broke — not just "something failed" (#4316).
 */
export function classifyDockerGpuPatchFailure(
  snapshot: DockerGpuPatchSandboxSnapshot,
  selectedMode: DockerGpuPatchMode | null,
  options: { proofError?: unknown } = {},
): DockerGpuPatchFailureClassification {
  const lines: string[] = [];
  if (snapshot.sandboxPhase) lines.push(`sandbox_phase=${snapshot.sandboxPhase}`);
  if (snapshot.sandboxListLine) lines.push(`sandbox_list_row=${snapshot.sandboxListLine}`);
  lines.push(...describePatchedContainerState(snapshot.patchedContainerState));
  if (selectedMode) lines.push(`patched_create_option=${selectedMode.label}`);

  const containerFailed = patchedContainerLooksFailed(snapshot.patchedContainerState);
  const sandboxInErrorPhase = isFailurePhase(snapshot.sandboxPhase);
  const sandboxNotLive =
    !!snapshot.sandboxPhase && !SANDBOX_LIVE_PHASE_TOKENS.has(snapshot.sandboxPhase);

  let kind: DockerGpuPatchFailureKind = "unknown";
  let headline: string;
  if (containerFailed) {
    kind = "patched_container_failed";
    const exit = snapshot.patchedContainerState?.ExitCode;
    const opt = selectedMode ? ` (${selectedMode.label})` : "";
    headline =
      typeof exit === "number" && exit !== 0
        ? `Patched GPU container exited with code ${exit}${opt}.`
        : `Patched GPU container is not running${opt}.`;
  } else if (sandboxInErrorPhase) {
    kind = "sandbox_error_phase";
    headline = `OpenShell sandbox entered ${snapshot.sandboxPhase} phase before the GPU proof could run.`;
  } else if (sandboxNotLive && (snapshot.patchedContainerState || options.proofError)) {
    // Cover the non-live-but-non-terminal case (e.g. Provisioning / NotReady)
    // BEFORE the proof-error branch — a proof failing while the sandbox
    // never reached Ready/Running is really a lifecycle failure, not a
    // proof failure. Classifying it as proof_failure would tell users
    // `nvidia-smi` failed inside an executable sandbox, which is the
    // wrong story (#4316 review feedback).
    //
    // Gate this on evidence that the patched container actually existed
    // (either we inspected its State, or we got far enough to attempt the
    // proof). Otherwise an early patch failure (e.g. mode probes rejected,
    // detached `docker run` failing) would mislabel a still-Provisioning
    // original sandbox as a supervisor reconnect issue.
    kind = "supervisor_unreachable";
    headline = `OpenShell supervisor did not reach Ready (last phase: ${snapshot.sandboxPhase}).`;
  } else if (options.proofError) {
    kind = "proof_failure";
    headline = "GPU proof failed inside an executable sandbox.";
  } else {
    headline = "Docker GPU patch did not complete successfully.";
  }

  if (options.proofError) {
    const proofText =
      options.proofError instanceof Error ? options.proofError.message : String(options.proofError);
    if (proofText) lines.push(`proof_error=${proofText}`);
  }
  return { kind, headline, summaryLines: lines };
}

export function collectDockerGpuPatchDiagnostics(
  sandboxName: string,
  options: {
    error?: unknown;
    context?: DockerGpuPatchFailureContext | null;
    selectedMode?: DockerGpuPatchMode | null;
    snapshot?: DockerGpuPatchSandboxSnapshot | null;
    classification?: DockerGpuPatchFailureClassification | null;
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
  const snapshot = options.snapshot ?? null;
  const classification = options.classification ?? null;
  const summaryLines = [
    `created_at=${now.toISOString()}`,
    `sandbox_name=${sandboxName}`,
    `error=${errorText}`,
    `selected_gpu_mode=${selectedMode?.label ?? "none"}`,
    `old_container_id=${context?.oldContainerId ?? "unknown"}`,
    `new_container_id=${context?.newContainerId ?? "unknown"}`,
    `backup_container_name=${context?.backupContainerName ?? "none"}`,
    `rolled_back=${context?.rolledBack === true ? "yes" : context?.rolledBack === false ? "failed" : "no"}`,
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
  if (classification) {
    summaryLines.push(`failure_kind=${classification.kind}`);
    if (classification.headline) summaryLines.push(`failure_headline=${classification.headline}`);
  }
  if (snapshot) {
    if (snapshot.sandboxPhase) summaryLines.push(`sandbox_phase=${snapshot.sandboxPhase}`);
    if (snapshot.sandboxListLine) summaryLines.push(`sandbox_list_row=${snapshot.sandboxListLine}`);
    summaryLines.push(...describePatchedContainerState(snapshot.patchedContainerState));
  }
  writeTextFile(dir, "summary.txt", summaryLines.join("\n"));
  if (snapshot?.patchedContainerState) {
    writeTextFile(
      dir,
      "patched-container-state.json",
      JSON.stringify(snapshot.patchedContainerState, null, 2),
    );
  }

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
    ...(context
      ? [context.oldContainerId, context.newContainerId, context.backupContainerName]
      : []),
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
