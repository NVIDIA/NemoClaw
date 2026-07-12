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

/**
 * Source-of-truth boundary for Jetson/Tegra supplementary device groups:
 *
 * - Invalid state: the non-root sandbox user can see `/dev/nvmap` and `/dev/nvhost-*` but cannot
 *   open them because Docker did not copy their host-owned supplementary GIDs into the container.
 * - Source boundary: host device-node ownership is authoritative; NemoClaw only carries each
 *   bounded, non-root numeric GID into the Jetson compatibility recreation via `--group-add`.
 * - Source-fix constraint: changing host udev ownership or image-local groups cannot reliably fix
 *   device nodes whose ownership is assigned by the Jetson host at runtime.
 * - Regression coverage: docker-gpu-jetson-groups.test.ts covers discovery and hostile numeric
 *   values; docker-gpu-patch-jetson.test.ts covers clone-envelope propagation and generic-host
 *   exclusion.
 * - Removal condition: remove this probe when the minimum supported native OpenShell Jetson path
 *   propagates the host device groups without compatibility container recreation.
 */
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
