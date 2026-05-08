// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preflight checks for NemoClaw onboarding: port availability, memory
 * info, and swap management.
 *
 * Every function accepts an opts object for dependency injection so
 * tests can run without real I/O.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { DASHBOARD_PORT } from "./core/ports";

// runner.ts still uses CommonJS-style exports — use require here.
const { runCapture } = require("./runner");

type RunCaptureFn = typeof import("./runner").runCapture;
type RunCaptureOpts = Parameters<RunCaptureFn>[1];
type NullableRunCaptureFn = (
  command: Parameters<RunCaptureFn>[0],
  options?: RunCaptureOpts,
) => string | null;

// ── Types ────────────────────────────────────────────────────────

export interface PortProbeResult {
  ok: boolean;
  warning?: string;
  process?: string;
  pid?: number | null;
  reason?: string;
}

export interface CheckPortOpts {
  /** Inject fake lsof output (skips shell). */
  lsofOutput?: string;
  /** Force the net-probe fallback path. */
  skipLsof?: boolean;
  /** Async probe implementation for testing. */
  probeImpl?: (port: number) => Promise<PortProbeResult>;
}

export interface MemoryInfo {
  totalRamMB: number;
  totalSwapMB: number;
  totalMB: number;
}

export interface GetMemoryInfoOpts {
  /** Inject fake /proc/meminfo content. */
  meminfoContent?: string;
  /** Override process.platform. */
  platform?: NodeJS.Platform;
}

export interface SwapResult {
  ok: boolean;
  totalMB?: number;
  swapCreated?: boolean;
  reason?: string;
}

export interface EnsureSwapOpts {
  /** Override process.platform. */
  platform?: NodeJS.Platform;
  /** Inject mock getMemoryInfo() result. */
  memoryInfo?: MemoryInfo | null;
  /** Whether /swapfile exists (override for testing). */
  swapfileExists?: boolean;
  /** Skip actual swap creation. */
  dryRun?: boolean;
  /** Whether the session is interactive. */
  interactive?: boolean;
  /** Override getMemoryInfo implementation. */
  getMemoryInfoImpl?: (opts: GetMemoryInfoOpts) => MemoryInfo | null;
}

export type ContainerRuntime = "docker" | "docker-desktop" | "colima" | "podman" | "unknown";

export type PackageManager = "apt" | "dnf" | "yum" | "brew" | "pacman" | "unknown";

export type RemediationKind = "info" | "manual" | "auto" | "sudo";

export interface HostAssessment {
  platform: NodeJS.Platform | string;
  isWsl: boolean;
  runtime: ContainerRuntime;
  packageManager?: PackageManager;
  systemctlAvailable?: boolean;
  dockerServiceActive?: boolean | null;
  dockerServiceEnabled?: boolean | null;
  dockerInstalled: boolean;
  dockerRunning: boolean;
  dockerReachable: boolean;
  nodeInstalled: boolean;
  openshellInstalled: boolean;
  dockerInfoSummary?: string;
  dockerCgroupVersion?: "v1" | "v2" | "unknown";
  dockerDefaultCgroupnsMode?: "host" | "private" | "unknown";
  dockerStorageDriver?: string;
  dockerUsesContainerdSnapshotter?: boolean;
  dockerCpus?: number;
  dockerMemTotalBytes?: number;
  isContainerRuntimeUnderProvisioned: boolean;
  hasNestedOverlayConflict: boolean;
  requiresHostCgroupnsFix: boolean;
  isUnsupportedRuntime: boolean;
  isHeadlessLikely: boolean;
  hasNvidiaGpu: boolean;
  dockerCdiSpecDirs: string[];
  cdiNvidiaGpuSpecMissing: boolean;
  notes: string[];
}

export interface RemediationAction {
  id: string;
  title: string;
  kind: RemediationKind;
  reason: string;
  commands: string[];
  blocking: boolean;
}

export interface AssessHostOpts {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
  procVersion?: string;
  dockerInfoOutput?: string;
  dockerInfoError?: string;
  readFileImpl?: (filePath: string, encoding: BufferEncoding) => string;
  readdirImpl?: (dir: string) => string[];
  runCaptureImpl?: RunCaptureFn;
  commandExistsImpl?: (commandName: string) => boolean;
  gpuProbeImpl?: () => boolean;
}

function buildCommandVArgv(commandName: string): readonly string[] {
  return ["sh", "-c", 'command -v "$1"', "--", commandName];
}

function commandExists(commandName: string, runCaptureImpl: RunCaptureFn): boolean {
  try {
    const output = runCaptureImpl(buildCommandVArgv(commandName), { ignoreError: true });
    return Boolean(String(output || "").trim());
  } catch {
    return false;
  }
}

function detectWsl(opts: {
  platform: NodeJS.Platform | string;
  env: NodeJS.ProcessEnv;
  release: string;
  procVersion: string;
}): boolean {
  if (opts.platform !== "linux") return false;

  return (
    Boolean(opts.env.WSL_DISTRO_NAME) ||
    Boolean(opts.env.WSL_INTEROP) ||
    /microsoft/i.test(opts.release) ||
    /microsoft/i.test(opts.procVersion)
  );
}

function inferContainerRuntime(info = ""): ContainerRuntime {
  const normalized = String(info || "").toLowerCase();
  if (!normalized.trim()) return "unknown";
  if (normalized.includes("podman")) return "podman";
  if (normalized.includes("colima")) return "colima";
  if (normalized.includes("docker desktop")) return "docker-desktop";
  if (normalized.includes("docker")) return "docker";
  return "unknown";
}

function parseDockerCgroupVersion(info = ""): "v1" | "v2" | "unknown" {
  if (/"CgroupVersion"\s*:\s*"2"/.test(info) || /CgroupVersion["=: ]+2/i.test(info)) {
    return "v2";
  }
  if (/"CgroupVersion"\s*:\s*"1"/.test(info) || /CgroupVersion["=: ]+1/i.test(info)) {
    return "v1";
  }
  return "unknown";
}

function parseDockerInfoSummary(info = ""): string | undefined {
  const versionMatch = info.match(/"ServerVersion"\s*:\s*"([^"]+)"/);
  const osMatch = info.match(/"OperatingSystem"\s*:\s*"([^"]+)"/);
  const parts = [versionMatch?.[1], osMatch?.[1]].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function parseDockerStorageDriver(info = ""): string | undefined {
  // JSON form (`docker info --format '{{json .}}'`) is the canonical caller
  // path inside this file, but accept the plain-text `Storage Driver: <name>`
  // form too so future callers that pass raw `docker info` don't silently
  // miss the conflict and bypass the auto-fix.
  const jsonMatch = info.match(/"Driver"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  const textMatch = info.match(/^\s*Storage Driver:\s*(\S+)\s*$/m);
  return textMatch?.[1];
}

export function parseDockerUsesContainerdSnapshotter(info = ""): boolean {
  // Docker 26+ defaults fresh installs to the containerd image store, surfaced
  // via `docker info` DriverStatus entries that name the containerd snapshotter
  // v1 plugin. Match either JSON or text form so we handle `--format '{{json
  // .}}'` output and plain `docker info` alike.
  return /io\.containerd\.snapshotter\.v1/.test(info);
}

// Parses the Docker daemon's configured CDI spec directories from `docker
// info --format '{{json .}}'` output. Docker 25+ surfaces these as
// `"CDISpecDirs": ["/etc/cdi", "/var/run/cdi"]` whenever the daemon is built
// with CDI support and `features.cdi=true` (the default on recent installs).
// An empty list means CDI device injection is not enabled, so OpenShell will
// fall back to the legacy `nvidia` runtime path and there is no spec gap to
// worry about.
export function parseDockerCdiSpecDirs(info = ""): string[] {
  const match = info.match(/"CDISpecDirs"\s*:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1]).filter(Boolean);
}

// True when at least one CDI spec under the configured directories declares
// `kind: nvidia.com/gpu` (the device class OpenShell injects with `--gpu`).
// Specs are typically YAML, but the JSON shape is also accepted because
// `nvidia-ctk cdi generate --format=json` is supported. Errors reading any
// individual file or directory are tolerated — a missing dir is the same
// shape as "no spec found there".
function hasNvidiaCdiSpec(
  specDirs: readonly string[],
  readdirImpl: (dir: string) => string[],
  readFileImpl: (filePath: string, encoding: BufferEncoding) => string,
): boolean {
  // YAML keys are unquoted; JSON quotes the kind value. Anchor both patterns
  // to the *exact* device-class string `nvidia.com/gpu` and require a value
  // terminator (end of line, whitespace + comment, or whitespace + EOL) so a
  // sibling spec like `nvidia.com/gpu-extra` does not silently satisfy the
  // check and suppress the preflight warning. A comment that merely mentions
  // `nvidia.com/gpu` is also rejected because `kindRe` only matches when the
  // *whole* scalar value is the device class.
  const kindRe =
    /^[ \t]*kind[ \t]*:[ \t]*(?:"nvidia\.com\/gpu"|'nvidia\.com\/gpu'|nvidia\.com\/gpu)[ \t]*(?:#.*)?$/im;
  const jsonRe = /"kind"\s*:\s*"nvidia\.com\/gpu"/;
  for (const dir of specDirs) {
    let entries: string[];
    try {
      entries = readdirImpl(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ya?ml|json)$/i.test(entry)) continue;
      let raw: string;
      try {
        raw = readFileImpl(path.join(dir, entry), "utf-8");
      } catch {
        continue;
      }
      if (kindRe.test(raw) || jsonRe.test(raw)) return true;
    }
  }
  return false;
}

export function parseDockerInfoCpus(info = ""): number | undefined {
  const jsonMatch = info.match(/"NCPU"\s*:\s*(\d+)/);
  if (jsonMatch) {
    const n = parseInt(jsonMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const textMatch = info.match(/^\s*CPUs:\s*(\d+)\s*$/m);
  if (textMatch) {
    const n = parseInt(textMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

export function parseDockerInfoMemTotalBytes(info = ""): number | undefined {
  const jsonMatch = info.match(/"MemTotal"\s*:\s*(\d+)/);
  if (jsonMatch) {
    const n = parseInt(jsonMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const textMatch = info.match(/^\s*Total Memory:\s*([\d.]+)\s*([GMK]i?B)\s*$/im);
  if (textMatch) {
    const value = parseFloat(textMatch[1]);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const unit = textMatch[2].toLowerCase();
    const multiplier =
      unit === "gib"
        ? 1024 ** 3
        : unit === "gb"
          ? 1000 ** 3
          : unit === "mib"
            ? 1024 ** 2
            : unit === "mb"
              ? 1000 ** 2
              : unit === "kib"
                ? 1024
                : unit === "kb"
                  ? 1000
                  : 1;
    return Math.round(value * multiplier);
  }
  return undefined;
}

export const MIN_RECOMMENDED_DOCKER_CPUS = 4;
export const MIN_RECOMMENDED_DOCKER_MEM_GIB = 8;

export function isDockerUnderProvisioned(
  cpus: number | undefined,
  memTotalBytes: number | undefined,
): boolean {
  const cpuLow = typeof cpus === "number" && cpus < MIN_RECOMMENDED_DOCKER_CPUS;
  const memLow =
    typeof memTotalBytes === "number" &&
    memTotalBytes < MIN_RECOMMENDED_DOCKER_MEM_GIB * 1024 ** 3;
  return cpuLow || memLow;
}

function readDockerDefaultCgroupnsMode(
  readFileImpl: (filePath: string, encoding: BufferEncoding) => string,
): "host" | "private" | "unknown" {
  const paths = ["/etc/docker/daemon.json", "/home/rootless/.config/docker/daemon.json"];
  for (const filePath of paths) {
    try {
      const raw = readFileImpl(filePath, "utf-8");
      const parsed: {
        ["default-cgroupns-mode"]?: string;
      } = JSON.parse(raw);
      const mode = parsed["default-cgroupns-mode"];
      if (mode === "host" || mode === "private") return mode;
    } catch {
      // Try next path
    }
  }
  return "unknown";
}

function isHeadlessLikely(env: NodeJS.ProcessEnv): boolean {
  return !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERM_PROGRAM;
}

function detectNvidiaGpu(runCaptureImpl: RunCaptureFn): boolean {
  if (!commandExists("nvidia-smi", runCaptureImpl)) {
    return false;
  }
  return Boolean(String(runCaptureImpl(["nvidia-smi", "-L"], { ignoreError: true }) || "").trim());
}

function detectPackageManager(runCaptureImpl: RunCaptureFn): PackageManager {
  if (commandExists("apt-get", runCaptureImpl)) return "apt";
  if (commandExists("dnf", runCaptureImpl)) return "dnf";
  if (commandExists("yum", runCaptureImpl)) return "yum";
  if (commandExists("brew", runCaptureImpl)) return "brew";
  if (commandExists("pacman", runCaptureImpl)) return "pacman";
  return "unknown";
}

function parseSystemctlState(value = ""): boolean | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === "active" || normalized === "enabled") return true;
  if (
    normalized === "inactive" ||
    normalized === "failed" ||
    normalized === "disabled" ||
    normalized === "masked"
  ) {
    return false;
  }
  return null;
}

export function assessHost(opts: AssessHostOpts = {}): HostAssessment {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const runCaptureImpl =
    opts.runCaptureImpl ??
    ((command: readonly string[], options?: { ignoreError?: boolean }) =>
      runCapture(command, { ignoreError: options?.ignoreError ?? false }));
  const readFileImpl = opts.readFileImpl ?? fs.readFileSync;
  const readdirImpl = opts.readdirImpl ?? ((dir: string) => fs.readdirSync(dir));
  const dockerInstalled =
    opts.commandExistsImpl?.("docker") ?? commandExists("docker", runCaptureImpl);
  const nodeInstalled = opts.commandExistsImpl?.("node") ?? commandExists("node", runCaptureImpl);
  const openshellInstalled =
    opts.commandExistsImpl?.("openshell") ?? commandExists("openshell", runCaptureImpl);
  const hasNvidiaGpu = opts.gpuProbeImpl?.() ?? detectNvidiaGpu(runCaptureImpl);
  const packageManager = detectPackageManager(runCaptureImpl);
  const systemctlAvailable = commandExists("systemctl", runCaptureImpl);

  let dockerInfoOutput = opts.dockerInfoOutput;
  let dockerReachable = false;
  let dockerRunning = false;
  if (dockerInstalled && dockerInfoOutput === undefined) {
    dockerInfoOutput = runCaptureImpl(["docker", "info", "--format", "{{json .}}"], {
      ignoreError: true,
    });
  }
  if (dockerInstalled && String(dockerInfoOutput || "").trim()) {
    dockerReachable = true;
    dockerRunning = true;
  }

  const release = opts.release ?? os.release();
  const procVersion =
    opts.procVersion ??
    (() => {
      try {
        return readFileImpl("/proc/version", "utf-8");
      } catch {
        return "";
      }
    })();
  let runtime = inferContainerRuntime(dockerInfoOutput);
  if (dockerReachable && runtime === "unknown" && platform === "linux") {
    runtime = "docker";
  }
  const dockerCgroupVersion = dockerReachable
    ? parseDockerCgroupVersion(dockerInfoOutput)
    : "unknown";
  const dockerStorageDriver = dockerReachable
    ? parseDockerStorageDriver(dockerInfoOutput)
    : undefined;
  const dockerUsesContainerdSnapshotter = dockerReachable
    ? parseDockerUsesContainerdSnapshotter(dockerInfoOutput)
    : false;
  const dockerCpus = dockerReachable ? parseDockerInfoCpus(dockerInfoOutput) : undefined;
  const dockerMemTotalBytes = dockerReachable
    ? parseDockerInfoMemTotalBytes(dockerInfoOutput)
    : undefined;
  // CDI spec gap: Docker 25+ on hosts with `nvidia-container-toolkit` installed
  // typically advertises `"CDISpecDirs": ["/etc/cdi", "/var/run/cdi"]` in its
  // info output. OpenShell's `gateway start --gpu` then opportunistically
  // selects CDI mode and tries to inject `nvidia.com/gpu=all`. If no spec has
  // been generated yet (`/etc/cdi/nvidia.yaml` is missing), the gateway start
  // fails with `unresolvable CDI devices nvidia.com/gpu=all`. Detect this up
  // front so preflight can point the user at `nvidia-ctk cdi generate` before
  // we waste minutes downloading the gateway image. See issue #3152.
  const dockerCdiSpecDirs = dockerReachable ? parseDockerCdiSpecDirs(dockerInfoOutput) : [];
  const cdiNvidiaGpuSpecMissing =
    platform === "linux" &&
    hasNvidiaGpu &&
    dockerCdiSpecDirs.length > 0 &&
    !hasNvidiaCdiSpec(dockerCdiSpecDirs, readdirImpl, readFileImpl);
  const isContainerRuntimeUnderProvisioned = isDockerUnderProvisioned(
    dockerCpus,
    dockerMemTotalBytes,
  );
  // Nested-overlay break: Docker 26+ on Linux with the containerd image store
  // (Driver=overlayfs + DriverStatus mentions io.containerd.snapshotter.v1)
  // does not allow k3s-in-Docker to mount its own overlay snapshots. The
  // legacy `overlay2` graph driver materializes layers as plain directory
  // trees and is unaffected. Docker Desktop on macOS/Windows reports
  // overlayfs through a Linux VM that does not exhibit the same kernel
  // limitation, so we scope the conflict to platform === 'linux'.
  //
  // We additionally exclude WSL2 hosts. Native Docker inside WSL2 (without
  // Docker Desktop integration) routes through the WSL kernel, which has
  // a different overlay-mount story than bare Linux and is not part of
  // the user-confirmed reproducer. Engaging the auto-fix there could
  // build an unnecessary patched image; preferring to leave WSL alone
  // until we have a confirmed repro is the conservative call.
  const isWslHost = detectWsl({ platform, env, release, procVersion });
  const hasNestedOverlayConflict =
    platform === "linux" &&
    !isWslHost &&
    runtime === "docker" &&
    dockerStorageDriver === "overlayfs" &&
    dockerUsesContainerdSnapshotter;
  const dockerDefaultCgroupnsMode = readDockerDefaultCgroupnsMode(readFileImpl);
  const dockerServiceActive =
    platform === "linux" && systemctlAvailable && dockerInstalled
      ? parseSystemctlState(
          runCaptureImpl(["systemctl", "is-active", "docker"], { ignoreError: true }),
        )
      : null;
  const dockerServiceEnabled =
    platform === "linux" && systemctlAvailable && dockerInstalled
      ? parseSystemctlState(
          runCaptureImpl(["systemctl", "is-enabled", "docker"], { ignoreError: true }),
        )
      : null;
  const assessment: HostAssessment = {
    platform,
    isWsl: isWslHost,
    runtime,
    packageManager,
    systemctlAvailable,
    dockerServiceActive,
    dockerServiceEnabled,
    dockerInstalled,
    dockerRunning,
    dockerReachable,
    nodeInstalled,
    openshellInstalled,
    dockerInfoSummary: parseDockerInfoSummary(dockerInfoOutput),
    dockerCgroupVersion,
    dockerDefaultCgroupnsMode,
    dockerStorageDriver,
    dockerUsesContainerdSnapshotter,
    dockerCpus,
    dockerMemTotalBytes,
    isContainerRuntimeUnderProvisioned,
    hasNestedOverlayConflict,
    // Current OpenShell sets host cgroupns on its own cluster container.
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: runtime === "podman",
    isHeadlessLikely: isHeadlessLikely(env),
    hasNvidiaGpu,
    dockerCdiSpecDirs,
    cdiNvidiaGpuSpecMissing,
    notes: [],
  };

  if (assessment.isWsl) {
    assessment.notes.push("Running under WSL");
  }
  if (assessment.isHeadlessLikely) {
    assessment.notes.push("Headless environment likely");
  }
  if (assessment.dockerInfoSummary) {
    assessment.notes.push(`Docker: ${assessment.dockerInfoSummary}`);
  }

  return assessment;
}

export function planHostRemediation(assessment: HostAssessment): RemediationAction[] {
  const actions: RemediationAction[] = [];

  if (!assessment.dockerInstalled) {
    const installCommands: Record<PackageManager, string> = {
      apt: "Install Docker Engine, then rerun `nemoclaw onboard`.",
      dnf: "Install Docker Engine with your package manager, then rerun `nemoclaw onboard`.",
      yum: "Install Docker Engine with your package manager, then rerun `nemoclaw onboard`.",
      brew: "Install Docker Desktop or Colima, then rerun `nemoclaw onboard`.",
      pacman: "Install Docker Engine with your package manager, then rerun `nemoclaw onboard`.",
      unknown: "Install Docker, then rerun `nemoclaw onboard`.",
    };
    actions.push({
      id: "install_docker",
      title: "Install Docker",
      kind: "manual",
      reason: "Docker is required before onboarding can create a gateway or sandbox.",
      commands:
        assessment.platform === "darwin"
          ? ["Install Docker Desktop or Colima, then rerun `nemoclaw onboard`."]
          : [installCommands[assessment.packageManager ?? "unknown"]],
      blocking: true,
    });
  } else if (!assessment.dockerReachable) {
    // On Linux, if the systemd service is already active but the daemon is
    // unreachable, the most likely cause is a permissions / docker-group issue
    // rather than a stopped service.
    const likelyGroupIssue =
      assessment.platform === "linux" && assessment.dockerServiceActive === true;

    if (likelyGroupIssue) {
      actions.push({
        id: "docker_group_permission",
        title: "Add user to docker group",
        kind: "sudo",
        reason:
          "Docker is installed and the service is running, but the current user cannot reach the daemon. " +
          "This usually means your user is not in the docker group.",
        commands: [
          "sudo usermod -aG docker $USER",
          "newgrp docker   # or log out and back in",
          "nemoclaw onboard",
        ],
        blocking: true,
      });
    } else {
      actions.push({
        id: "start_docker",
        title: "Start Docker",
        kind: "manual",
        reason: "Docker is installed but NemoClaw could not talk to the Docker daemon.",
        commands:
          assessment.platform === "darwin"
            ? ["Start Docker Desktop or Colima, then rerun `nemoclaw onboard`."]
            : assessment.systemctlAvailable
              ? ["sudo systemctl start docker", "nemoclaw onboard"]
              : ["Start the Docker daemon, then rerun `nemoclaw onboard`."],
        blocking: true,
      });
    }
  }

  if (assessment.dockerReachable && assessment.isContainerRuntimeUnderProvisioned) {
    const cpus = assessment.dockerCpus;
    const memGiB =
      typeof assessment.dockerMemTotalBytes === "number"
        ? assessment.dockerMemTotalBytes / 1024 ** 3
        : undefined;
    const detected: string[] = [];
    if (typeof cpus === "number") detected.push(`${cpus} vCPU`);
    if (typeof memGiB === "number") detected.push(`${memGiB.toFixed(1)} GiB`);
    const detectedStr = detected.length > 0 ? detected.join(" / ") : "unknown";
    const recommendedStr = `${MIN_RECOMMENDED_DOCKER_CPUS} vCPU / ${MIN_RECOMMENDED_DOCKER_MEM_GIB} GiB`;
    const isColima = assessment.runtime === "colima";
    const isDockerDesktop = assessment.runtime === "docker-desktop";
    const reason =
      `Container runtime is under-provisioned (detected ${detectedStr}; recommended ${recommendedStr}). ` +
      "Sandbox build will be slow and may stall when runtime resources are too low.";
    const commands: string[] = [];
    if (isColima) {
      commands.push(
        "colima stop",
        `colima start --cpu ${MIN_RECOMMENDED_DOCKER_CPUS} --memory ${MIN_RECOMMENDED_DOCKER_MEM_GIB} --disk 100`,
      );
    } else if (isDockerDesktop) {
      commands.push(
        `Open Docker Desktop → Settings → Resources and raise CPUs to ≥ ${MIN_RECOMMENDED_DOCKER_CPUS} and memory to ≥ ${MIN_RECOMMENDED_DOCKER_MEM_GIB} GiB.`,
      );
    } else {
      commands.push(
        `Raise your container runtime's resource limits to ≥ ${MIN_RECOMMENDED_DOCKER_CPUS} vCPU and ≥ ${MIN_RECOMMENDED_DOCKER_MEM_GIB} GiB of memory before retrying.`,
      );
    }
    actions.push({
      id: "container_runtime_under_provisioned",
      title: "Increase container runtime resources",
      kind: "manual",
      reason,
      commands,
      blocking: false,
    });
  }

  if (assessment.isUnsupportedRuntime) {
    actions.push({
      id: "unsupported_runtime_warning",
      title: "Use a supported Docker runtime if problems appear",
      kind: "manual",
      reason:
        "OpenShell officially documents Docker-based runtimes. Podman may work in some environments, but it is not a supported runtime and behavior may vary.",
      commands:
        assessment.platform === "darwin"
          ? ["If onboarding or sandbox lifecycle fails, switch to Docker Desktop or Colima."]
          : ["If onboarding or sandbox lifecycle fails, switch to a Docker-supported runtime."],
      blocking: false,
    });
  }

  if (!assessment.nodeInstalled) {
    actions.push({
      id: "install_nodejs",
      title: "Install Node.js",
      kind: "manual",
      reason: "NemoClaw requires Node.js for its CLI and plugin build steps.",
      commands: ["Run the NemoClaw installer to install Node.js automatically."],
      blocking: false,
    });
  }

  if (!assessment.openshellInstalled) {
    actions.push({
      id: "install_openshell",
      title: "Install OpenShell",
      kind: "manual",
      reason: "OpenShell is required before onboarding can create or manage a gateway.",
      commands: ["Run the NemoClaw installer or `scripts/install-openshell.sh`."],
      blocking: false,
    });
  }

  if (assessment.isHeadlessLikely && !assessment.hasNvidiaGpu) {
    actions.push({
      id: "headless_remote_hint",
      title: "Review remote/headless UI settings",
      kind: "info",
      reason:
        "Headless Linux hosts often need explicit remote UI handling if you want browser access.",
      commands: ["Set `CHAT_UI_URL` when remote browser access matters."],
      blocking: false,
    });
  }

  if (assessment.cdiNvidiaGpuSpecMissing) {
    const specDir = assessment.dockerCdiSpecDirs[0] ?? "/etc/cdi";
    actions.push({
      id: "generate_nvidia_cdi_spec",
      title: "Generate NVIDIA CDI device specs",
      kind: "sudo",
      reason:
        "Docker is configured for CDI device injection (CDISpecDirs is set) but no " +
        "nvidia.com/gpu CDI spec is present on the host. OpenShell's `gateway start --gpu` " +
        "will fail with `unresolvable CDI devices nvidia.com/gpu=all` until a spec is generated.",
      commands: [
        `sudo nvidia-ctk cdi generate --output=${specDir.replace(/\/+$/, "")}/nvidia.yaml`,
        "nvidia-ctk cdi list   # verify nvidia.com/gpu entries appear",
        "nemoclaw onboard      # or rerun with --no-gpu to skip GPU passthrough",
      ],
      blocking: true,
    });
  }

  return actions;
}

// ── Port availability ────────────────────────────────────────────

export async function probePortAvailability(
  port: number,
  opts: Pick<CheckPortOpts, "probeImpl"> = {},
): Promise<PortProbeResult> {
  if (typeof opts.probeImpl === "function") {
    return opts.probeImpl(port);
  }

  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({
          ok: false,
          process: "unknown",
          pid: null,
          reason: `port ${port} is in use (EADDRINUSE)`,
        });
        return;
      }

      if (err.code === "EPERM" || err.code === "EACCES") {
        resolve({
          ok: true,
          warning: `port probe skipped: ${err.message}`,
        });
        return;
      }

      // Unexpected probe failure: do not report a false conflict.
      resolve({
        ok: true,
        warning: `port probe inconclusive: ${err.message}`,
      });
    });
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve({ ok: true }));
    });
  });
}

function parseLsofLines(output: string): PortProbeResult | null {
  const lines = output.split("\n").filter((l) => l.trim());
  const dataLines = lines.filter((l) => !l.startsWith("COMMAND"));
  if (dataLines.length === 0) return null;

  const parts = dataLines[0].split(/\s+/);
  const proc = parts[0] || "unknown";
  const pid = parseInt(parts[1], 10) || null;
  return { ok: false, process: proc, pid, reason: "" };
}

/**
 * Check whether a TCP port is available for listening.
 *
 * Detection chain:
 *   1. lsof (primary) — identifies the blocking process name + PID
 *   2. Node.js net probe (fallback) — cross-platform, detects EADDRINUSE
 */
export async function checkPortAvailable(
  port?: number,
  opts?: CheckPortOpts,
): Promise<PortProbeResult> {
  const p = port ?? DASHBOARD_PORT;
  const o = opts || {};

  // ── lsof path ──────────────────────────────────────────────────
  if (!o.skipLsof) {
    let lsofOut: string | undefined;
    if (typeof o.lsofOutput === "string") {
      lsofOut = o.lsofOutput;
    } else {
      const hasLsof = commandExists("lsof", (command, options) =>
        runCapture(command, { ignoreError: options?.ignoreError ?? false }),
      );
      if (hasLsof) {
        lsofOut = runCapture(["lsof", "-i", `:${p}`, "-sTCP:LISTEN", "-P", "-n"], {
          ignoreError: true,
        });
      }
    }

    if (typeof lsofOut === "string") {
      const conflict = parseLsofLines(lsofOut);
      if (conflict) {
        return {
          ...conflict,
          reason: `lsof reports ${conflict.process} (PID ${conflict.pid}) listening on port ${p}`,
        };
      }

      // Empty lsof output is not authoritative — non-root users cannot
      // see listeners owned by root (e.g., docker-proxy, leftover gateway).
      // Retry with sudo -n to identify root-owned listeners before falling
      // through to the net probe (which can only detect EADDRINUSE but not
      // the owning process).
      if (!o.lsofOutput) {
        const sudoOut: string | undefined = runCapture(
          ["sudo", "-n", "lsof", "-i", `:${p}`, "-sTCP:LISTEN", "-P", "-n"],
          { ignoreError: true },
        );
        if (typeof sudoOut === "string") {
          const sudoConflict = parseLsofLines(sudoOut);
          if (sudoConflict) {
            return {
              ...sudoConflict,
              reason: `sudo lsof reports ${sudoConflict.process} (PID ${sudoConflict.pid}) listening on port ${p}`,
            };
          }
        }
      }
    }
  }

  // ── net probe fallback ─────────────────────────────────────────
  return probePortAvailability(p, o);
}

// ── Memory info ──────────────────────────────────────────────────

export function getMemoryInfo(opts?: GetMemoryInfoOpts): MemoryInfo | null {
  const o = opts || {};
  const platform = o.platform || process.platform;

  if (platform === "linux") {
    let content: string;
    if (typeof o.meminfoContent === "string") {
      content = o.meminfoContent;
    } else {
      try {
        content = fs.readFileSync("/proc/meminfo", "utf-8");
      } catch {
        return null;
      }
    }

    const parseKB = (key: string): number => {
      const match = content.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return match ? parseInt(match[1], 10) : 0;
    };

    const totalRamKB = parseKB("MemTotal");
    const totalSwapKB = parseKB("SwapTotal");
    const totalRamMB = Math.floor(totalRamKB / 1024);
    const totalSwapMB = Math.floor(totalSwapKB / 1024);
    return { totalRamMB, totalSwapMB, totalMB: totalRamMB + totalSwapMB };
  }

  if (platform === "darwin") {
    try {
      const memBytes = parseInt(
        runCapture(["sysctl", "-n", "hw.memsize"], { ignoreError: true }),
        10,
      );
      if (!memBytes || isNaN(memBytes)) return null;
      const totalRamMB = Math.floor(memBytes / 1024 / 1024);
      // macOS does not use traditional swap files in the same way
      return { totalRamMB, totalSwapMB: 0, totalMB: totalRamMB };
    } catch {
      return null;
    }
  }

  return null;
}

// ── Swap management (Linux only) ─────────────────────────────────

function hasSwapfile(): boolean {
  try {
    fs.accessSync("/swapfile");
    return true;
  } catch {
    return false;
  }
}

function getExistingSwapResult(mem: MemoryInfo): SwapResult | null {
  if (!hasSwapfile()) {
    return null;
  }

  const swaps = (() => {
    try {
      return fs.readFileSync("/proc/swaps", "utf-8");
    } catch {
      return "";
    }
  })();

  if (swaps.includes("/swapfile")) {
    return {
      ok: true,
      totalMB: mem.totalMB,
      swapCreated: false,
      reason: "/swapfile already exists",
    };
  }

  try {
    runCapture(["sudo", "swapon", "/swapfile"], { ignoreError: false });
    return { ok: true, totalMB: mem.totalMB + 4096, swapCreated: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `found orphaned /swapfile but could not activate it: ${message}`,
    };
  }
}

function checkSwapDiskSpace(): SwapResult | null {
  try {
    const dfOut = runCapture(["df", "/", "--output=avail", "-k"], {
      ignoreError: true,
    });
    const freeKB = parseInt((dfOut || "").split(/\r?\n/).at(-1)?.trim() || "", 10);
    if (!isNaN(freeKB) && freeKB < 5000000) {
      return {
        ok: false,
        reason: `insufficient disk space (${Math.floor(freeKB / 1024)} MB free, need ~5 GB) to create swap file`,
      };
    }
  } catch {
    // df unavailable — let dd fail naturally if out of space
  }

  return null;
}

function writeManagedSwapMarker(): void {
  const nemoclawDir = path.join(os.homedir(), ".nemoclaw");
  if (!fs.existsSync(nemoclawDir)) {
    runCapture(["mkdir", "-p", nemoclawDir], { ignoreError: true });
  }

  try {
    fs.writeFileSync(path.join(nemoclawDir, "managed_swap"), "/swapfile");
  } catch {
    // Best effort marker write.
  }
}

function cleanupPartialSwap(): void {
  try {
    runCapture(["sudo", "swapoff", "/swapfile"], { ignoreError: true });
    runCapture(["sudo", "rm", "-f", "/swapfile"], { ignoreError: true });
  } catch {
    // Best effort cleanup
  }
}

function createSwapfile(mem: MemoryInfo): SwapResult {
  try {
    runCapture(
      ["sudo", "dd", "if=/dev/zero", "of=/swapfile", "bs=1M", "count=4096", "status=none"],
      {
        ignoreError: false,
      },
    );
    runCapture(["sudo", "chmod", "600", "/swapfile"], { ignoreError: false });
    runCapture(["sudo", "mkswap", "/swapfile"], { ignoreError: false });
    runCapture(["sudo", "swapon", "/swapfile"], { ignoreError: false });
    const fstab = runCapture(["sudo", "cat", "/etc/fstab"], { ignoreError: true });
    if (
      !String(fstab || "")
        .split(/\r?\n/)
        .some((line) => /^\/swapfile\s/.test(line.trim()))
    ) {
      runCapture(["sudo", "tee", "-a", "/etc/fstab"], {
        ignoreError: false,
        input: "/swapfile none swap sw 0 0\n",
      });
    }
    writeManagedSwapMarker();

    return { ok: true, totalMB: mem.totalMB + 4096, swapCreated: true };
  } catch (err) {
    cleanupPartialSwap();
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason:
        `swap creation failed: ${message}. Create swap manually:\n` +
        "  sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none && sudo chmod 600 /swapfile && " +
        "sudo mkswap /swapfile && sudo swapon /swapfile",
    };
  }
}

/**
 * Ensure the system has enough memory (RAM + swap) for sandbox operations.
 *
 * If total memory is below minTotalMB and no swap file exists, attempts to
 * create a 4 GB swap file via sudo to prevent OOM kills during sandbox
 * image push.
 */
export function ensureSwap(minTotalMB?: number, opts: EnsureSwapOpts = {}): SwapResult {
  const o: {
    platform: NodeJS.Platform;
    memoryInfo: MemoryInfo | null;
    swapfileExists: boolean;
    dryRun: boolean;
    interactive: boolean;
    getMemoryInfoImpl: (opts: GetMemoryInfoOpts) => MemoryInfo | null;
  } = {
    platform: process.platform,
    memoryInfo: null,
    swapfileExists: fs.existsSync("/swapfile"),
    dryRun: false,
    interactive: process.stdout.isTTY && !process.env.NEMOCLAW_NON_INTERACTIVE,
    getMemoryInfoImpl: getMemoryInfo,
    ...opts,
  };
  const threshold = minTotalMB ?? 12000;

  if (o.platform !== "linux") {
    return { ok: true, totalMB: 0, swapCreated: false };
  }

  const mem = o.memoryInfo ?? o.getMemoryInfoImpl({ platform: o.platform });
  if (!mem) {
    return { ok: false, reason: "could not read memory info" };
  }

  if (mem.totalMB >= threshold) {
    return { ok: true, totalMB: mem.totalMB, swapCreated: false };
  }

  if (o.dryRun) {
    if (o.swapfileExists) {
      return {
        ok: true,
        totalMB: mem.totalMB,
        swapCreated: false,
        reason: "/swapfile already exists",
      };
    }
    return { ok: true, totalMB: mem.totalMB, swapCreated: true };
  }

  const existingSwapResult = getExistingSwapResult(mem);
  if (existingSwapResult) {
    return existingSwapResult;
  }

  const diskSpaceResult = checkSwapDiskSpace();
  if (diskSpaceResult) {
    return diskSpaceResult;
  }

  return createSwapfile(mem);
}

// ── Container DNS probe (#2101) ───────────────────────────────────
// The sandbox build's `npm ci` step resolves `registry.npmjs.org` from inside
// a docker container. Networks that block outbound UDP:53 to public resolvers
// (common in corporate environments that force DNS-over-TLS on the host) leave
// the container unable to resolve anything — npm retries for ~15 min and then
// prints the cryptic `Exit handler never called`. This probe catches that
// state in a few seconds so the user gets a targeted error up front.

export interface DnsProbeResult {
  ok: boolean;
  reason?:
    | "no_output"
    | "resolution_failed"
    | "servers_unreachable"
    | "image_pull_failed"
    | "error";
  details?: string;
}

export interface ProbeContainerDnsOpts {
  /** Override the docker run command. */
  command?: readonly string[];
  /** Inject captured output (bypasses execution). */
  outputOverride?: string | null;
  /** Override runCapture. */
  runCaptureImpl?: NullableRunCaptureFn;
}

/**
 * Hard ceiling on the DNS probe: Node kills the child after this many
 * milliseconds. 20 s is roughly 1.3× busybox nslookup's own retry budget
 * (3 × 5 s), which leaves headroom for image pull on a cold cache without
 * letting a wedged docker daemon stall preflight forever.
 */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Discover the IPv4 gateway address of docker's default bridge network.
 * Returns null if docker isn't running, the inspect command fails, or the
 * output doesn't parse. Callers use this to tailor DNS remediation hints
 * to the user's actual bridge IP instead of assuming the conventional
 * `172.17.0.1`.
 */
export function getDockerBridgeGatewayIp(
  runCaptureImpl: NullableRunCaptureFn = (cmd, o) =>
    runCapture(cmd, { ignoreError: o?.ignoreError ?? false }),
): string | null {
  let raw: string | null;
  try {
    raw = runCaptureImpl(
      [
        "docker",
        "network",
        "inspect",
        "bridge",
        "--format",
        "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
      ],
      { ignoreError: true },
    );
  } catch {
    return null;
  }
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Dual-stack bridges have multiple entries in .IPAM.Config, and the
  // `{{range}}` template concatenates their gateways with no separator —
  // e.g., "172.17.0.1fd00:abcd::1" for an IPv4+IPv6 bridge. Word-boundary
  // anchors don't help here because the boundary between "1" and "f" is
  // absent (both are word chars) and a trailing IPv6 that ends in a digit
  // ("...::1") eats the would-be start anchor of the IPv4. Scan for the
  // first dotted-quad anywhere in the output and validate the octets.
  const match = trimmed.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  if (!match) return null;
  const octets = match[0].split(".").map((s) => Number(s));
  if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return match[0];
}

/**
 * Probe whether DNS resolution works from inside a docker container.
 * Returns `{ ok: true }` when a busybox test container resolves
 * `registry.npmjs.org`; otherwise returns a structured `reason` +
 * truncated `details` so callers can tailor the error message:
 *
 * - `image_pull_failed` — the busybox image couldn't be pulled (docker
 *   daemon can't reach the registry). Distinct from DNS-inside-container.
 * - `servers_unreachable` — resolver was unreachable (UDP:53 dropped).
 *   The typical #2101 signature on corp-firewalled hosts.
 * - `resolution_failed` — resolver answered but lookup failed (NXDOMAIN
 *   or similar). Unusual.
 * - `no_output` / `error` — probe couldn't run at all.
 */
export function probeContainerDns(opts: ProbeContainerDnsOpts = {}): DnsProbeResult {
  // Cap the whole probe via Node's spawn-level timeout (works on every
  // platform Node supports — no dependency on a host-side `timeout`
  // binary). Child process is killed, runCapture returns "" under
  // ignoreError, and we fall through to the `no_output` branch.
  //
  // We funnel through `sh -c` so we can `2>&1` the docker pull progress
  // and busybox nslookup diagnostics into stdout — both write the
  // signatures the parser below depends on (`Error response from daemon`,
  // `no servers could be reached`) to stderr. Every token in the script
  // is a fixed constant, so no shell injection surface.
  const command = opts.command ?? [
    "sh",
    "-c",
    "docker run --rm --pull=missing busybox:latest nslookup registry.npmjs.org 2>&1",
  ];

  let output: string | null | undefined = opts.outputOverride;
  if (output === undefined) {
    try {
      const runCaptureImpl =
        opts.runCaptureImpl ??
        ((cmd: readonly string[], o?: RunCaptureOpts) =>
          runCapture(cmd, {
            ignoreError: o?.ignoreError ?? false,
            timeout: o?.timeout,
          }));
      output = runCaptureImpl(command, {
        ignoreError: true,
        timeout: PROBE_TIMEOUT_MS,
      });
    } catch (e) {
      return {
        ok: false,
        reason: "error",
        details: String((e as Error)?.message ?? e),
      };
    }
  }

  // Treat whitespace-only output (e.g., bare newlines left by a killed
  // child) the same as empty — otherwise the subsequent regex checks all
  // miss and we'd mis-report it as `resolution_failed`.
  if (!output || !output.trim()) {
    return {
      ok: false,
      reason: "no_output",
      details: "docker run produced no output (timed out or failed to start)",
    };
  }

  // Success: busybox nslookup prints "Name:" and "Address:" lines.
  if (/\bName:\s*registry\.npmjs\.org\b/.test(output) && /\bAddress:\s*\d/.test(output)) {
    return { ok: true };
  }

  // Docker image-pull failure — the probe never got to run nslookup, so
  // framing this as a DNS problem would mislead. Signatures from
  // `docker run --pull=missing` when the daemon can't fetch the image.
  if (
    /Error response from daemon:.*(pull|manifest|not found)|pull access denied|manifest.*unknown|unauthorized: authentication required|Head.*https?:\/\/.*: dial/i.test(
      output,
    )
  ) {
    return {
      ok: false,
      reason: "image_pull_failed",
      details: output.slice(-400),
    };
  }

  // UDP:53 egress blocked — the #2101 signature. nslookup gave up after
  // its retry budget without getting any DNS response.
  if (/no servers could be reached|connection timed out/i.test(output)) {
    return {
      ok: false,
      reason: "servers_unreachable",
      details: output.slice(-400),
    };
  }

  // Something else — resolver responded but couldn't answer.
  return {
    ok: false,
    reason: "resolution_failed",
    details: output.slice(-400),
  };
}
