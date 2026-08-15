// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  cpuDelegationControllerPaths,
  inspectPortableCpuDelegation,
  portableCpuDelegationError,
} from "./portable-cpu-delegation-preflight";

function files(contents: Record<string, string>): (file: string) => string {
  return (file: string) => {
    const value = contents[file];
    return (
      value ??
      (() => {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
          code: "ENOENT",
        });
      })()
    );
  };
}

function unreadableAt(
  unreadableFile: string,
  contents: Record<string, string>,
): (file: string) => string {
  const readFile = files(contents);
  const throwUnreadable = (file: string): never => {
    throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
      code: "EACCES",
    });
  };
  return (file: string) => (file === unreadableFile ? throwUnreadable(file) : readFile(file));
}

const UID = 1001;
const PATHS = cpuDelegationControllerPaths(UID);

const CPU_FULL = "cpuset cpu io memory pids";
const NO_CPU = "cpuset io memory pids";

describe("inspectPortableCpuDelegation", () => {
  it("skips the check on non-Linux platforms", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "darwin",
      uid: UID,
    });
    expect(preflight.ok).toBe(true);
  });

  it("reports cgroups v2 unavailable when the root controllers file is missing", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({}),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroups-v2-unavailable");
    expect(preflight.detail).toContain("cgroups v2");
  });

  it("reports access recovery when the root controllers file is unreadable", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: unreadableAt(PATHS.root, {}),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroup-controllers-unreadable");
    expect(preflight.detail).toContain("EACCES");
    expect(preflight.detail).toContain("mount permissions");
    expect(preflight.detail).toContain("security policy");
    expect(preflight.detail).not.toContain("Boot a cgroups v2 host");
  });

  it("reports when the kernel hierarchy does not expose the cpu controller", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: NO_CPU,
        [PATHS.userManager]: CPU_FULL,
        [PATHS.appSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cpu-controller-unavailable");
    expect(preflight.detail).toContain('no "cpu"');
  });

  it.each([
    [PATHS.root, "cpu cpu"],
    [PATHS.userSlice, "CPU memory"],
    [PATHS.userManager, "cpu,memory"],
    [PATHS.appSlice, "cpu memory!"],
  ])(
    "fails closed when %s contains malformed controller evidence",
    (malformedPath, malformedContent) => {
      const preflight = inspectPortableCpuDelegation({
        platform: "linux",
        uid: UID,
        readFileSync: files({
          [PATHS.root]: CPU_FULL,
          [PATHS.userSlice]: CPU_FULL,
          [PATHS.userManager]: CPU_FULL,
          [PATHS.appSlice]: CPU_FULL,
          [malformedPath]: malformedContent,
        }),
      });
      expect(preflight.ok).toBe(false);
      expect(preflight.failure).toBe("cgroup-controllers-malformed");
      expect(preflight.detail).toContain(malformedPath);
      expect(preflight.detail).toContain("mount integrity");
      expect(preflight.detail).toContain("Do not change systemd delegation");
      expect(preflight.detail).not.toContain(malformedContent);
    },
  );

  it.each([
    [PATHS.root, "cpu-controller-unavailable"],
    [PATHS.userSlice, "systemd-user-slice-cpu-unavailable"],
    [PATHS.userManager, "systemd-user-delegation-missing"],
    [PATHS.appSlice, "app-slice-cpu-unavailable"],
  ] as const)("classifies an empty readable controller file at %s", (emptyPath, failure) => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
        [PATHS.appSlice]: CPU_FULL,
        [emptyPath]: "",
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe(failure);
    expect(preflight.detail).toContain('no "cpu"');
  });

  it("reports when the per-user systemd slice has no controllers file", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("systemd-user-slice-cpu-unavailable");
    expect(preflight.detail).toContain("user-1001.slice");
    expect(preflight.detail).toContain("CPUWeight=100 for user-1001.slice");
  });

  it("reports when the per-user systemd slice does not expose cpu", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: NO_CPU,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("systemd-user-slice-cpu-unavailable");
    expect(preflight.detail).toContain('no "cpu"');
  });

  it("reports access recovery when the per-user slice evidence is unreadable", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: unreadableAt(PATHS.userSlice, {
        [PATHS.root]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroup-controllers-unreadable");
    expect(preflight.detail).toContain("EACCES");
    expect(preflight.detail).toContain(PATHS.userSlice);
  });

  it("reports when systemd did not delegate cpu to the user manager (missing file)", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("systemd-user-delegation-missing");
    expect(preflight.detail).toContain("Delegate=cpu memory pids for user@.service");
    expect(preflight.detail).toContain("CPUWeight=100 for user-1001.slice");
    expect(preflight.detail).toContain("CPUWeight=100 for app.slice");
    expect(preflight.detail).toContain("status=219/CGROUP");
    expect(preflight.detail).toContain("save work for every host user");
  });

  it("reports access recovery when the user manager controllers file is unreadable", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: unreadableAt(PATHS.userManager, {
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroup-controllers-unreadable");
    expect(preflight.detail).toContain("EACCES");
    expect(preflight.detail).toContain("Do not change systemd delegation");
    expect(preflight.detail).not.toContain("restart the user manager");
  });

  it("reports when systemd did not delegate cpu to the user manager (no cpu token)", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: NO_CPU,
        [PATHS.appSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("systemd-user-delegation-missing");
    expect(preflight.detail).toContain("Delegate=cpu memory pids for user@.service");
    expect(preflight.detail).toContain("CPUWeight=100 for user-1001.slice");
    expect(preflight.detail).toContain("CPUWeight=100 for app.slice");
  });

  it("reports when the cpu controller is not available to app.slice for this boot", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
        [PATHS.appSlice]: NO_CPU,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("app-slice-cpu-unavailable");
    expect(preflight.detail).toContain("app.slice");
    expect(preflight.detail).toContain("CPU controller setting");
    expect(preflight.detail).toContain("CPUWeight=100 for user-1001.slice");
    expect(preflight.detail).toContain("status=219/CGROUP");
  });

  it("reports when the app.slice controllers file is missing", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("app-slice-cpu-unavailable");
    expect(preflight.detail).toContain("CPU controller setting");
  });

  it("reports access recovery when the app.slice controllers file is unreadable", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: unreadableAt(PATHS.appSlice, {
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroup-controllers-unreadable");
    expect(preflight.detail).toContain("EACCES");
    expect(preflight.detail).toContain("Do not change systemd delegation");
    expect(preflight.detail).not.toContain("Restart the user manager");
  });

  it("passes when cpu is delegated through the whole current-user hierarchy", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
        [PATHS.appSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(true);
    expect(preflight.failure).toBeUndefined();
    expect(preflight.detail).toContain("cpu controller");
  });

  it("skips when the user id cannot be resolved", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: Number.NaN,
      readFileSync: files({}),
    });
    expect(preflight.ok).toBe(true);
  });

  it("formats a throwable error from a failed inspection", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({}),
    });
    const error = portableCpuDelegationError(preflight);
    expect(error.message).toContain("Portable CPU-delegation preflight failed");
    expect(error.message).toContain("cgroups v2");
  });
});
