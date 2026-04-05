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

// runner.js is CJS — use require so we don't pull it into the TS build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runCapture } = require("../../bin/lib/runner");

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

export type ContainerRuntime =
  | "docker"
  | "docker-desktop"
  | "colima"
  | "podman"
  | "unknown";

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
  requiresHostCgroupnsFix: boolean;
  isUnsupportedRuntime: boolean;
  isHeadlessLikely: boolean;
  hasNvidiaGpu: boolean;
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
  runCaptureImpl?: (command: string, options?: { ignoreError?: boolean }) => string;
  commandExistsImpl?: (commandName: string) => boolean;
  gpuProbeImpl?: () => boolean;
}

function commandExists(
  commandName: string,
  runCaptureImpl: (command: string, options?: { ignoreError?: boolean }) => string,
): boolean {
  try {
    const output = runCaptureImpl(`command -v ${commandName}`, { ignoreError: true });
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

function readDockerDefaultCgroupnsMode(
  readFileImpl: (filePath: string, encoding: BufferEncoding) => string,
): "host" | "private" | "unknown" {
  try {
    const raw = readFileImpl("/etc/docker/daemon.json", "utf-8");
    const parsed = JSON.parse(raw) as { ["default-cgroupns-mode"]?: unknown };
    const mode = parsed["default-cgroupns-mode"];
    return mode === "host" || mode === "private" ? mode : "unknown";
  } catch {
    return "unknown";
  }
}

function isHeadlessLikely(env: NodeJS.ProcessEnv): boolean {
  return !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERM_PROGRAM;
}

function detectNvidiaGpu(
  runCaptureImpl: (command: string, options?: { ignoreError?: boolean }) => string,
): boolean {
  if (!commandExists("nvidia-smi", runCaptureImpl)) {
    return false;
  }
  return Boolean(String(runCaptureImpl("nvidia-smi -L", { ignoreError: true }) || "").trim());
}

function detectPackageManager(
  runCaptureImpl: (command: string, options?: { ignoreError?: boolean }) => string,
): PackageManager {
  if (commandExists("apt-get", runCaptureImpl)) return "apt";
  if (commandExists("dnf", runCaptureImpl)) return "dnf";
  if (commandExists("yum", runCaptureImpl)) return "yum";
  if (commandExists("brew", runCaptureImpl)) return "brew";
  if (commandExists("pacman", runCaptureImpl)) return "pacman";
  return "unknown";
}

function parseSystemctlState(value = ""): boolean | null {
  const normalized = String(value || "").trim().toLowerCase();
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
    ((command: string, options?: { ignoreError?: boolean }) =>
      runCapture(command, { ignoreError: options?.ignoreError ?? false }));
  const readFileImpl = opts.readFileImpl ?? fs.readFileSync;
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
    dockerInfoOutput = runCaptureImpl("docker info --format '{{json .}}' 2>/dev/null", {
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
  const dockerDefaultCgroupnsMode = readDockerDefaultCgroupnsMode(readFileImpl);
  const dockerServiceActive =
    platform === "linux" && systemctlAvailable && dockerInstalled
      ? parseSystemctlState(runCaptureImpl("systemctl is-active docker", { ignoreError: true }))
      : null;
  const dockerServiceEnabled =
    platform === "linux" && systemctlAvailable && dockerInstalled
      ? parseSystemctlState(runCaptureImpl("systemctl is-enabled docker", { ignoreError: true }))
      : null;
  const assessment: HostAssessment = {
    platform,
    isWsl: detectWsl({ platform, env, release, procVersion }),
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
    // Current OpenShell sets host cgroupns on its own cluster container.
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: runtime === "podman",
    isHeadlessLikely: isHeadlessLikely(env),
    hasNvidiaGpu,
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
      reason: "Headless Linux hosts often need explicit remote UI handling if you want browser access.",
      commands: ["Set `CHAT_UI_URL` when remote browser access matters."],
      blocking: false,
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
  const p = port ?? 18789;
  const o = opts || {};

  // ── lsof path ──────────────────────────────────────────────────
  if (!o.skipLsof) {
    let lsofOut: string | undefined;
    if (typeof o.lsofOutput === "string") {
      lsofOut = o.lsofOutput;
    } else {
      const hasLsof = runCapture("command -v lsof", { ignoreError: true });
      if (hasLsof) {
        lsofOut = runCapture(`lsof -i :${p} -sTCP:LISTEN -P -n 2>/dev/null`, {
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
          `sudo -n lsof -i :${p} -sTCP:LISTEN -P -n 2>/dev/null`,
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
      const memBytes = parseInt(runCapture("sysctl -n hw.memsize", { ignoreError: true }), 10);
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
    runCapture("sudo swapon /swapfile", { ignoreError: false });
    return { ok: true, totalMB: mem.totalMB + 4096, swapCreated: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `found orphaned /swapfile but could not activate it: ${message}`,
    };
  }
}

function checkSwapDiskSpace(): SwapResult | null {
  try {
    const dfOut = runCapture("df / --output=avail -k 2>/dev/null | tail -1", {
      ignoreError: true,
    });
    const freeKB = parseInt((dfOut || "").trim(), 10);
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
    runCapture(`mkdir -p ${nemoclawDir}`, { ignoreError: true });
  }

  try {
    fs.writeFileSync(path.join(nemoclawDir, "managed_swap"), "/swapfile");
  } catch {
    // Best effort marker write.
  }
}

function cleanupPartialSwap(): void {
  try {
    runCapture("sudo swapoff /swapfile 2>/dev/null || true", { ignoreError: true });
    runCapture("sudo rm -f /swapfile", { ignoreError: true });
  } catch {
    // Best effort cleanup
  }
}

function createSwapfile(mem: MemoryInfo): SwapResult {
  try {
    runCapture("sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none", {
      ignoreError: false,
    });
    runCapture("sudo chmod 600 /swapfile", { ignoreError: false });
    runCapture("sudo mkswap /swapfile", { ignoreError: false });
    runCapture("sudo swapon /swapfile", { ignoreError: false });
    runCapture(
      "grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
      { ignoreError: false },
    );
    writeManagedSwapMarker();

    return { ok: true, totalMB: mem.totalMB + 4096, swapCreated: true };
  } catch (err: unknown) {
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
  const o = {
    platform: process.platform as NodeJS.Platform,
    memoryInfo: null as MemoryInfo | null,
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
