// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  cpuDelegationControllerPaths,
  inspectPortableCpuDelegation,
  portableCpuDelegationError,
} from "./portable-cpu-delegation-preflight";

function files(
  contents: Record<string, Buffer | string>,
): (file: string, maxBytes: number) => Buffer {
  return (file: string, maxBytes: number) => {
    const value =
      contents[file] ??
      (() => {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
          code: "ENOENT",
        });
      })();
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    return bytes.subarray(0, maxBytes);
  };
}

function unreadableAt(
  unreadableFile: string,
  contents: Record<string, Buffer | string>,
): (file: string, maxBytes: number) => Buffer {
  const readFile = files(contents);
  const throwUnreadable = (file: string): never => {
    throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
      code: "EACCES",
    });
  };
  return (file: string, maxBytes: number) =>
    file === unreadableFile ? throwUnreadable(file) : readFile(file, maxBytes);
}

const UID = 1001;
const PATHS = cpuDelegationControllerPaths(UID);

const CPU_FULL = "cpuset cpu io memory pids";
const NO_CPU = "cpuset io memory pids";
const MALFORMED = "cpu memory\nDelegate=cpu";

function expectManagerInterruptionGuidance(detail: string): void {
  const saveWork = detail.indexOf("Save the current user's work");
  const stopManager = detail.indexOf("stops the user manager");
  const startFailure = detail.indexOf("start fails with 219/CGROUP");
  const laterLogin = detail.indexOf("start a later login session");
  const saveHostWork = detail.indexOf("save every user's work first");
  const reboot = detail.indexOf("reboot the host");

  expect(saveWork).toBeGreaterThanOrEqual(0);
  expect(saveWork).toBeLessThan(stopManager);
  expect(startFailure).toBeGreaterThan(stopManager);
  expect(laterLogin).toBeGreaterThan(startFailure);
  expect(saveHostWork).toBeGreaterThan(laterLogin);
  expect(saveHostWork).toBeLessThan(reboot);
}

function expectThreeCpuControllerSettings(detail: string): void {
  expect(detail).toContain("`CPUWeight=100` for `user-1001.slice`");
  expect(detail).toContain("`Delegate=cpu memory pids` for `user@.service`");
  expect(detail).toContain("`CPUWeight=100` for `app.slice`");
}

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
      readControllerFileSync: files({}),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroups-v2-unavailable");
    expect(preflight.detail).toContain("cgroups v2");
    expect(preflight.detail.indexOf("save every user's work")).toBeLessThan(
      preflight.detail.indexOf("Boot a cgroups v2 host"),
    );
  });

  it("reports access recovery when the root controllers file is unreadable", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: unreadableAt(PATHS.root, {}),
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
      readControllerFileSync: files({
        [PATHS.root]: NO_CPU,
        [PATHS.userManager]: CPU_FULL,
        [PATHS.appSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cpu-controller-unavailable");
    expect(preflight.detail).toContain('no "cpu"');
    expect(preflight.detail.indexOf("save every user's work")).toBeLessThan(
      preflight.detail.indexOf("Enable the cpu controller"),
    );
  });

  it("reports when systemd did not delegate cpu to the user manager (missing file)", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("systemd-user-delegation-missing");
    expectThreeCpuControllerSettings(preflight.detail);
    expectManagerInterruptionGuidance(preflight.detail);
  });

  it.each([
    ["is missing", files({ [PATHS.root]: CPU_FULL })],
    ["does not expose cpu", files({ [PATHS.root]: CPU_FULL, [PATHS.userSlice]: NO_CPU })],
  ] as const)(
    "reports when the per-user systemd slice %s (#9188)",
    (_condition, readControllerFile) => {
      const readControllerFileSync = vi.fn(readControllerFile);
      const preflight = inspectPortableCpuDelegation({
        platform: "linux",
        uid: UID,
        readControllerFileSync,
      });

      expect(preflight.ok).toBe(false);
      expect(preflight.failure).toBe("systemd-user-slice-cpu-unavailable");
      expect(preflight.detail).toContain(PATHS.userSlice);
      expectThreeCpuControllerSettings(preflight.detail);
      expectManagerInterruptionGuidance(preflight.detail);
      expect(readControllerFileSync.mock.calls).toEqual([
        [PATHS.root, 4097],
        [PATHS.userSlice, 4097],
      ]);
    },
  );

  it("reports access recovery when the per-user slice evidence is unreadable (#9188)", () => {
    const readControllerFileSync = vi.fn(unreadableAt(PATHS.userSlice, { [PATHS.root]: CPU_FULL }));
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync,
    });

    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroup-controllers-unreadable");
    expect(preflight.detail).toContain(PATHS.userSlice);
    expect(preflight.detail).toContain("Do not change systemd delegation");
    expect(preflight.detail).not.toContain("CPUWeight=100");
    expect(readControllerFileSync.mock.calls).toEqual([
      [PATHS.root, 4097],
      [PATHS.userSlice, 4097],
    ]);
  });

  it("reports access recovery when the user manager controllers file is unreadable", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: unreadableAt(PATHS.userManager, {
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
      readControllerFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: NO_CPU,
        [PATHS.appSlice]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("systemd-user-delegation-missing");
    expectThreeCpuControllerSettings(preflight.detail);
    expectManagerInterruptionGuidance(preflight.detail);
  });

  it("reports when the cpu controller is not available to app.slice for this boot", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: files({
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
    expectManagerInterruptionGuidance(preflight.detail);
  });

  it("reports when the app.slice controllers file is missing", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
      }),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("app-slice-cpu-unavailable");
    expect(preflight.detail).toContain("CPU controller setting");
    expectManagerInterruptionGuidance(preflight.detail);
  });

  it("reports access recovery when the app.slice controllers file is unreadable", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: unreadableAt(PATHS.appSlice, {
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

  it.each([
    ["root", PATHS.root, {}],
    ["per-user slice", PATHS.userSlice, { [PATHS.root]: CPU_FULL }],
    ["user manager", PATHS.userManager, { [PATHS.root]: CPU_FULL, [PATHS.userSlice]: CPU_FULL }],
    [
      "app.slice",
      PATHS.appSlice,
      {
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
      },
    ],
  ])(
    "rejects malformed %s controller evidence before remediation (#9188)",
    (_name, path, prefix) => {
      const preflight = inspectPortableCpuDelegation({
        platform: "linux",
        uid: UID,
        readControllerFileSync: files({ ...prefix, [path]: MALFORMED }),
      });

      expect(preflight.ok).toBe(false);
      expect(preflight.failure).toBe("cgroup-controllers-malformed");
      expect(preflight.detail).toContain(path);
      expect(preflight.detail).toContain("evidence is malformed");
      expect(preflight.detail).not.toContain(MALFORMED);
      expect(preflight.detail).not.toContain("Delegate=cpu memory pids");
      expect(preflight.detail).not.toContain("CPUWeight=100");
      expect(preflight.detail).not.toContain("stop and start");
    },
  );

  it.each([
    ["NUL bytes", Buffer.from("cpu\0memory", "utf8")],
    ["oversized content", Buffer.alloc(4097, 0x61)],
    ["duplicate controller names", "cpu cpu memory"],
  ])("rejects %s as malformed controller evidence (#9188)", (_case, content) => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: files({ [PATHS.root]: content }),
    });

    expect(preflight.ok).toBe(false);
    expect(preflight.failure).toBe("cgroup-controllers-malformed");
    expect(preflight.detail).toContain(PATHS.root);
    expect(preflight.detail).not.toContain("Delegate=cpu memory pids");
    expect(preflight.detail).not.toContain("CPUWeight=100");
  });

  it("caps each controller read at the evidence limit plus one sentinel byte (#9188)", () => {
    const readControllerFileSync = vi.fn(
      files({
        [PATHS.root]: CPU_FULL,
        [PATHS.userSlice]: CPU_FULL,
        [PATHS.userManager]: CPU_FULL,
        [PATHS.appSlice]: CPU_FULL,
      }),
    );

    expect(
      inspectPortableCpuDelegation({ platform: "linux", uid: UID, readControllerFileSync }).ok,
    ).toBe(true);
    expect(readControllerFileSync.mock.calls).toEqual([
      [PATHS.root, 4097],
      [PATHS.userSlice, 4097],
      [PATHS.userManager, 4097],
      [PATHS.appSlice, 4097],
    ]);
  });

  it("passes when cpu is delegated through the whole current-user hierarchy", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: files({
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
      readControllerFileSync: files({}),
    });
    expect(preflight.ok).toBe(true);
  });

  it("formats a throwable error from a failed inspection", () => {
    const preflight = inspectPortableCpuDelegation({
      platform: "linux",
      uid: UID,
      readControllerFileSync: files({}),
    });
    const error = portableCpuDelegationError(preflight);
    expect(error.message).toContain("Portable CPU-delegation preflight failed");
    expect(error.message).toContain("cgroups v2");
  });
});
