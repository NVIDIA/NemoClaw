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
const READ_WRITE_PERMISSION_BITS = 0o6;
const MAX_DOCKER_SUPPLEMENTARY_GID = 2_147_483_647;

type DeviceGroupAccess = {
  gid: number;
  mode: number;
};

/**
 * Find real DRI render character devices without following symlinks or
 * scanning other DRI device families.
 */
function discoverTegraRenderDevicePaths(): string[] {
  try {
    return fs
      .readdirSync("/dev/dri", { withFileTypes: true })
      .filter(
        (entry) =>
          /^renderD\d+$/u.test(entry.name) && entry.isCharacterDevice() && !entry.isSymbolicLink(),
      )
      .map((entry) => `/dev/dri/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Combine the selected Tegra GPU nodes with DRI render devices, whose owner
 * GID and node number can differ across hosts.
 */
function listTegraGpuDevicePaths(): string[] {
  return [...TEGRA_GPU_DEVICE_NODES, ...discoverTegraRenderDevicePaths()];
}

/**
 * Source-of-truth boundary for Jetson/Tegra supplementary device groups:
 *
 * - Invalid state: the non-root sandbox user can see `/dev/nvmap` and `/dev/nvhost-*` but cannot
 *   open them because Docker did not copy their host-owned supplementary GIDs into the container.
 * - Source boundary: host device-node ownership is authoritative; NemoClaw only carries each
 *   bounded, non-root numeric GID with effective group read/write permission into the Jetson
 *   compatibility recreation via `--group-add`.
 * - Source-fix constraint: changing host udev ownership or image-local groups cannot reliably fix
 *   device nodes whose ownership is assigned by the Jetson host at runtime.
 * - Regression coverage: docker-gpu-jetson-groups.test.ts covers discovery and hostile numeric
 *   values; docker-gpu-patch-jetson.test.ts covers clone-envelope propagation and generic-host
 *   exclusion.
 * - Removal condition: remove this probe when the minimum supported native OpenShell Jetson path
 *   propagates the host device groups without compatibility container recreation.
 */
export function detectTegraDeviceGroupGids(
  deps: {
    statDeviceAccess?: (path: string) => DeviceGroupAccess | null;
    listDevicePaths?: () => string[];
  } = {},
): string[] {
  const devicePaths = deps.listDevicePaths?.() ?? listTegraGpuDevicePaths();
  const statAccess =
    deps.statDeviceAccess ??
    ((path: string): DeviceGroupAccess | null => {
      try {
        const stat = fs.lstatSync(path);
        return stat.isCharacterDevice() && !stat.isSymbolicLink()
          ? { gid: stat.gid, mode: stat.mode }
          : null;
      } catch {
        return null;
      }
    });
  const gids = new Set<string>();
  for (const node of devicePaths) {
    const access = statAccess(node);
    const gid = access?.gid ?? null;
    const groupAccessBits = access === null ? 0 : (access.mode >> 3) & READ_WRITE_PERMISSION_BITS;
    const otherAccessBits = access === null ? 0 : access.mode & READ_WRITE_PERMISSION_BITS;
    const groupAddsAccess = (groupAccessBits & ~otherAccessBits) !== 0;
    if (
      gid !== null &&
      Number.isSafeInteger(gid) &&
      gid > 0 &&
      gid <= MAX_DOCKER_SUPPLEMENTARY_GID &&
      groupAddsAccess
    ) {
      gids.add(String(gid));
    }
  }
  return [...gids].sort((left, right) => Number(left) - Number(right));
}
