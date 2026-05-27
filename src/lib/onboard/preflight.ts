// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preflight checks for NemoClaw onboarding: port availability, memory
 * info, and swap management.
 *
 * Every function accepts an opts object for dependency injection so
 * tests can run without real I/O.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { DASHBOARD_PORT } from "../core/ports";
import {
  isWslDockerDesktopRuntime,
  wslDockerDesktopGpuCompatibilityAction,
} from "./wsl-docker-desktop-gpu";
export { isWslDockerDesktopRuntime } from "./wsl-docker-desktop-gpu";

// runner.ts still uses CommonJS-style exports — use require here.
const { run, runCapture } = require("../runner");

type RunCaptureFn = typeof import("../runner").runCapture;
type RunFn = typeof import("../runner").run;
type RunCaptureOpts = Parameters<RunCaptureFn>[1];
type NullableRunCaptureFn = (
  command: Parameters<RunCaptureFn>[0],
  options?: RunCaptureOpts,
) => string | null;
type ProbeRunOpts = { timeout?: number };

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
  /** Host address to use for the fallback net probe. */
  host?: string;
  /** Async probe implementation for testing. */
  probeImpl?: (port: number, host: string) => Promise<PortProbeResult>;
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
  nvidiaContainerToolkitInstalled: boolean;
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

export const DOCKER_DESKTOP_WSL_INTEGRATION_HINT =
  "If you use Docker Desktop from WSL, open Docker Desktop > Settings > Resources > WSL integration and enable integration for this distro.";

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

/**
 * Decide whether `docker info --format '{{json .}}'` output reflects an
 * actually responding daemon, not just the Docker CLI emitting a zero-value
 * client-side struct.
 *
 * NemoClaw #2348: when the daemon is unreachable (for example after
 * `colima stop`), Docker CLI can still exit 0 and print a JSON struct with
 * `ServerVersion: ""` plus `ServerErrors`. A naive non-empty-output check
 * misreads that as "daemon reachable".
 */
function isDockerDaemonReachable(rawOutput = ""): boolean {
  const text = String(rawOutput).trim();
  if (!text) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Backward-compatible fallback for callers that still inject plain-text
    // docker info output, but do not let plain-text daemon connection errors
    // recreate the false positive that this check is meant to prevent.
    const lowered = text.toLowerCase();
    return !(
      lowered.includes("cannot connect to the docker daemon") ||
      lowered.includes("error during connect") ||
      lowered.includes("is the docker daemon running")
    );
  }

  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;

  // Explicit negative signal: Docker CLI fills ServerErrors when it could
  // not reach the daemon, even when exit code is 0 under `--format`.
  if (Array.isArray(obj.ServerErrors) && obj.ServerErrors.length > 0) {
    return false;
  }

  // Canonical positive signal: Docker CLI and podman's docker-compat layer
  // both populate ServerVersion from the running daemon.
  if (typeof obj.ServerVersion === "string" && obj.ServerVersion.trim().length > 0) {
    return true;
  }

  // podman-docker alias path: `docker info --format '{{json .}}'` actually
  // runs `podman info`, whose native schema has no top-level ServerVersion
  // but nests a `version.Version` instead.
  const version = obj.version;
  if (version && typeof version === "object") {
    const v = (version as Record<string, unknown>).Version;
    if (typeof v === "string" && v.trim().length > 0) return true;
  }

  return false;
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

function normalizeCdiSpecDir(specDir: string | undefined): string {
  const trimmed = String(specDir || "/etc/cdi")
    .trim()
    .replace(/\/+$/, "");
  return trimmed || "/etc/cdi";
}

export function getNvidiaCdiSpecPath(
  assessment: Pick<HostAssessment, "dockerCdiSpecDirs">,
): string {
  return path.join(normalizeCdiSpecDir(assessment.dockerCdiSpecDirs[0]), "nvidia.yaml");
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

export function buildContainerToolkitBootstrapCommands(
  packageManager: PackageManager | undefined,
  generateCommands: readonly string[],
): string[] {
  const installGuide =
    "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html";
  if (packageManager === "apt") {
    return [
      "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
      "curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list",
      "sudo apt-get update",
      "sudo apt-get install -y nvidia-container-toolkit",
      ...generateCommands,
    ];
  }
  if (packageManager === "dnf" || packageManager === "yum") {
    const pmCommand = packageManager === "dnf" ? "dnf" : "yum";
    return [
      `curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo`,
      `sudo ${pmCommand} install -y nvidia-container-toolkit`,
      ...generateCommands,
    ];
  }
  return [
    `# Install nvidia-container-toolkit per NVIDIA's install guide: ${installGuide}`,
    ...generateCommands,
  ];
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
  const nvidiaContainerToolkitInstalled =
    opts.commandExistsImpl?.("nvidia-ctk") ?? commandExists("nvidia-ctk", runCaptureImpl);
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
  if (dockerInstalled && isDockerDaemonReachable(dockerInfoOutput)) {
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
    nvidiaContainerToolkitInstalled,
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
      const commands = [
        "sudo usermod -aG docker $USER",
        "newgrp docker   # or log out and back in",
        "nemoclaw onboard",
      ];
      if (assessment.isWsl) {
        commands.unshift(DOCKER_DESKTOP_WSL_INTEGRATION_HINT);
      }
      actions.push({
        id: "docker_group_permission",
        title: "Add user to docker group",
        kind: "sudo",
        reason:
          "Docker is installed and the service is running, but the current user cannot reach the daemon. " +
          "This usually means your user is not in the docker group. " +
          "NemoClaw needs Docker access. " +
          "On personal Linux development machines, adding your user to the docker group is the standard way to run Docker without sudo. " +
          "Docker group members can control the daemon with root-level impact, so grant this access only to trusted local accounts; on shared or managed systems, use your organization's approved Docker access path. " +
          "Background: https://docs.docker.com/engine/security/#docker-daemon-attack-surface.",
        commands,
        blocking: true,
      });
    } else {
      const commands =
        assessment.platform === "darwin"
          ? ["Start Docker Desktop or Colima, then rerun `nemoclaw onboard`."]
          : assessment.systemctlAvailable
            ? ["sudo systemctl start docker", "nemoclaw onboard"]
            : ["Start the Docker daemon, then rerun `nemoclaw onboard`."];
      if (assessment.isWsl) {
        commands.unshift(DOCKER_DESKTOP_WSL_INTEGRATION_HINT);
      }
      actions.push({
        id: "start_docker",
        title: "Start Docker",
        kind: "manual",
        reason: "Docker is installed but NemoClaw could not talk to the Docker daemon.",
        commands,
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
    const specPath = getNvidiaCdiSpecPath(assessment);
    const specDir = path.dirname(specPath);
    const generateCommands = [
      `sudo mkdir -p ${specDir}`,
      `sudo nvidia-ctk cdi generate --output=${specPath}`,
      "nvidia-ctk cdi list   # verify nvidia.com/gpu entries appear",
      "nemoclaw onboard      # or rerun with --no-gpu to skip GPU passthrough",
    ];
    if (isWslDockerDesktopRuntime(assessment)) {
      actions.push(wslDockerDesktopGpuCompatibilityAction());
    } else if (assessment.nvidiaContainerToolkitInstalled) {
      actions.push({
        id: "generate_nvidia_cdi_spec",
        title: "Generate NVIDIA CDI device specs",
        kind: "sudo",
        reason:
          "Docker is configured for CDI device injection (CDISpecDirs is set) but no " +
          "nvidia.com/gpu CDI spec is present on the host. OpenShell's `gateway start --gpu` " +
          "will fail with `unresolvable CDI devices nvidia.com/gpu=all` until a spec is generated.",
        commands: generateCommands,
        blocking: true,
      });
    } else {
      actions.push({
        id: "install_nvidia_container_toolkit",
        title: "Install NVIDIA Container Toolkit and generate CDI device specs",
        kind: "sudo",
        reason:
          "Docker is configured for CDI device injection (CDISpecDirs is set) but the " +
          "`nvidia-container-toolkit` package (which provides `nvidia-ctk`) is not installed " +
          "on the host. OpenShell's `gateway start --gpu` will fail with " +
          "`unresolvable CDI devices nvidia.com/gpu=all` until the toolkit is installed and a " +
          "CDI spec is generated.",
        commands: buildContainerToolkitBootstrapCommands(
          assessment.packageManager,
          generateCommands,
        ),
        blocking: true,
      });
    }
  }

  return actions;
}

// ── Port availability ────────────────────────────────────────────

export async function probePortAvailability(
  port: number,
  opts: Pick<CheckPortOpts, "host" | "probeImpl"> = {},
): Promise<PortProbeResult> {
  const host = opts.host || "127.0.0.1";
  if (typeof opts.probeImpl === "function") {
    return opts.probeImpl(port, host);
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
    srv.listen(port, host, () => {
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

type ProbeFailureReason =
  | "no_output"
  | "timeout"
  | "killed"
  | "resolution_failed"
  | "servers_unreachable"
  | "image_pull_failed"
  | "veth_unsupported"
  | "docker_daemon_unreachable"
  | "error";

export interface ProbeExecutionResult {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  exitCode?: number | null;
  status?: number | null;
  signal?: NodeJS.Signals | string | null;
  timedOut?: boolean;
  error?: string | Error | null;
  errorCode?: string | null;
}

type RunProbeFn = (command: readonly string[], options?: ProbeRunOpts) => ProbeExecutionResult;

export interface DnsProbeResult {
  ok: boolean;
  reason?: ProbeFailureReason;
  details?: string;
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: string | null;
}

export interface ProbeContainerDnsOpts {
  /** Override the docker run command. */
  command?: readonly string[];
  /** Inject captured output (bypasses execution). */
  outputOverride?: string | null;
  /** Inject structured execution metadata (bypasses execution). */
  executionOverride?: ProbeExecutionResult;
  /** Override runCapture. */
  runCaptureImpl?: NullableRunCaptureFn;
  /** Override structured probe execution. */
  runProbeImpl?: RunProbeFn;
  /** Override the probe name (test seam; pinned name for stable assertions). */
  probeName?: string;
  /** Inject a precomputed image-cache result; skips the pre-pull. */
  ensureImageCachedOverride?: EnsureProbeImageCachedResult;
}

export interface DockerBridgeContainerStartProbeResult {
  ok: boolean;
  reason?: Extract<
    ProbeFailureReason,
    | "no_output"
    | "timeout"
    | "killed"
    | "image_pull_failed"
    | "veth_unsupported"
    | "docker_daemon_unreachable"
    | "error"
  >;
  details?: string;
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: string | null;
}

export interface ProbeDockerBridgeContainerStartOpts {
  /** Override the docker run command. */
  command?: readonly string[];
  /** Inject structured execution metadata (bypasses execution). */
  executionOverride?: ProbeExecutionResult;
  /** Override structured probe execution. */
  runProbeImpl?: RunProbeFn;
  /** Inject a precomputed image-cache result; skips the pre-pull. */
  ensureImageCachedOverride?: EnsureProbeImageCachedResult;
}

/**
 * Hard ceiling on the DNS probe: Node kills the child after this many
 * milliseconds. 20 s is roughly 1.3× busybox nslookup's own retry budget
 * (3 × 5 s), which leaves headroom for image pull on a cold cache without
 * letting a wedged docker daemon stall preflight forever.
 */
const PROBE_TIMEOUT_MS = 20_000;
// Pinned to an immutable digest so the BusyBox `nslookup` output shape
// the parser below depends on cannot drift over time. Mirrors the same
// digest used by the sandbox-bridge gateway probe so both probes pull
// the exact same blob and share its Docker image cache.
export const BUSYBOX_PROBE_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";

/**
 * Longer ceiling for image pulls. Decoupled from PROBE_TIMEOUT_MS so a
 * cold-cache pull on a slow registry does not get charged against the
 * shorter probe budget and falsely classified as a fatal probe timeout.
 */
const PROBE_IMAGE_PULL_TIMEOUT_MS = 60_000;

export interface EnsureProbeImageCachedResult {
  ok: boolean;
  alreadyCached?: boolean;
  reason?: "pull_failed" | "pull_timeout" | "inspect_unavailable";
  details?: string;
}

export interface EnsureProbeImageCachedOpts {
  /** Override the docker image-inspect probe (test seam). */
  inspectProbeImpl?: RunProbeFn;
  /** Override the docker pull probe (test seam). */
  pullProbeImpl?: RunProbeFn;
  /** Pull-time budget (ms). Defaults to PROBE_IMAGE_PULL_TIMEOUT_MS. */
  pullTimeoutMs?: number;
}

/**
 * Make sure `image` is in the local docker image cache before a timed
 * probe runs. Returns `{ ok: true, alreadyCached }` when the image was
 * already present or was pulled successfully; otherwise returns a
 * structured reason describing why the pull could not be completed.
 *
 * Decoupling pull from probe lets callers report a slow/blocked registry
 * pull as an inconclusive image_pull_failed (not as a fatal probe
 * timeout / Docker-restart hint).
 */
export function ensureProbeImageCached(
  image: string,
  opts: EnsureProbeImageCachedOpts = {},
): EnsureProbeImageCachedResult {
  const inspectImpl = opts.inspectProbeImpl ?? defaultRunProbe;
  const pullImpl = opts.pullProbeImpl ?? defaultRunProbe;
  const pullTimeoutMs = opts.pullTimeoutMs ?? PROBE_IMAGE_PULL_TIMEOUT_MS;

  const inspect = normalizeProbeExecution(
    inspectImpl(["docker", "image", "inspect", image], { timeout: 10_000 }),
  );
  if (inspect.exitCode === 0) {
    return { ok: true, alreadyCached: true };
  }
  // Inspect couldn't run (docker missing/down). Don't mask the underlying
  // docker outage as an image-pull issue. The CLI can also exit 1 with a
  // "Cannot connect to the Docker daemon" stderr when dockerd is down,
  // so we sniff that signature in addition to spawn-level errors.
  const inspectOutput = probeCombinedOutput(inspect);
  if (
    (inspect.exitCode === null && (inspect.error || inspect.timedOut)) ||
    isDockerDaemonUnreachable(inspectOutput)
  ) {
    return {
      ok: false,
      reason: "inspect_unavailable",
      details:
        (inspectOutput.trim() && outputTail(inspectOutput)) ||
        inspect.error ||
        "docker image inspect did not complete",
    };
  }

  const pull = normalizeProbeExecution(
    pullImpl(["docker", "pull", image], { timeout: pullTimeoutMs }),
  );
  const combined = probeCombinedOutput(pull);
  if (pull.exitCode === 0) {
    return { ok: true, alreadyCached: false };
  }
  if (pull.timedOut || (pull.signal && pull.exitCode === null)) {
    return {
      ok: false,
      reason: "pull_timeout",
      details: probeExecutionDetails("docker pull", pull, pullTimeoutMs, combined),
    };
  }
  // A pull that fails with the daemon-unreachable signature is a docker
  // outage, not a registry/cache problem. Promote it so callers can treat
  // it as a fatal probe error instead of an inconclusive image_pull.
  if (isDockerDaemonUnreachable(combined)) {
    return {
      ok: false,
      reason: "inspect_unavailable",
      details: outputTail(combined),
    };
  }
  return {
    ok: false,
    reason: "pull_failed",
    details: combined.trim() ? outputTail(combined) : (pull.error ?? "docker pull failed"),
  };
}

export function isDockerDaemonUnreachable(output: string): boolean {
  return /Cannot connect to the Docker daemon|Is the docker daemon running\??|docker daemon is not running|error during connect.*Get .*docker.*open .*dial unix/i.test(
    output,
  );
}

function probeText(value: unknown): string {
  if (value == null) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return String(value);
}

function normalizeError(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Error) return value.message;
  return String(value);
}

function normalizeProbeExecution(result: ProbeExecutionResult): Required<
  Pick<ProbeExecutionResult, "stdout" | "stderr" | "exitCode" | "signal" | "timedOut">
> & {
  error: string | null;
  errorCode: string | null;
} {
  const error = normalizeError(result.error);
  const errorCode =
    result.errorCode ??
    (typeof result.error === "object" && result.error && "code" in result.error
      ? String((result.error as NodeJS.ErrnoException).code)
      : null);
  return {
    stdout: probeText(result.stdout),
    stderr: probeText(result.stderr),
    exitCode:
      typeof result.exitCode === "number" || result.exitCode === null
        ? result.exitCode
        : typeof result.status === "number" || result.status === null
          ? result.status
          : null,
    signal: result.signal ? String(result.signal) : null,
    timedOut:
      result.timedOut === true ||
      errorCode === "ETIMEDOUT" ||
      (error ? /ETIMEDOUT|timed out/i.test(error) : false),
    error,
    errorCode,
  };
}

function defaultRunProbe(command: readonly string[], options?: ProbeRunOpts): ProbeExecutionResult {
  const result = (run as RunFn)(command, {
    ignoreError: true,
    suppressOutput: true,
    timeout: options?.timeout,
    encoding: "utf-8",
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    timedOut: error?.code === "ETIMEDOUT",
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
  };
}

function outputOverrideExecution(output: string | null): ProbeExecutionResult {
  return {
    stdout: output ?? "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

function captureProbeExecution(
  command: readonly string[],
  timeoutMs: number,
  opts: {
    outputOverride?: string | null;
    executionOverride?: ProbeExecutionResult;
    runCaptureImpl?: NullableRunCaptureFn;
    runProbeImpl?: RunProbeFn;
  },
): ReturnType<typeof normalizeProbeExecution> {
  if (opts.executionOverride) {
    return normalizeProbeExecution(opts.executionOverride);
  }
  if (opts.outputOverride !== undefined) {
    return normalizeProbeExecution(outputOverrideExecution(opts.outputOverride));
  }
  if (opts.runProbeImpl) {
    return normalizeProbeExecution(opts.runProbeImpl(command, { timeout: timeoutMs }));
  }
  if (opts.runCaptureImpl) {
    return normalizeProbeExecution(
      outputOverrideExecution(
        opts.runCaptureImpl(command, {
          ignoreError: true,
          timeout: timeoutMs,
        }),
      ),
    );
  }
  return normalizeProbeExecution(defaultRunProbe(command, { timeout: timeoutMs }));
}

function probeCombinedOutput(execution: ReturnType<typeof normalizeProbeExecution>): string {
  return [execution.stdout, execution.stderr].filter((part) => String(part || "").trim()).join("\n");
}

function outputTail(output: string, maxLength = 400): string {
  return output.trim().slice(-maxLength);
}

function probeExecutionDetails(
  label: string,
  execution: ReturnType<typeof normalizeProbeExecution>,
  timeoutMs: number,
  output: string,
): string {
  const details = [
    execution.timedOut ? `${label} timed out after ${Math.ceil(timeoutMs / 1000)}s` : null,
    execution.signal ? `${label} was killed by signal ${execution.signal}` : null,
    execution.exitCode !== null && execution.exitCode !== 0
      ? `${label} exited with status ${execution.exitCode}`
      : null,
    execution.error,
    output.trim() ? outputTail(output) : null,
  ].filter((line): line is string => Boolean(line));
  return details.length > 0 ? details.join("\n") : `${label} produced no output`;
}

function executionFailureReason(
  label: string,
  execution: ReturnType<typeof normalizeProbeExecution>,
  timeoutMs: number,
  output: string,
): Pick<DnsProbeResult, "reason" | "details" | "timedOut" | "exitCode" | "signal"> | null {
  if (execution.timedOut) {
    return {
      reason: "timeout",
      details: probeExecutionDetails(label, execution, timeoutMs, output),
      timedOut: true,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }
  if (execution.signal) {
    return {
      reason: "killed",
      details: probeExecutionDetails(label, execution, timeoutMs, output),
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }
  return null;
}

function isImagePullFailure(output: string): boolean {
  // Note: "Unable to find image" is the normal cold-pull banner Docker
  // prints before a successful pull, so it is not a failure signature.
  return /Error response from daemon:.*(pull|manifest|not found)|pull access denied|manifest.*unknown|unauthorized: authentication required|Head.*https?:\/\/.*: dial/i.test(
    output,
  );
}

function isRegistryResolutionFailure(output: string): boolean {
  // DNS-resolution signatures only. A "dial tcp ip:port: i/o timeout" is
  // a TCP-connectivity failure, not a DNS failure, and must not be
  // routed to the UDP:53/systemd-resolved remediation path.
  return /lookup .*: no such host|temporary failure in name resolution|could not resolve|getaddrinfo|server misbehaving|dial tcp: lookup|no such host/i.test(
    output,
  );
}

function isVethUnsupported(output: string): boolean {
  // The Jetson signature is specifically "failed to add the host <…>
  // sandbox veth pair interfaces: operation not supported". Generic
  // "veth" mentions or unrelated "operation not supported" errors must
  // NOT be classified as veth_unsupported (which is fatal), so require
  // the veth-pair-create wording together with the OS error.
  return /failed to add the host .* sandbox veth pair interfaces: operation not supported|veth pair[^.]*?operation not supported/i.test(
    output,
  );
}

/**
 * Random subdomain of the RFC 6761 reserved .invalid TLD. Every compliant
 * resolver returns NXDOMAIN immediately for any .invalid name, so the
 * probe round-trips through the upstream DNS server without depending on
 * any specific A record being reachable from the container. The random
 * suffix prevents the answer from being served from Docker's embedded
 * DNS cache (or any upstream cache), which is what masked host-side
 * egress blocks for the previous `registry.npmjs.org` query in #3630.
 *
 * Exported so tests can pin the probe-name pattern; production callers
 * never need to override this.
 */
export function dnsProbeName(): string {
  return `nemoclaw-dns-probe-${randomBytes(8).toString("hex")}.invalid`;
}

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
 * - `timeout` / `killed` / `error` — probe couldn't complete.
 * - `no_output` — probe exited cleanly but produced no parseable output.
 */
export function probeContainerDns(opts: ProbeContainerDnsOpts = {}): DnsProbeResult {
  // We funnel through `sh -c` so we can `2>&1` the docker pull progress
  // and busybox nslookup diagnostics into stdout — both write the
  // signatures the parser below depends on (`Error response from daemon`,
  // `no servers could be reached`) to stderr. probeName is the only
  // non-constant token interpolated into the shell script: validate it
  // as a plain DNS name (RFC 1035 label chars) so a crafted override
  // cannot inject arbitrary shell tokens.
  const probeName = opts.probeName ?? dnsProbeName();
  if (!/^[a-z0-9]([a-z0-9.-]{0,253})$/i.test(probeName)) {
    throw new Error(
      `probeName must be a plain DNS name (RFC 1035 label characters), got: ${JSON.stringify(probeName)}`,
    );
  }
  const command = opts.command ?? [
    "sh",
    "-c",
    `docker run --rm --pull=missing ${BUSYBOX_PROBE_IMAGE} nslookup ${probeName} 2>&1`,
  ];

  // Pre-pull the busybox image so the timed probe below measures only
  // probe time, not registry pull time. A cold-cache pull that times out
  // here surfaces as an inconclusive image_pull_failed (registry-DNS
  // signature still routes through isRegistryResolutionFailure), not as
  // a fatal probe timeout with a misleading "restart Docker" hint.
  //
  // Any test seam that injects probe execution (output/execution/command
  // overrides or runCapture/runProbe replacements) implies the caller is
  // staying off the real Docker CLI — skip pre-pull so hermetic tests on
  // hosts without Docker/busybox keep working.
  const bypassRealDocker =
    opts.executionOverride !== undefined ||
    opts.outputOverride !== undefined ||
    opts.command !== undefined ||
    opts.runCaptureImpl !== undefined ||
    opts.runProbeImpl !== undefined;
  if (!bypassRealDocker || opts.ensureImageCachedOverride !== undefined) {
    const cached = opts.ensureImageCachedOverride ?? ensureProbeImageCached(BUSYBOX_PROBE_IMAGE);
    if (!cached.ok) {
      // inspect_unavailable means the docker daemon itself is wedged
      // (assessHost said it was reachable, but image-inspect now hangs
      // or returns "Cannot connect to the Docker daemon"). Treat that as
      // a fatal docker_daemon_unreachable — distinct from generic
      // probe `error` reasons that callers may want to keep inconclusive.
      if (cached.reason === "inspect_unavailable") {
        return {
          ok: false,
          reason: "docker_daemon_unreachable",
          details: cached.details ?? "docker image inspect did not complete",
        };
      }
      return {
        ok: false,
        reason: "image_pull_failed",
        details: cached.details ?? `docker pull ${BUSYBOX_PROBE_IMAGE} did not complete`,
        timedOut: cached.reason === "pull_timeout",
      };
    }
  }

  let execution: ReturnType<typeof normalizeProbeExecution>;
  try {
    execution = captureProbeExecution(command, PROBE_TIMEOUT_MS, opts);
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      details: String((e as Error)?.message ?? e),
    };
  }

  const output = probeCombinedOutput(execution);
  const executionFailure = executionFailureReason(
    "docker DNS probe",
    execution,
    PROBE_TIMEOUT_MS,
    output,
  );
  if (executionFailure) {
    return {
      ok: false,
      ...executionFailure,
    };
  }

  // Treat whitespace-only output (e.g., bare newlines left by a killed
  // child) the same as empty — otherwise the subsequent regex checks all
  // miss and we'd mis-report it as `resolution_failed`.
  if (!output.trim()) {
    if (execution.exitCode !== null && execution.exitCode !== 0) {
      return {
        ok: false,
        reason: "error",
        details: probeExecutionDetails("docker DNS probe", execution, PROBE_TIMEOUT_MS, output),
        timedOut: false,
        exitCode: execution.exitCode,
        signal: execution.signal,
      };
    }
    return {
      ok: false,
      reason: "no_output",
      details: "docker DNS probe produced no output",
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }

  if (isVethUnsupported(output)) {
    return {
      ok: false,
      reason: "veth_unsupported",
      details: outputTail(output),
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }

  // Success: the resolver answered the probe. Two shapes count as success:
  //   1. busybox nslookup prints "Name:" + "Address:" lines for a normal
  //      resolution (kept for back-compat with custom probe names that do
  //      resolve to a real A record).
  //   2. busybox nslookup prints "Server: ..." + "** server can't find
  //      ...: NXDOMAIN" for the .invalid probe we send by default. NXDOMAIN
  //      proves the resolver was reached even though the name does not
  //      resolve, which is the only invariant we need to prove DNS works.
  //      Before #3630 we only accepted the Address shape and used
  //      `registry.npmjs.org`, so a Docker-embedded-DNS cache hit could
  //      mask a host-side egress block. The .invalid probe is never cached
  //      anywhere, so reaching the resolver is genuine round-trip evidence.
  // The resolver identification block — every busybox nslookup response
  // begins with `Server: ... / Address: <ip>:53` — proves only that we
  // reached *something* claiming to be a resolver, not that we got an
  // answer. Real success requires either an actual `Name:`+`Address:`
  // resolution pair OR an NXDOMAIN response body. Keep this line-based so
  // CodeQL does not treat partial host regexes as URL validation.
  const outputLines = output.split(/\r?\n/).map((line) => line.trim());
  const hasResolverHeader = outputLines.some((line) => {
    const fields = line.split(/\s+/);
    return fields[0] === "Server:" && Boolean(fields[1]);
  });
  const hasResolvedName = outputLines.some((line) => {
    const fields = line.split(/\s+/);
    return fields[0] === "Name:" && Boolean(fields[1]);
  });
  const hasAddress = outputLines.some((line) => {
    const fields = line.split(/\s+/);
    return fields[0] === "Address:" && /^\d/.test(fields[1] ?? "");
  });
  const hasNxdomainAnswer = outputLines.some((line) => {
    const lower = line.toLowerCase();
    return lower.includes("server can't find") && lower.includes("nxdomain");
  });
  if (hasResolverHeader && ((hasResolvedName && hasAddress) || hasNxdomainAnswer)) {
    return { ok: true };
  }

  // Docker image-pull failure — the probe never got to run nslookup, so
  // framing this as a DNS problem would mislead. Signatures from
  // `docker run --pull=missing` when the daemon can't fetch the image.
  if (isImagePullFailure(output)) {
    return {
      ok: false,
      reason: "image_pull_failed",
      details: outputTail(output),
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }

  // UDP:53 egress blocked — the #2101 signature. nslookup gave up after
  // its retry budget without getting any DNS response.
  if (/no servers could be reached|connection timed out/i.test(output)) {
    return {
      ok: false,
      reason: "servers_unreachable",
      details: outputTail(output),
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }

  // Resolver responded but couldn't answer. Only report resolution_failed
  // (fatal) when we actually saw the resolver-identification block from
  // nslookup — otherwise the probe never proved DNS is broken (e.g.
  // unrelated docker daemon output where nslookup never ran), so fall
  // through to inconclusive `error` so onboarding does not falsely abort.
  if (hasResolverHeader) {
    return {
      ok: false,
      reason: "resolution_failed",
      details: outputTail(output),
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }
  return {
    ok: false,
    reason: "error",
    details: outputTail(output),
    timedOut: false,
    exitCode: execution.exitCode,
    signal: execution.signal,
  };
}

export function isFatalContainerDnsProbeFailure(result: DnsProbeResult): boolean {
  if (result.ok) return false;
  if (
    result.reason === "servers_unreachable" ||
    result.reason === "resolution_failed" ||
    result.reason === "timeout" ||
    result.reason === "killed" ||
    result.reason === "veth_unsupported" ||
    result.reason === "docker_daemon_unreachable"
  ) {
    return true;
  }
  // Generic `error` (runner/transport failures, unexpected output) stays
  // inconclusive — the probe never established that container DNS is
  // broken, so aborting onboarding would be wrong. Daemon outages route
  // through `docker_daemon_unreachable` above; pull failures through the
  // image_pull_failed branch below.
  return result.reason === "image_pull_failed" && isRegistryResolutionFailure(result.details ?? "");
}

export function probeDockerBridgeContainerStart(
  opts: ProbeDockerBridgeContainerStartOpts = {},
): DockerBridgeContainerStartProbeResult {
  const command = opts.command ?? [
    "docker",
    "run",
    "--rm",
    "--pull=missing",
    "--network",
    "bridge",
    BUSYBOX_PROBE_IMAGE,
    "true",
  ];

  // Pre-pull so a slow-registry cold-cache pull does not get charged
  // against the bridge probe budget and falsely reported as a Jetson/
  // bridge timeout (see issue #3630 codex review). Test seams that
  // bypass real Docker (executionOverride/command/runProbeImpl) skip the
  // pre-pull so hermetic tests on hosts without Docker keep working.
  const bypassRealDocker =
    opts.executionOverride !== undefined ||
    opts.command !== undefined ||
    opts.runProbeImpl !== undefined;
  if (!bypassRealDocker || opts.ensureImageCachedOverride !== undefined) {
    const cached = opts.ensureImageCachedOverride ?? ensureProbeImageCached(BUSYBOX_PROBE_IMAGE);
    if (!cached.ok) {
      // inspect_unavailable means docker daemon is wedged — emit the
      // distinct docker_daemon_unreachable reason so onboard preflight
      // can fail fast while still leaving generic bridge probe `error`
      // reasons (e.g. a daemon with no default bridge network) on the
      // inconclusive path.
      if (cached.reason === "inspect_unavailable") {
        return {
          ok: false,
          reason: "docker_daemon_unreachable",
          details: cached.details ?? "docker image inspect did not complete",
        };
      }
      return {
        ok: false,
        reason: "image_pull_failed",
        details: cached.details ?? `docker pull ${BUSYBOX_PROBE_IMAGE} did not complete`,
        timedOut: cached.reason === "pull_timeout",
      };
    }
  }

  let execution: ReturnType<typeof normalizeProbeExecution>;
  try {
    execution = captureProbeExecution(command, PROBE_TIMEOUT_MS, opts);
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      details: String((e as Error)?.message ?? e),
    };
  }

  const output = probeCombinedOutput(execution);
  const executionFailure = executionFailureReason(
    "docker bridge container start probe",
    execution,
    PROBE_TIMEOUT_MS,
    output,
  );
  if (executionFailure) {
    return {
      ok: false,
      reason: executionFailure.reason as DockerBridgeContainerStartProbeResult["reason"],
      details: executionFailure.details,
      timedOut: executionFailure.timedOut,
      exitCode: executionFailure.exitCode,
      signal: executionFailure.signal,
    };
  }

  if (execution.exitCode === 0) {
    return { ok: true, exitCode: 0, signal: null, timedOut: false };
  }

  if (isVethUnsupported(output)) {
    return {
      ok: false,
      reason: "veth_unsupported",
      details: outputTail(output),
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }

  if (isImagePullFailure(output)) {
    return {
      ok: false,
      reason: "image_pull_failed",
      details: outputTail(output),
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }

  if (!output.trim()) {
    return {
      ok: false,
      reason: execution.exitCode === null ? "no_output" : "error",
      details: probeExecutionDetails(
        "docker bridge container start probe",
        execution,
        PROBE_TIMEOUT_MS,
        output,
      ),
      timedOut: false,
      exitCode: execution.exitCode,
      signal: execution.signal,
    };
  }

  return {
    ok: false,
    reason: "error",
    details: outputTail(output),
    timedOut: false,
    exitCode: execution.exitCode,
    signal: execution.signal,
  };
}
