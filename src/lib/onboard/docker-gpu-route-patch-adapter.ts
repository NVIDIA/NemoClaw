// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  initialDockerGpuRoute,
  resolveDockerGpuRoutePlan,
  type SelectedDockerGpuRoute,
} from "./docker-gpu-route";

export type DockerGpuPatchRouteAdapter = {
  enabled: boolean;
  additionalSummaryLines: readonly string[];
};

/** Translate orchestration policy into the route-agnostic patch interface. */
export function adaptDockerGpuRouteForPatch(
  route: SelectedDockerGpuRoute,
): DockerGpuPatchRouteAdapter {
  return {
    enabled: route === "compatibility",
    additionalSummaryLines: [`selected_gpu_route=${route}`],
  };
}

/** Compatibility facade for callers that only need the initial patch decision. */
export function shouldApplyDockerGpuPatch(
  config: { sandboxGpuEnabled: boolean; hostGpuPlatform?: string | null },
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    dockerDriverGateway?: boolean;
    dockerDesktopWsl?: boolean;
    log?: (message: string) => void;
  } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const dockerDesktopWsl = options.dockerDesktopWsl === true;
  const dockerDriverGateway =
    options.dockerDriverGateway ?? (platform === "linux" || dockerDesktopWsl);
  const route = initialDockerGpuRoute(
    resolveDockerGpuRoutePlan(config, {
      dockerDriverGateway,
      dockerDesktopWsl,
      env: options.env,
      platform,
      log: options.log,
    }),
  );
  return adaptDockerGpuRouteForPatch(route).enabled;
}
