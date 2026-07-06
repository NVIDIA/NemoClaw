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
 * Source-of-truth and bounded compatibility contract for GPU creates (#6110).
 *
 * The invalid state is a single create attempt that combines native OpenShell
 * `--gpu` injection with compatibility container recreation. This function is
 * the host/control boundary that selects the route; downstream argument
 * rendering may suppress native GPU flags, but must not choose another route.
 *
 * The older `buildSandboxGpuCreateArgs(..., { suppressGpuFlag: true })` seam is
 * still exported through `onboard.ts` for already-shipped internal consumers.
 * Production routing does not consult it, and removing that export in this
 * behavior-neutral forward fix would turn the routing change into an API
 * removal. The route matrix in `docker-gpu-sandbox-create.test.ts` and the
 * suppression case in `sandbox-gpu-create.test.ts` guard this separation.
 * Remove the seam in a separately versioned cleanup only after downstream
 * callers are audited and migrated to `renderSandboxCreateArgsForGpuRoute`.
 * The compatibility route itself can be retired only when Docker Desktop WSL,
 * Jetson, and the legacy nonzero `NEMOCLAW_DOCKER_GPU_PATCH` contract no longer
 * require container recreation.
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
      return "  Automatic sandbox GPU enabled; trying native OpenShell injection with compatibility fallback.";
    case "native-only":
      return "  Direct sandbox GPU enabled; allowing OpenShell GPU policy enrichment.";
    default: {
      const exhaustiveRoute: never = route;
      throw new Error(`Unhandled Docker GPU route: ${exhaustiveRoute}`);
    }
  }
}
