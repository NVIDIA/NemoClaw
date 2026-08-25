// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { dockerCapture, dockerRm, dockerRun } from "../adapters/docker";
import { sleepSeconds } from "../core/wait";
import { hasZeroDockerExitStatus } from "./docker-command-result";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import { normalizeSandboxGpuDeviceForCdi } from "./sandbox-gpu-create";
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
  const cdiDevice = normalizeSandboxGpuDeviceForCdi(device);
  if (!cdiDevice || cdiDevice === "nvidia.com/gpu=all") return "all";
  return cdiDevice.slice("nvidia.com/gpu=".length);
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
  pullPolicy: "missing" | "never",
): { ok: boolean; error: string | null; cleanupConfirmed: boolean } {
  const run = deps.dockerRun ?? dockerRun;
  const remove = deps.dockerRm ?? dockerRm;
  const probeName = `nemoclaw-gpu-probe-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  let outcome: { ok: boolean; error: string | null };
  try {
    const pullArgs = pullPolicy === "never" ? ["--pull", "never"] : [];
    const result = run(["create", "--name", probeName, ...pullArgs, ...mode.args, image, "true"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    const ok = hasZeroDockerExitStatus(result);
    outcome = { ok, error: ok ? null : resultText(result) || "docker create failed" };
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let cleanupConfirmed = false;
  try {
    const removal = remove(probeName, {
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
    });
    cleanupConfirmed =
      hasZeroDockerExitStatus(removal) || isMissingDockerContainer(removal, probeName);
  } catch {
    // Reconcile below before another Docker mutation.
  }
  if (!cleanupConfirmed) {
    try {
      const inspection = run(["container", "inspect", probeName], {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      cleanupConfirmed = isMissingDockerContainer(inspection, probeName);
    } catch {
      // An inconclusive read makes the probe terminal.
    }
  }
  if (!cleanupConfirmed) {
    outcome = {
      ok: false,
      error: outcome.ok
        ? "Docker GPU probe succeeded, but cleanup could not confirm container removal"
        : `${outcome.error ?? "docker create failed"}; cleanup could not confirm container removal`,
    };
  }
  return { ...outcome, cleanupConfirmed };
}

function isMissingDockerContainer(
  result: {
    status?: number | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
  },
  containerName: string,
): boolean {
  const text = resultText(result);
  return result.status !== 0 && /no such container/i.test(text) && text.includes(containerName);
}

function isTransientDockerDesktopGpuProbeFailure(error: string | null): boolean {
  return /(?:\b(?:http|status(?: code)?)\D{0,8}5\d{2}\b|internal server error|connection reset|unexpected eof|temporarily unavailable)/i.test(
    error || "",
  );
}

export function selectDockerGpuPatchMode(
  options: {
    image: string;
    device?: string | null;
    backend?: DockerGpuPatchBackend;
    dockerDesktopWsl?: boolean;
    pullPolicy?: "never";
  },
  deps: DockerGpuPatchDeps = {},
): { mode: DockerGpuPatchMode | null; attempts: DockerGpuPatchModeAttempt[] } {
  const cdiAvailable = options.backend === "jetson" ? false : dockerReportsNvidiaCdiDevices(deps);
  const attempts: DockerGpuPatchModeAttempt[] = [];
  const attemptsPerMode = options.dockerDesktopWsl ? 2 : 1;
  const sleep = deps.sleep ?? sleepSeconds;
  for (const mode of buildDockerGpuModeCandidates(options.device, {
    cdiAvailable,
    backend: options.backend,
    dockerDesktopWsl: options.dockerDesktopWsl,
  })) {
    for (let attemptNumber = 0; attemptNumber < attemptsPerMode; attemptNumber += 1) {
      const result = probeDockerGpuMode(mode, options.image, deps, options.pullPolicy ?? "missing");
      const attempt = { mode, ok: result.ok, error: result.error };
      attempts.push(attempt);
      if (!result.cleanupConfirmed) return { mode: null, attempts };
      if (attempt.ok) return { mode, attempts };
      if (
        attemptNumber + 1 < attemptsPerMode &&
        isTransientDockerDesktopGpuProbeFailure(attempt.error)
      ) {
        sleep(1);
      } else {
        break;
      }
    }
  }
  return { mode: null, attempts };
}
