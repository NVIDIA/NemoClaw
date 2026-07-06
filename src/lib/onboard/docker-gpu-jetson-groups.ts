// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

const TEGRA_GPU_DEVICE_NODES = [
  "/dev/nvmap",
  "/dev/nvhost-ctrl",
  "/dev/nvhost-ctrl-gpu",
  "/dev/nvhost-gpu",
  "/dev/nvhost-as-gpu",
  "/dev/nvhost-prof-gpu",
  "/dev/nvhost-dbg-gpu",
  "/dev/nvhost-tsg-gpu",
  "/dev/nvgpu/igpu0/ctrl",
  "/dev/nvgpu/igpu0/as",
  "/dev/nvgpu/igpu0/prof",
] as const;
const MAX_DOCKER_SUPPLEMENTARY_GID = 2_147_483_647;

/** Find supplementary groups required to access Jetson/Tegra GPU device nodes. */
export function detectTegraDeviceGroupGids(
  deps: { statDeviceGid?: (path: string) => number | null } = {},
): string[] {
  const statGid =
    deps.statDeviceGid ??
    ((path: string): number | null => {
      try {
        return fs.statSync(path).gid;
      } catch {
        return null;
      }
    });
  const gids = new Set<string>();
  for (const node of TEGRA_GPU_DEVICE_NODES) {
    const gid = statGid(node);
    if (
      gid !== null &&
      Number.isSafeInteger(gid) &&
      gid > 0 &&
      gid <= MAX_DOCKER_SUPPLEMENTARY_GID
    ) {
      gids.add(String(gid));
    }
  }
  return [...gids].sort((left, right) => Number(left) - Number(right));
}
