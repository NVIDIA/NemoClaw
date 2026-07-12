// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type DockerGpuRoutePlan, resolveDockerGpuRoutePlan } from "./docker-gpu-route";
import { detectWslDockerDesktopStatus } from "./wsl-docker-desktop-gpu";

type DockerGpuSandboxConfig = {
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice?: string | null;
  hostGpuPlatform?: string | null;
};

type DockerGpuSandboxCreatePlan = {
  gpuRoutePlan: DockerGpuRoutePlan;
  logMessage: string | null;
};

// NemoClaw onboarding is a short-lived process, and the active Docker daemon cannot switch
// between native Linux and Docker Desktop WSL during one run. Cache that stable host fact for the
// process lifetime; tests that substitute the probe explicitly reset it between scenarios.
let cachedDockerDesktopWslRuntime: boolean | null = null;

export function isDockerDesktopWslRuntime(): boolean {
  if (cachedDockerDesktopWslRuntime === null) {
    cachedDockerDesktopWslRuntime = detectWslDockerDesktopStatus({}) === "docker-desktop";
  }
  return cachedDockerDesktopWslRuntime;
}

export function resetIsDockerDesktopWslRuntimeCache(): void {
  cachedDockerDesktopWslRuntime = null;
}

/**
 * SOURCE_OF_TRUTH_REVIEW (GPU create route selection; #6110)
 * invalidState: one attempt combines native `--gpu` with compatibility recreation.
 * sourceBoundary: this host-control step selects the route; renderers may only implement it.
 * whyNotSourceFix: the shipped suppressGpuFlag seam cannot be removed atomically with consumers.
 * regressionTest: Docker GPU route matrix plus the legacy suppression case.
 * removalCondition: migrate that seam separately, and retire compatibility after WSL, Jetson, and
 *   legacy nonzero NEMOCLAW_DOCKER_GPU_PATCH no longer require recreation.
 */
export function resolveDockerGpuSandboxCreatePlan(
  config: DockerGpuSandboxConfig,
  options: {
    dockerDriverGateway: boolean;
    dockerDesktopWsl?: boolean;
    detectDockerDesktopWsl?: () => boolean;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    log?: (message: string) => void;
  },
): DockerGpuSandboxCreatePlan {
  const dockerDesktopWsl =
    options.dockerDesktopWsl ?? (options.detectDockerDesktopWsl ?? isDockerDesktopWslRuntime)();
  const gpuRoutePlan = resolveDockerGpuRoutePlan(config, {
    dockerDriverGateway: options.dockerDriverGateway,
    dockerDesktopWsl,
    env: options.env,
    platform: options.platform,
    log: options.log,
  });
  const logMessage = config.sandboxGpuEnabled
    ? gpuRouteLogMessage(gpuRoutePlan, config.hostGpuPlatform)
    : null;
  return { gpuRoutePlan, logMessage };
}

function gpuRouteLogMessage(
  route: DockerGpuRoutePlan,
  hostGpuPlatform: string | null | undefined,
): string | null {
  switch (route) {
    case "none":
      return null;
    case "compatibility-only":
      return hostGpuPlatform === "jetson"
        ? "  Jetson sandbox GPU enabled; using NVIDIA Container Runtime instead of CDI/--gpus."
        : "  Docker-driver GPU patch active; allowing /proc writes required by Docker GPU initialization.";
    case "native-with-fallback":
      return "  Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.";
    case "native-only":
      return "  Direct sandbox GPU enabled; allowing OpenShell GPU policy enrichment.";
    default: {
      const exhaustiveRoute: never = route;
      throw new Error(`Unhandled Docker GPU route: ${exhaustiveRoute}`);
    }
  }
}
