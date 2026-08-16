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
  | "cgroup-controllers-malformed"
  | "cpu-controller-unavailable"
  | "systemd-user-slice-cpu-unavailable"
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
  readonly readControllerFileSync?: (file: string, maxBytes: number) => Buffer;
}

const CGROUP_ROOT = "/sys/fs/cgroup";
const MAX_CONTROLLER_EVIDENCE_BYTES = 4096;
const CONTROLLER_NAME = /^[a-z][a-z0-9_]*$/u;

export function cpuDelegationControllerPaths(uid: number): {
  readonly root: string;
  readonly userSlice: string;
  readonly userManager: string;
  readonly appSlice: string;
} {
  return {
    root: `${CGROUP_ROOT}/cgroup.controllers`,
    userSlice: `${CGROUP_ROOT}/user.slice/user-${uid}.slice/cgroup.controllers`,
    userManager: `${CGROUP_ROOT}/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
    appSlice: `${CGROUP_ROOT}/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/cgroup.controllers`,
  };
}

function cpuControllerSettingsGuidance(uid: number): string {
  return (
    "Have an administrator apply all three CPU controller settings described in the " +
    `troubleshooting guide: \`CPUWeight=100\` for \`user-${uid}.slice\`, ` +
    "`Delegate=cpu memory pids` for `user@.service`, and `CPUWeight=100` for " +
    "`app.slice`. "
  );
}

type ControllerEvidence =
  | { readonly ok: true; readonly content: string; readonly names: ReadonlySet<string> }
  | { readonly ok: false };

function parseControllerEvidence(content: Buffer): ControllerEvidence {
  if (content.length > MAX_CONTROLLER_EVIDENCE_BYTES) {
    return { ok: false };
  }

  const body = content.at(-1) === 0x0a ? content.subarray(0, content.length - 1) : content;
  if (body.length === 0) {
    return { ok: true, content: "", names: new Set() };
  }
  if (body.includes(0x0a)) {
    return { ok: false };
  }

  const text = body.toString("utf8");
  const names = text.split(" ");
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length || names.some((name) => !CONTROLLER_NAME.test(name))) {
    return { ok: false };
  }
  return { ok: true, content: text, names: uniqueNames };
}

type ControllerRead =
  | { readonly ok: true; readonly content: Buffer }
  | {
      readonly ok: false;
      readonly condition: "missing" | "unreadable";
      readonly errorCode?: string;
    };

function readControllerFileSync(file: string, maxBytes: number): Buffer {
  const fileDescriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fileDescriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function readControllers(
  file: string,
  readControllerFile: (file: string, maxBytes: number) => Buffer,
): ControllerRead {
  try {
    return {
      ok: true,
      content: readControllerFile(file, MAX_CONTROLLER_EVIDENCE_BYTES + 1),
    };
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

function malformedControllersDetail(file: string): string {
  return (
    `NemoClaw could not classify the cgroup controller evidence because ${file} ` +
    "does not contain the bounded, space-separated controller names supplied by the " +
    "kernel. Have an administrator inspect the cgroup filesystem and active security " +
    "tooling for this exact file. Do not change systemd configuration, stop the user " +
    "manager, or reboot the host while the evidence is malformed. Rerun the portable " +
    "preflight only after the file contains kernel-provided controller names."
  );
}

function managerRecoveryGuidance(): string {
  return (
    "Save the current user's work before the administrator stops the user manager: " +
    "the stop interrupts that user's systemd-managed services. Apply the documented " +
    "stop, daemon-reload, and start sequence. If the start fails with 219/CGROUP, do " +
    "not continue onboarding; have the affected user sign out and start a later login " +
    "session before rerunning the preflight. If host reboot is the alternative, save " +
    "every user's work first: reboot interrupts host workloads. Only then may the " +
    "administrator reboot the host."
  );
}

type ParsedControllers =
  | { readonly ok: true; readonly content: string; readonly names: ReadonlySet<string> }
  | { readonly ok: false; readonly preflight: CpuDelegationPreflight };

function parseControllers(file: string, content: Buffer): ParsedControllers {
  const evidence = parseControllerEvidence(content);
  if (!evidence.ok) {
    return {
      ok: false,
      preflight: {
        ok: false,
        failure: "cgroup-controllers-malformed",
        detail: malformedControllersDetail(file),
      },
    };
  }
  return { ok: true, content: evidence.content, names: evidence.names };
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
  const readControllerFile = deps.readControllerFileSync ?? readControllerFileSync;
  const numericUid = Number(uid);
  const { root, userSlice, userManager, appSlice } = cpuDelegationControllerPaths(numericUid);

  const rootRead = readControllers(root, readControllerFile);
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
        "kernel and mount. Before rebooting this host, save every user's work: reboot " +
        "interrupts host workloads. Boot a cgroups v2 host and rerun the portable " +
        "preflight.",
    };
  }
  const parsedRoot = parseControllers(root, rootRead.content);
  if (!parsedRoot.ok) {
    return parsedRoot.preflight;
  }
  const rootControllers = parsedRoot.names;
  const rootContent = parsedRoot.content;
  if (!rootControllers.has("cpu")) {
    return {
      ok: false,
      failure: "cpu-controller-unavailable",
      detail:
        `The kernel cgroup hierarchy does not expose the cpu controller: ${root} ` +
        `is "${rootContent.trim()}" (no "cpu"). Rootless Podman cannot enforce the ` +
        "sandbox CPU limit. Before rebooting this host, save every user's work: reboot " +
        "interrupts host workloads. Enable the cpu controller in the kernel cgroup " +
        "hierarchy and rerun the portable preflight.",
    };
  }

  const userSliceRead = readControllers(userSlice, readControllerFile);
  if (!userSliceRead.ok) {
    if (userSliceRead.condition === "unreadable") {
      return {
        ok: false,
        failure: "cgroup-controllers-unreadable",
        detail: unreadableControllersDetail(userSlice, userSliceRead.errorCode),
      };
    }
    return {
      ok: false,
      failure: "systemd-user-slice-cpu-unavailable",
      detail:
        `The current user's systemd slice has no cgroup controllers file ` +
        `(${userSlice} is missing), so the cpu controller is not available at the ` +
        `user-${numericUid}.slice ancestor. ` +
        cpuControllerSettingsGuidance(numericUid) +
        managerRecoveryGuidance() +
        " Then rerun the portable preflight.",
    };
  }
  const parsedUserSlice = parseControllers(userSlice, userSliceRead.content);
  if (!parsedUserSlice.ok) {
    return parsedUserSlice.preflight;
  }
  if (!parsedUserSlice.names.has("cpu")) {
    return {
      ok: false,
      failure: "systemd-user-slice-cpu-unavailable",
      detail:
        `The cpu controller is not available at the current user's systemd slice: ` +
        `${userSlice} is "${parsedUserSlice.content.trim()}" (no "cpu"). ` +
        `The user manager and app.slice cannot activate a controller that their ` +
        `user-${numericUid}.slice ancestor did not receive. ` +
        cpuControllerSettingsGuidance(numericUid) +
        managerRecoveryGuidance() +
        " Then rerun the portable preflight.",
    };
  }

  const userManagerRead = readControllers(userManager, readControllerFile);
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
        cpuControllerSettingsGuidance(numericUid) +
        managerRecoveryGuidance() +
        " Then rerun the portable preflight.",
    };
  }
  const parsedUserManager = parseControllers(userManager, userManagerRead.content);
  if (!parsedUserManager.ok) {
    return parsedUserManager.preflight;
  }
  const userManagerControllers = parsedUserManager.names;
  const userManagerContent = parsedUserManager.content;
  if (!userManagerControllers.has("cpu")) {
    return {
      ok: false,
      failure: "systemd-user-delegation-missing",
      detail:
        `systemd did not delegate the cpu controller to the current user's manager: ` +
        `${userManager} is "${userManagerContent.trim()}" (no "cpu"). The stock ` +
        "user@.service delegates only `pids memory`. " +
        cpuControllerSettingsGuidance(numericUid) +
        managerRecoveryGuidance() +
        " Then rerun the portable preflight.",
    };
  }

  const appSliceRead = readControllers(appSlice, readControllerFile);
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
        cpuControllerSettingsGuidance(numericUid) +
        managerRecoveryGuidance() +
        " Then rerun the portable preflight.",
    };
  }
  const parsedAppSlice = parseControllers(appSlice, appSliceRead.content);
  if (!parsedAppSlice.ok) {
    return parsedAppSlice.preflight;
  }
  const appSliceControllers = parsedAppSlice.names;
  const appSliceContent = parsedAppSlice.content;
  if (!appSliceControllers.has("cpu")) {
    return {
      ok: false,
      failure: "app-slice-cpu-unavailable",
      detail:
        `The cpu controller is not available to the current user's app.slice for ` +
        `this boot: ${appSlice} is "${appSliceContent.trim()}" (no "cpu"). ` +
        cpuControllerSettingsGuidance(numericUid) +
        managerRecoveryGuidance() +
        " Then rerun the portable preflight.",
    };
  }

  return {
    ok: true,
    detail:
      "The current user's systemd/cgroup hierarchy can enforce the sandbox CPU " +
      "limit: the cpu controller is exposed at the per-user system slice, delegated " +
      "to the user manager, and available to app.slice.",
  };
}

export function portableCpuDelegationError(preflight: CpuDelegationPreflight): Error {
  return new Error(`Portable CPU-delegation preflight failed: ${preflight.detail}`);
}
