// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { dockerCapture, dockerRm, dockerRun } from "../adapters/docker";
import { hasZeroDockerExitStatus } from "./docker-command-result";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import type {
  DockerGpuPatchBackend,
  DockerGpuPatchDeps,
  DockerGpuPatchMode,
  DockerGpuPatchModeAttempt,
  DockerGpuPatchModeKind,
} from "./docker-gpu-patch-types";

function resultText(result: {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | null;
}): string {
  return `${String(result.stderr || "")} ${String(result.stdout || "")} ${String(
    result.error?.message || "",
  )}`.trim();
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
  if (kind === "startup-command") {
    return {
      kind,
      label: "persistent sandbox startup command",
      device: "",
      args: [],
    };
  }
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
  options: {
    cdiAvailable?: boolean;
    backend?: DockerGpuPatchBackend;
    dockerDesktopWsl?: boolean;
  } = {},
): DockerGpuPatchMode[] {
  if (options.backend === "jetson") {
    return [buildDockerGpuMode("nvidia-runtime", device, { backend: "jetson" })];
  }
  // Match OpenShell's CDI preference when a usable NVIDIA spec is present,
  // while retaining --gpus and the NVIDIA runtime as compatibility fallbacks.
  // Docker Desktop WSL may advertise CDI directories without a resolvable
  // nvidia.com/gpu device, so its compatibility route deliberately skips CDI.
  const candidates: DockerGpuPatchMode[] = [];
  if (options.cdiAvailable && !options.dockerDesktopWsl) {
    candidates.push(buildDockerGpuMode("cdi", device));
  }
  candidates.push(buildDockerGpuMode("gpus", device), buildDockerGpuMode("nvidia-runtime", device));
  return candidates;
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

export const DEFAULT_DOCKER_CDI_SPEC_DIRS = ["/etc/cdi", "/var/run/cdi"] as const;

function readCdiSpecContent(
  filePath: string,
  readFile?: (path: string) => string | null,
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
  readFile?: (path: string) => string | null,
): boolean {
  if (!/\.(json|ya?ml)$/i.test(filePath)) return false;
  const content = readCdiSpecContent(filePath, readFile);
  return content !== null && /nvidia\.com\/gpu|nvidia-container|libcuda|cuda/i.test(content);
}

function listDirEntries(
  dirPath: string,
  readDir?: (path: string) => string[] | null,
): string[] | null {
  if (readDir) return readDir(dirPath);
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return null;
  }
}

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
  const capture = deps.dockerCapture ?? dockerCapture;
  let raw = "";
  try {
    raw = capture(["info", "--format", "{{json .CDISpecDirs}}"], {
      ignoreError: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
  } catch {
    // The default CDI directories may still contain a valid NVIDIA spec.
  }
  for (const dir of resolveCdiScanDirs(parseDockerCdiSpecDirs(raw))) {
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
  const run = deps.dockerRun ?? dockerRun;
  const remove = deps.dockerRm ?? dockerRm;
  const probeName = `nemoclaw-gpu-probe-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  try {
    const result = run(["create", "--name", probeName, ...mode.args, image, "true"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    const ok = hasZeroDockerExitStatus(result);
    return { ok, error: ok ? null : resultText(result) || "docker create failed" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    remove(probeName, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
  }
}

export function selectDockerGpuPatchMode(
  options: {
    image: string;
    device?: string | null;
    backend?: DockerGpuPatchBackend;
    dockerDesktopWsl?: boolean;
  },
  deps: DockerGpuPatchDeps = {},
): { mode: DockerGpuPatchMode | null; attempts: DockerGpuPatchModeAttempt[] } {
  const cdiAvailable = options.backend === "jetson" ? false : dockerReportsNvidiaCdiDevices(deps);
  const attempts: DockerGpuPatchModeAttempt[] = [];
  for (const mode of buildDockerGpuModeCandidates(options.device, {
    cdiAvailable,
    backend: options.backend,
    dockerDesktopWsl: options.dockerDesktopWsl,
  })) {
    const result = probeDockerGpuMode(mode, options.image, deps);
    const attempt = { mode, ok: result.ok, error: result.error };
    attempts.push(attempt);
    if (attempt.ok) return { mode, attempts };
  }
  return { mode: null, attempts };
}
