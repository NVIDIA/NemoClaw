// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
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
    cdi: {
      devices: ["nvidia.com/gpu=all", "nvidia.com/gpu=GPU-deadbeef"],
    },
  },
});
const SOCKET_AUTHORITY = {
  directoryChain: [
    { device: "8", inode: "7000", mode: "448", ownerUid: "1000", path: "/runtime" },
    { device: "8", inode: "1", mode: "493", ownerUid: "0", path: "/" },
  ],
  device: "8",
  inode: "9001",
  ownerUid: "1000",
  socketPath: "/runtime/podman.sock",
} as const;

function socketStat(filePath: string) {
  const socket = filePath === "/runtime/podman.sock";
  return {
    dev: 8,
    ino: socket ? 9001 : filePath === "/runtime" ? 7000 : 1,
    mode: socket ? 0o600 : filePath === "/runtime" ? 0o700 : 0o755,
    uid: socket || filePath === "/runtime" ? 1000 : 0,
    isDirectory: () => !socket,
    isSocket: () => socket,
  };
}

function successfulRun(command: string, args: readonly string[]) {
  switch (`${command}:${args[0] ?? ""}`) {
    case "lsof:-v":
      return { status: 0, stdout: "", stderr: "" };
    case "podman:--version":
      return { status: 0, stdout: "podman version 5.6.2\n", stderr: "" };
    case "podman:unshare":
      return { status: 0, stdout: "0 1000 1\n1 100000 65536\n", stderr: "" };
    case "podman:--url":
      return { status: 0, stdout: INFO, stderr: "" };
    case "nvidia-ctk:cdi":
      return {
        status: 0,
        stdout: [
          "nvidia.com/gpu=all",
          "nvidia.com/gpu=0",
          "nvidia.com/gpu=GPU-deadbeef",
          "nvidia.com/gpu=MIG-GPU-deadbeef/1/0",
          "",
        ].join("\n"),
        stderr: "",
      };
    default:
      return { status: 1, stdout: "", stderr: "unexpected command" };
  }
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
      lstatSync: socketStat as never,
      run: successfulRun,
    });

    expect(receipt).toEqual({
      driverName: "podman",
      version: "5.6.2",
      socketPath: "/runtime/podman.sock",
      socketAuthority: SOCKET_AUTHORITY,
      rootless: true,
      cgroupVersion: "v2",
      os: "linux",
      architecture: "amd64",
      networkBackend: "netavark",
      cdiDevices: [
        "nvidia.com/gpu=0",
        "nvidia.com/gpu=GPU-deadbeef",
        "nvidia.com/gpu=MIG-GPU-deadbeef/1/0",
        "nvidia.com/gpu=all",
      ],
    });
  });

  it("qualifies Linux arm64 and preserves the Podman CDI device identities", () => {
    const receipt = assessNativePodman({
      platform: "linux",
      architecture: "arm64",
      env: { OPENSHELL_PODMAN_SOCKET: "/runtime/podman.sock" },
      uid: 1000,
      lstatSync: socketStat as never,
      run: (command, args) =>
        args[0] === "--url"
          ? {
              status: 0,
              stdout: JSON.stringify({
                ...JSON.parse(INFO),
                host: { ...JSON.parse(INFO).host, arch: "aarch64" },
              }),
              stderr: "",
            }
          : successfulRun(command, args),
    });

    expect(receipt.architecture).toBe("arm64");
    expect(receipt.cdiDevices).toContain("nvidia.com/gpu=all");
    expect(receipt.cdiDevices).toContain("nvidia.com/gpu=MIG-GPU-deadbeef/1/0");
  });

  it("rejects a socket replacement during the Podman info probe", () => {
    const assertSocketAuthority = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("Podman socket authority changed after it was qualified.");
      });

    expect(() =>
      assessNativePodman({
        platform: "linux",
        architecture: "x64",
        env: { OPENSHELL_PODMAN_SOCKET: "/runtime/podman.sock" },
        uid: 1000,
        lstatSync: socketStat as never,
        assertSocketAuthority,
        run: successfulRun,
      }),
    ).toThrow("socket authority changed");
    expect(assertSocketAuthority).toHaveBeenCalledTimes(2);
  });

  it("rejects nonroot, cgroup-v1, unsupported architectures, and missing subordinate mappings", () => {
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
        info: { ...JSON.parse(INFO), host: { ...JSON.parse(INFO).host, arch: "ppc64le" } },
        message: "requires amd64 or arm64",
      },
    ];
    for (const testCase of cases) {
      expect(() =>
        assessNativePodman({
          platform: "linux",
          architecture: "x64",
          env: { OPENSHELL_PODMAN_SOCKET: "/runtime/podman.sock" },
          uid: 1000,
          lstatSync: socketStat as never,
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
        uid: 1000,
        lstatSync: socketStat as never,
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
    ).toThrow("requires Linux amd64 or arm64");
  });

  it("fails with remediation when complete listener inspection is unavailable", () => {
    expect(() =>
      assessNativePodman({
        platform: "linux",
        architecture: "x64",
        run: () => ({ status: 1, stdout: "", stderr: "missing" }),
      }),
    ).toThrow("requires lsof");
  });
});
