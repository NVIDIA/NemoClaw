// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import { dockerInfoFormat as defaultDockerInfoFormat } from "../adapters/docker";

const WSL_DOCKER_DESKTOP_DETECTION_TIMEOUT_MS = 30_000;
export const WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND =
  "docker run --rm --gpus all nvcr.io/nvidia/k8s/cuda-sample:nbody nbody -gpu -benchmark";

// Source-of-truth for this compatibility branch: Docker Desktop-backed WSL can
// advertise Docker CDI directories while the WSL distro cannot see a usable
// nvidia.com/gpu CDI spec. Retire this workaround only after Docker Desktop
// exposes usable nvidia.com/gpu CDI specs into WSL, or after OpenShell owns a
// Docker Desktop WSL GPU path that no longer relies on host-visible CDI specs.
export const WSL_DOCKER_DESKTOP_GPU_COMPATIBILITY_REMOVAL_CONDITION =
  "Remove this compatibility path when Docker Desktop exposes usable nvidia.com/gpu CDI specs into WSL, or OpenShell no longer requires host-visible CDI specs for Docker Desktop WSL GPU passthrough.";

export type WslDockerDesktopStatus = "docker-desktop" | "not-docker-desktop" | "unknown";

export type WslDockerDesktopHost = {
  isWsl: boolean;
  runtime?: string | null;
};

export type WslDockerDesktopDetectionDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
  procVersion?: string;
  readFileImpl?: (filePath: string, encoding: BufferEncoding) => string;
  dockerInfoFormat?: (format: string, opts?: Record<string, unknown>) => string;
};

export type WslDockerDesktopGpuCompatibilityAction = {
  id: "wsl_docker_desktop_gpu_compatibility";
  title: string;
  kind: "info";
  reason: string;
  commands: string[];
  blocking: false;
};

export function isWslDockerDesktopRuntime(host: WslDockerDesktopHost): boolean {
  return host.isWsl && host.runtime === "docker-desktop";
}

function detectWsl(deps: WslDockerDesktopDetectionDeps): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return false;
  const env = deps.env ?? process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  const release = deps.release ?? os.release();
  if (/microsoft/i.test(release)) return true;
  const procVersion =
    deps.procVersion ??
    (() => {
      try {
        const readFileImpl =
          deps.readFileImpl ??
          ((filePath: string, encoding: BufferEncoding) => fs.readFileSync(filePath, encoding));
        return readFileImpl("/proc/version", "utf-8");
      } catch {
        return "";
      }
    })();
  return /microsoft/i.test(procVersion);
}

function detectDockerDesktopRuntime(deps: WslDockerDesktopDetectionDeps): WslDockerDesktopStatus {
  const dockerInfo = deps.dockerInfoFormat ?? defaultDockerInfoFormat;
  try {
    const output = String(
      dockerInfo("{{json .OperatingSystem}}", {
        ignoreError: true,
        timeout: WSL_DOCKER_DESKTOP_DETECTION_TIMEOUT_MS,
      }),
    ).trim();
    if (!output || output === "<no value>") return "unknown";
    return /^"?docker desktop\b/i.test(output) ? "docker-desktop" : "not-docker-desktop";
  } catch {
    return "unknown";
  }
}

export function detectWslDockerDesktopStatus(
  deps: WslDockerDesktopDetectionDeps = {},
): WslDockerDesktopStatus {
  if (!detectWsl(deps)) return "not-docker-desktop";
  return detectDockerDesktopRuntime(deps);
}

export function wslDockerDesktopGpuCompatibilityRemediationLines(
  status: WslDockerDesktopStatus,
): string[] | null {
  if (status === "docker-desktop") {
    return [
      "Docker Desktop WSL detected; NemoClaw uses Docker --gpus compatibility instead of CDI spec validation.",
      "If sandbox GPU setup later fails, verify from WSL:",
      `  ${WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND}`,
      "Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.",
    ];
  }
  if (status === "unknown") {
    return [
      "WSL detected, but NemoClaw could not determine whether Docker is Docker Desktop or native Docker Engine.",
      "If using Docker Desktop, confirm Settings > Resources > WSL integration is enabled for this distro, restart Docker Desktop, and verify:",
      `  ${WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND}`,
      "If using native Docker Engine inside WSL, install/configure NVIDIA Container Toolkit CDI, then restart Docker.",
      "Or force CPU sandbox behavior with NEMOCLAW_SANDBOX_GPU=0.",
    ];
  }
  return null;
}

export function wslDockerDesktopGpuCompatibilityAction(): WslDockerDesktopGpuCompatibilityAction {
  return {
    id: "wsl_docker_desktop_gpu_compatibility",
    title: "Use Docker Desktop WSL GPU compatibility path",
    kind: "info",
    reason:
      "Docker Desktop is configured for CDI device injection (CDISpecDirs is set) but no " +
      "nvidia.com/gpu CDI spec is visible from WSL. On Docker Desktop-backed WSL, NemoClaw " +
      "uses Docker's `--gpus` compatibility path instead of trying to repair Linux host CDI " +
      "from inside the WSL distro.",
    commands: [
      `If sandbox GPU setup later fails, verify Docker Desktop GPU support from WSL with \`${WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND}\`.`,
      "Rerun with `--no-gpu` to skip GPU passthrough.",
    ],
    blocking: false,
  };
}
