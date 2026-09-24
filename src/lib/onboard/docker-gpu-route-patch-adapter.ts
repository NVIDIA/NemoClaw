// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SelectedDockerGpuRoute } from "./docker-gpu-route";

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
