// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Portable admission must know whether the current user's systemd/cgroup
// hierarchy can actually enforce the sandbox CPU limit before any sandbox
// build or creation. OpenShell applies the limit through rootless Podman,
// which needs the `cpu` controller delegated down to the current user's
// `app.slice`. The stock systemd `user@.service` delegates only `pids memory`,
// so a host can pass the generic rootless-Podman checks and still fail at
// sandbox creation (gh #9188).
//
// The check is deliberately credential-free and read-only: it reads
// `cgroup.controllers` files under /sys/fs/cgroup and never edits systemd
// units, never uses sudo, and never weakens resource isolation. When the
// hierarchy cannot enforce the CPU limit, the caller must fail early with a
// diagnostic that distinguishes the four failure modes and states the exact
// administrator remediation, then require the user to rerun the preflight.

import fs from "node:fs";

export type CpuDelegationFailureReason =
  | "cgroups-v2-unavailable"
  | "cpu-controller-unavailable"
  | "systemd-user-delegation-missing"
  | "app-slice-cpu-unavailable";

export interface CpuDelegationPreflight {
  readonly ok: boolean;
  readonly failure?: CpuDelegationFailureReason;
  readonly detail: string;
}

export interface CpuDelegationPreflightDeps {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly readFileSync?: (file: string, encoding: "utf8") => string;
}

const CGROUP_ROOT = "/sys/fs/cgroup";

export function cpuDelegationControllerPaths(uid: number): {
  readonly root: string;
  readonly userManager: string;
  readonly appSlice: string;
} {
  return {
    root: `${CGROUP_ROOT}/cgroup.controllers`,
    userManager: `${CGROUP_ROOT}/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
    appSlice: `${CGROUP_ROOT}/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/cgroup.controllers`,
  };
}

function controllerNames(content: string): Set<string> {
  return new Set(content.split(/\s+/u).filter((token) => token.length > 0));
}

function readControllers(
  file: string,
  readFileSync: (file: string, encoding: "utf8") => string,
): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function inspectPortableCpuDelegation(
  deps: CpuDelegationPreflightDeps = {},
): CpuDelegationPreflight {
  if ((deps.platform ?? process.platform) !== "linux") {
    return {
      ok: true,
      detail: "CPU-delegation preflight only applies on Linux; skipping.",
    };
  }
  const uid = deps.uid ?? process.geteuid?.() ?? process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) {
    return {
      ok: true,
      detail: "Could not resolve the current user ID; CPU-delegation preflight skipped.",
    };
  }
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const { root, userManager, appSlice } = cpuDelegationControllerPaths(Number(uid));

  const rootContent = readControllers(root, readFileSync);
  if (rootContent === null) {
    return {
      ok: false,
      failure: "cgroups-v2-unavailable",
      detail:
        `cgroups v2 is not available: ${root} is missing or unreadable. ` +
        "Rootless Podman cannot enforce the sandbox CPU limit without a cgroups v2 " +
        "kernel and mount. Boot a cgroups v2 host and rerun the portable preflight.",
    };
  }
  const rootControllers = controllerNames(rootContent);
  if (!rootControllers.has("cpu")) {
    return {
      ok: false,
      failure: "cpu-controller-unavailable",
      detail:
        `The kernel cgroup hierarchy does not expose the cpu controller: ${root} ` +
        `is "${rootContent.trim()}" (no "cpu"). Rootless Podman cannot enforce the ` +
        "sandbox CPU limit. Enable the cpu controller in the kernel cgroup hierarchy " +
        "and rerun the portable preflight.",
    };
  }

  const userManagerContent = readControllers(userManager, readFileSync);
  if (userManagerContent === null) {
    return {
      ok: false,
      failure: "systemd-user-delegation-missing",
      detail:
        `The current user's systemd manager has no cgroup controllers file ` +
        `(${userManager} missing or unreadable), so systemd has not delegated any ` +
        "controllers to it. Have an administrator add `Delegate=cpu memory pids` to " +
        "user@.service (for example via `systemctl edit user@.service`), restart the " +
        "user manager, and rerun the portable preflight.",
    };
  }
  const userManagerControllers = controllerNames(userManagerContent);
  if (!userManagerControllers.has("cpu")) {
    return {
      ok: false,
      failure: "systemd-user-delegation-missing",
      detail:
        `systemd did not delegate the cpu controller to the current user's manager: ` +
        `${userManager} is "${userManagerContent.trim()}" (no "cpu"). The stock ` +
        "user@.service delegates only `pids memory`. Have an administrator add " +
        "`Delegate=cpu memory pids` to user@.service (for example via `systemctl edit " +
        "user@.service`), restart the user manager, and rerun the portable preflight.",
    };
  }

  const appSliceContent = readControllers(appSlice, readFileSync);
  if (appSliceContent === null) {
    return {
      ok: false,
      failure: "app-slice-cpu-unavailable",
      detail:
        `The current user's app.slice has no cgroup controllers file (${appSlice} ` +
        "missing or unreadable), so the cpu controller is not available to it for " +
        "this boot. Restart the user manager (or the host) after the delegation " +
        "change and rerun the portable preflight.",
    };
  }
  const appSliceControllers = controllerNames(appSliceContent);
  if (!appSliceControllers.has("cpu")) {
    return {
      ok: false,
      failure: "app-slice-cpu-unavailable",
      detail:
        `The cpu controller is not available to the current user's app.slice for ` +
        `this boot: ${appSlice} is "${appSliceContent.trim()}" (no "cpu"). Restart ` +
        "the user manager (or the host) after the delegation change and rerun the " +
        "portable preflight.",
    };
  }

  return {
    ok: true,
    detail:
      "The current user's systemd/cgroup hierarchy can enforce the sandbox CPU " +
      "limit: the cpu controller is exposed, delegated to the user manager, and " +
      "available to app.slice.",
  };
}

export function portableCpuDelegationError(preflight: CpuDelegationPreflight): Error {
  return new Error(`Portable CPU-delegation preflight failed: ${preflight.detail}`);
}
