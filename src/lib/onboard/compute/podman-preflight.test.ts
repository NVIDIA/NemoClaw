// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assessNativePodman,
  isPodmanVersionSupported,
  nativePodmanSocketCandidates,
} from "./podman-preflight";

const INFO = JSON.stringify({
  host: {
    arch: "amd64",
    os: "linux",
    cgroupVersion: "v2",
    networkBackend: "netavark",
    security: { rootless: true },
  },
});

function successfulRun(command: string, args: readonly string[]) {
  if (command !== "podman") return { status: 1, stdout: "", stderr: "unexpected command" };
  if (args[0] === "--version") {
    return { status: 0, stdout: "podman version 5.6.2\n", stderr: "" };
  }
  if (args[0] === "unshare") {
    return { status: 0, stdout: "0 1000 1\n1 100000 65536\n", stderr: "" };
  }
  return { status: 0, stdout: INFO, stderr: "" };
}

describe("native Podman preflight", () => {
  it.each([
    ["4.9.9", false],
    ["5.0.0", true],
    ["5.6.2", true],
    ["6.0.0-dev", true],
    ["unknown", false],
  ])("checks supported version %s", (version, expected) => {
    expect(isPodmanVersionSupported(version)).toBe(expected);
  });

  it("uses explicit socket authority without falling through to ambient candidates", () => {
    expect(
      nativePodmanSocketCandidates({
        env: {
          HOME: "/home/tester",
          XDG_RUNTIME_DIR: "/run/user/1000",
          OPENSHELL_PODMAN_SOCKET: "/runtime/podman.sock",
        },
        uid: 1000,
      }),
    ).toEqual(["/runtime/podman.sock"]);
  });

  it("qualifies Linux amd64 rootless Podman through the exact API socket", () => {
    const receipt = assessNativePodman({
      platform: "linux",
      architecture: "x64",
      env: { OPENSHELL_PODMAN_SOCKET: "/runtime/podman.sock" },
      uid: 1000,
      lstatSync: (() => ({ isSocket: () => true })) as never,
      run: successfulRun,
    });

    expect(receipt).toEqual({
      driverName: "podman",
      version: "5.6.2",
      socketPath: "/runtime/podman.sock",
      rootless: true,
      cgroupVersion: "v2",
      os: "linux",
      architecture: "amd64",
      networkBackend: "netavark",
    });
  });

  it("rejects nonroot, cgroup-v1, non-amd64, and missing subordinate mappings", () => {
    const cases = [
      {
        info: {
          ...JSON.parse(INFO),
          host: { ...JSON.parse(INFO).host, security: { rootless: false } },
        },
        message: "requires a rootless Podman",
      },
      {
        info: { ...JSON.parse(INFO), host: { ...JSON.parse(INFO).host, cgroupVersion: "v1" } },
        message: "requires cgroups v2",
      },
      {
        info: { ...JSON.parse(INFO), host: { ...JSON.parse(INFO).host, arch: "arm64" } },
        message: "requires amd64",
      },
    ];
    for (const testCase of cases) {
      expect(() =>
        assessNativePodman({
          platform: "linux",
          architecture: "x64",
          env: { OPENSHELL_PODMAN_SOCKET: "/runtime/podman.sock" },
          lstatSync: (() => ({ isSocket: () => true })) as never,
          run: (command, args) =>
            args[0] === "--version"
              ? successfulRun(command, args)
              : args[0] === "unshare"
                ? successfulRun(command, args)
                : { status: 0, stdout: JSON.stringify(testCase.info), stderr: "" },
        }),
      ).toThrow(testCase.message);
    }

    expect(() =>
      assessNativePodman({
        platform: "linux",
        architecture: "x64",
        env: { OPENSHELL_PODMAN_SOCKET: "/runtime/podman.sock" },
        lstatSync: (() => ({ isSocket: () => true })) as never,
        run: (command, args) =>
          args[0] === "unshare"
            ? { status: 0, stdout: "0 1000 1\n", stderr: "" }
            : successfulRun(command, args),
      }),
    ).toThrow("requires a subordinate UID range");
  });

  it("fails before probing for unsupported host platforms", () => {
    expect(() =>
      assessNativePodman({
        platform: "darwin",
        architecture: "arm64",
        run: () => {
          throw new Error("must not run");
        },
      }),
    ).toThrow("requires Linux x86_64");
  });
});
