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
// diagnostic that distinguishes hierarchy and read failure modes and states
// the exact administrator remediation, then require the user to rerun the
// preflight.

import fs from "node:fs";

export type CpuDelegationFailureReason =
  | "cgroups-v2-unavailable"
  | "cgroup-controllers-unreadable"
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

type ControllerRead =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly condition: "missing" | "unreadable";
      readonly errorCode?: string;
    };

function readControllers(
  file: string,
  readFileSync: (file: string, encoding: "utf8") => string,
): ControllerRead {
  try {
    return { ok: true, content: readFileSync(file, "utf8") };
  } catch (error) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    return {
      ok: false,
      condition: errorCode === "ENOENT" || errorCode === "ENOTDIR" ? "missing" : "unreadable",
      ...(errorCode ? { errorCode } : {}),
    };
  }
}

function unreadableControllersDetail(file: string, errorCode?: string): string {
  const code = errorCode ? ` (${errorCode})` : "";
  return (
    `NemoClaw could not read the cgroup controllers file ${file}${code}. ` +
    "Have an administrator inspect the cgroup mount permissions and active Linux " +
    "security policy, then make this exact file readable to the current user. Do not " +
    "change systemd delegation until the preflight can inspect the file."
  );
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

  const rootRead = readControllers(root, readFileSync);
  if (!rootRead.ok) {
    if (rootRead.condition === "unreadable") {
      return {
        ok: false,
        failure: "cgroup-controllers-unreadable",
        detail: unreadableControllersDetail(root, rootRead.errorCode),
      };
    }
    return {
      ok: false,
      failure: "cgroups-v2-unavailable",
      detail:
        `cgroups v2 is not available: ${root} is missing. ` +
        "Rootless Podman cannot enforce the sandbox CPU limit without a cgroups v2 " +
        "kernel and mount. Boot a cgroups v2 host and rerun the portable preflight.",
    };
  }
  const rootContent = rootRead.content;
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

  const userManagerRead = readControllers(userManager, readFileSync);
  if (!userManagerRead.ok) {
    if (userManagerRead.condition === "unreadable") {
      return {
        ok: false,
        failure: "cgroup-controllers-unreadable",
        detail: unreadableControllersDetail(userManager, userManagerRead.errorCode),
      };
    }
    return {
      ok: false,
      failure: "systemd-user-delegation-missing",
      detail:
        `The current user's systemd manager has no cgroup controllers file ` +
        `(${userManager} is missing), so systemd has not exposed controllers to it. ` +
        "Have an administrator apply both CPU controller settings described in the " +
        "troubleshooting guide: `Delegate=cpu memory pids` for `user@.service` and " +
        "`CPUWeight=100` for `app.slice`. Then stop and start the user manager as " +
        "documented and rerun the portable preflight.",
    };
  }
  const userManagerContent = userManagerRead.content;
  const userManagerControllers = controllerNames(userManagerContent);
  if (!userManagerControllers.has("cpu")) {
    return {
      ok: false,
      failure: "systemd-user-delegation-missing",
      detail:
        `systemd did not delegate the cpu controller to the current user's manager: ` +
        `${userManager} is "${userManagerContent.trim()}" (no "cpu"). The stock ` +
        "user@.service delegates only `pids memory`. Have an administrator apply both " +
        "CPU controller settings described in the troubleshooting guide: " +
        "`Delegate=cpu memory pids` for `user@.service` and `CPUWeight=100` for " +
        "`app.slice`. Then stop and start the user manager as documented and rerun " +
        "the portable preflight.",
    };
  }

  const appSliceRead = readControllers(appSlice, readFileSync);
  if (!appSliceRead.ok) {
    if (appSliceRead.condition === "unreadable") {
      return {
        ok: false,
        failure: "cgroup-controllers-unreadable",
        detail: unreadableControllersDetail(appSlice, appSliceRead.errorCode),
      };
    }
    return {
      ok: false,
      failure: "app-slice-cpu-unavailable",
      detail:
        `The current user's app.slice has no cgroup controllers file (${appSlice} is ` +
        "missing), so the cpu controller is not available to it for this boot. " +
        "Have an administrator apply the documented app.slice CPU controller setting " +
        "and delegation change. Then stop and start the user manager as documented " +
        "(or reboot the host) and rerun the portable preflight.",
    };
  }
  const appSliceContent = appSliceRead.content;
  const appSliceControllers = controllerNames(appSliceContent);
  if (!appSliceControllers.has("cpu")) {
    return {
      ok: false,
      failure: "app-slice-cpu-unavailable",
      detail:
        `The cpu controller is not available to the current user's app.slice for ` +
        `this boot: ${appSlice} is "${appSliceContent.trim()}" (no "cpu"). Have an ` +
        "administrator apply the documented app.slice CPU controller setting and " +
        "delegation change. Then stop and start the user manager as documented (or " +
        "reboot the host) and rerun the portable preflight.",
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
