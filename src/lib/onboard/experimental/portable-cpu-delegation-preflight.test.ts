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
    if (value === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${file}'`);
    }
    return value;
  };
}

const UID = 1001;
const PATHS = cpuDelegationControllerPaths(UID);

const CPU_FULL = "cpuset cpu io memory pids";
const NO_CPU = "cpuset io memory pids";

describe("inspectPortableCpuDelegation", () => {
  it("skips the check on non-Linux platforms", () => {
    const preflight = inspectPortableCpuDelegation({ platform: "darwin", uid: UID });
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

  it("reports cgroups v2 unavailable when the root controllers file is unreadable", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: (file: string) => {
        if (file === PATHS.root) throw new Error("EACCES: permission denied");
        throw new Error("ENOENT");
      },
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroups-v2-unavailable");
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

  it("reports when systemd did not delegate cpu to the user manager (missing file)", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("systemd-user-delegation-missing");
    expect(preflight.detail).toContain("Delegate=cpu memory pids");
  });

  it("reports when systemd did not delegate cpu to the user manager (no cpu token)", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userManager]: NO_CPU,
        [PATHS.appSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("systemd-user-delegation-missing");
    expect(preflight.detail).toContain("user@.service");
  });

  it("reports when the cpu controller is not available to app.slice for this boot", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
        [PATHS.appSlice]: NO_CPU,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("app-slice-cpu-unavailable");
    expect(preflight.detail).toContain("app.slice");
  });

  it("reports when the app.slice controllers file is missing", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("app-slice-cpu-unavailable");
  });

  it("passes when cpu is delegated through the whole current-user hierarchy", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readFileSync: files({
        [PATHS.root]: CPU_FULL,
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
