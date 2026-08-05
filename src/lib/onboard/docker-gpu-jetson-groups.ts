// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
const NVMAP_DEVICE = "/dev/nvmap";

type DeviceGroupAccess = {
  gid: number;
  mode: number;
};

type DevicePathAccess = {
  isCharacterDevice: boolean;
  isSymbolicLink: boolean;
};

type NvmapDeviceAccess = {
  isCharacterDevice: boolean;
  isSymbolicLink: boolean;
  mode: number;
};

export interface EnsureJetsonNvmapGroupAccessDeps {
  statDevice?: () => NvmapDeviceAccess | null;
  runSetup?: (scriptPath: string) => { status: number | null; error?: Error };
  setupScriptPath?: string;
}

function defaultStatNvmapDevice(): NvmapDeviceAccess | null {
  try {
    const stat = fs.lstatSync(NVMAP_DEVICE);
    return {
      isCharacterDevice: stat.isCharacterDevice(),
      isSymbolicLink: stat.isSymbolicLink(),
      mode: stat.mode,
    };
  } catch {
    return null;
  }
}

function hasGroupReadWriteAccess(access: NvmapDeviceAccess | null): boolean {
  return (
    access !== null &&
    access.isCharacterDevice &&
    !access.isSymbolicLink &&
    ((access.mode >> 3) & READ_WRITE_PERMISSION_BITS) === READ_WRITE_PERMISSION_BITS
  );
}

function runJetsonNvmapSetup(scriptPath: string): { status: number | null; error?: Error } {
  const result = spawnSync("bash", [scriptPath, "--nvmap-only"], {
    env: { ...process.env, NEMOCLAW_AGENT: "openclaw" },
    stdio: "inherit",
  });
  return { status: result.status, ...(result.error ? { error: result.error } : {}) };
}

function setupFailureDetail(result: { status: number | null; error?: Error }): string {
  if (result.error?.message) return result.error.message;
  return `exit status ${result.status === null ? "unknown" : result.status}`;
}

/**
 * Verify the host permission that makes the detected nvmap group useful to the
 * nonroot OpenShell sandbox user. Installer setup is not sufficient at this
 * boundary because onboarding can run directly or after host device state
 * changes. Repair before any sandbox create or replacement begins.
 */
export function ensureJetsonNvmapGroupAccess(deps: EnsureJetsonNvmapGroupAccessDeps = {}): void {
  const statDevice = deps.statDevice ?? defaultStatNvmapDevice;
  if (hasGroupReadWriteAccess(statDevice())) return;

  const setupScriptPath =
    deps.setupScriptPath ?? path.resolve(__dirname, "../../../scripts/setup-jetson.sh");
  const runSetup = deps.runSetup ?? runJetsonNvmapSetup;
  console.log("  Preparing Jetson /dev/nvmap group access before sandbox creation...");
  const result = runSetup(setupScriptPath);
  if (result.status !== 0) {
    throw new Error(
      `Jetson /dev/nvmap group setup failed before sandbox creation (${setupFailureDetail(result)}).`,
    );
  }
  if (!hasGroupReadWriteAccess(statDevice())) {
    throw new Error(
      "Jetson /dev/nvmap still does not grant its owning group read-write access after host setup; refusing sandbox creation.",
    );
  }
}

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
 * Return only existing Jetson GPU character devices that can be granted at
 * the OpenShell Landlock boundary. The fixed candidates keep the policy from
 * widening to unrelated host devices, and lstat prevents symlink traversal.
 */
export function detectTegraGpuDevicePaths(
  deps: {
    statDevicePath?: (path: string) => DevicePathAccess | null;
    listDevicePaths?: () => string[];
  } = {},
): string[] {
  const devicePaths = deps.listDevicePaths?.() ?? listTegraGpuDevicePaths();
  const statPath =
    deps.statDevicePath ??
    ((devicePath: string): DevicePathAccess | null => {
      try {
        const stat = fs.lstatSync(devicePath);
        return {
          isCharacterDevice: stat.isCharacterDevice(),
          isSymbolicLink: stat.isSymbolicLink(),
        };
      } catch {
        return null;
      }
    });
  return devicePaths.filter((devicePath) => {
    const access = statPath(devicePath);
    return access?.isCharacterDevice === true && access.isSymbolicLink === false;
  });
}

/**
 * Source-of-truth boundary for Jetson/Tegra supplementary device groups:
 *
 * - Invalid state: `/dev/nvmap` lacks owning-group read/write access, Landlock omits an injected
 *   Tegra character device, or the non-root sandbox user loses the matching host device GID.
 * - Source boundary: NemoClaw verifies and persists the host nvmap mode, grants exact detected
 *   character-device paths in the route policy, carries each bounded numeric device GID into the
 *   Jetson recreation via `--group-add`, and records matching sandbox account membership before
 *   the supervisor starts.
 * - Source-fix constraint: `--group-add` alone does not survive the supervisor's account-group
 *   initialization, and image-local group names can differ from the host's numeric device GIDs.
 * - Regression coverage: docker-gpu-jetson-groups.test.ts covers path/GID discovery and hostile
 *   numeric values; initial-policy.test.ts covers Landlock grants; setup-jetson.test.ts covers the
 *   host mode; docker-gpu-patch-jetson.test.ts covers clone-envelope and sandbox-account
 *   propagation plus generic-host exclusion.
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
    const groupAddsReadWriteAccess =
      groupAccessBits === READ_WRITE_PERMISSION_BITS &&
      otherAccessBits !== READ_WRITE_PERMISSION_BITS;
    if (
      gid !== null &&
      Number.isSafeInteger(gid) &&
      gid > 0 &&
      gid <= MAX_DOCKER_SUPPLEMENTARY_GID &&
      groupAddsReadWriteAccess
    ) {
      gids.add(String(gid));
    }
  }
  return [...gids].sort((left, right) => Number(left) - Number(right));
}
