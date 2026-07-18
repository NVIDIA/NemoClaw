// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type DockerRunResult = {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | null;
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

export type DockerGpuPatchModeKind = "gpus" | "nvidia-runtime" | "cdi" | "startup-command";
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

export type DockerUlimit = {
  name: string;
  soft: number;
  hard: number;
};

export type DockerGpuCloneRunOptions = {
  image?: string | null;
  networkMode?: string | null;
  openshellEndpoint?: string | null;
  sandboxFallbackDns?: string | null;
  openshellSandboxCommand?: readonly string[] | null;
  requiredUlimits?: readonly DockerUlimit[] | null;
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
  Image?: string;
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
    Mounts?: Array<{
      Type?: string;
      Source?: string;
      Target?: string;
      ReadOnly?: boolean;
      Consistency?: string;
      BindOptions?: unknown;
      VolumeOptions?: {
        NoCopy?: boolean;
        Labels?: Record<string, string> | null;
        Subpath?: string;
        DriverConfig?: unknown;
      } | null;
      TmpfsOptions?: {
        SizeBytes?: number;
        Mode?: number;
        Options?: string[][] | null;
      } | null;
    }> | null;
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
    Ulimits?: Array<{
      Name?: string;
      Soft?: number;
      Hard?: number;
    }> | null;
    Dns?: string[] | null;
    DnsSearch?: string[] | null;
    DeviceRequests?: Array<{
      Driver?: string;
      DeviceIDs?: string[] | null;
    }> | null;
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
