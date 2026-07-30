// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type HostContainerEngineCommand,
  hostContainerEngineArgv,
  resetHostContainerEngineForTests,
} from "../../adapters/container-engine";
import {
  activateHostLocalInferenceRuntime,
  type HostLocalInferenceRuntimeAdapterRegistry,
  translateLocalInferenceArgsForPodman,
} from "./host-local-inference-runtime";
import {
  capturePodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "./podman/socket-authority";
import type { NativePodmanPreflightReceipt } from "./podman-preflight";

const SOCKET_PATH = "/run/user/1000/podman/podman.sock";

function socketAuthorityDeps(): PodmanSocketAuthorityDeps {
  const paths = [SOCKET_PATH, "/run/user/1000/podman", "/run/user/1000", "/run/user", "/run", "/"];
  const stats = new Map(
    paths.map((filePath, index) => [
      filePath,
      {
        dev: 8n,
        ino: BigInt(100 + index),
        mode: filePath === SOCKET_PATH ? 0o140600n : 0o40700n,
        uid: filePath === "/run/user" || filePath === "/run" || filePath === "/" ? 0n : 1000n,
        isDirectory: () => filePath !== SOCKET_PATH,
        isSocket: () => filePath === SOCKET_PATH,
      },
    ]),
  );
  return {
    uid: 1000,
    lstat: (filePath: string) => {
      const stat = stats.get(filePath);
      if (!stat) throw new Error(`unexpected lstat ${filePath}`);
      return stat;
    },
  };
}

function qualifiedPodmanRuntime(
  deps: PodmanSocketAuthorityDeps,
  architecture: "amd64" | "arm64" = "amd64",
): NativePodmanPreflightReceipt {
  return {
    driverName: "podman",
    version: "5.6.2",
    socketPath: SOCKET_PATH,
    socketAuthority: capturePodmanSocketAuthority(SOCKET_PATH, deps),
    rootless: true,
    cgroupVersion: "v2",
    os: "linux",
    architecture,
    networkBackend: "netavark",
    cdiDevices: [
      "nvidia.com/gpu=all",
      "nvidia.com/gpu=0",
      "nvidia.com/gpu=1:0",
      "nvidia.com/gpu=2",
      "nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "nvidia.com/gpu=MIG-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "nvidia.com/gpu=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0",
    ],
  };
}

describe("host-local inference compute runtime", () => {
  afterEach(() => {
    resetHostContainerEngineForTests();
  });

  it("activates Podman through the exact qualified rootless socket", () => {
    const authorityDeps = socketAuthorityDeps();
    let command: HostContainerEngineCommand | null = null;
    const restore = vi.fn();
    const configure = vi.fn((next: HostContainerEngineCommand) => {
      command = next;
      return restore;
    });

    const result = activateHostLocalInferenceRuntime(
      { driverName: "podman" },
      {
        environment: {
          OPENSHELL_PODMAN_SOCKET: SOCKET_PATH,
          NEMOCLAW_PODMAN_BIN: "/usr/bin/podman",
        },
        qualifiedPodmanRuntime: qualifiedPodmanRuntime(authorityDeps),
        socketAuthorityDeps: authorityDeps,
        configureContainerEngine: configure,
      },
    );

    expect(result).toBe(restore);
    expect(configure).toHaveBeenCalledOnce();
    expect(command).toMatchObject({
      driverName: "podman",
      executable: "/usr/bin/podman",
      prefixArgs: ["--url", `unix://${SOCKET_PATH}`],
      runtimeArchitecture: "amd64",
      sandboxNetworkName: "openshell",
      hostGatewayTarget: "host-gateway",
    });
    expect(() => command?.assertAuthority?.()).not.toThrow();
  });

  it.each([
    ["all", ["nvidia.com/gpu=all"]],
    ["device=0", ["nvidia.com/gpu=0"]],
    ["device=1:0", ["nvidia.com/gpu=1:0"]],
    [
      "device=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ["nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    ],
    [
      "device=MIG-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ["nvidia.com/gpu=MIG-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    ],
    [
      "device=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0",
      ["nvidia.com/gpu=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0"],
    ],
    ['"device=0,2"', ["nvidia.com/gpu=0", "nvidia.com/gpu=2"]],
  ])("preserves Docker GPU selector %s as exact Podman CDI devices", (selector, devices) => {
    const availableCdiDevices = qualifiedPodmanRuntime(socketAuthorityDeps()).cdiDevices;
    const translated = translateLocalInferenceArgsForPodman(["run", "--gpus", selector, "image"], {
      availableCdiDevices,
    });
    expect(translated.filter((value) => value.startsWith("nvidia.com/gpu="))).toEqual(devices);
    expect(translated.filter((value) => value === "--device")).toHaveLength(devices.length);
    expect(translated).not.toContain("--gpus");
  });

  it("translates managed NIM and vLLM Docker-compatible arguments without name leakage", () => {
    expect(
      translateLocalInferenceArgsForPodman([
        "run",
        "--gpus",
        "all",
        "--filter",
        "name=^/nemoclaw-vllm$",
      ]),
    ).toEqual(["run", "--device", "nvidia.com/gpu=all", "--filter", "name=^nemoclaw-vllm$"]);
    expect(translateLocalInferenceArgsForPodman(["run", "--gpus=device=0", "image"])).toEqual([
      "run",
      "--device",
      "nvidia.com/gpu=0",
      "image",
    ]);
  });

  it("routes full managed NIM and vLLM argv through Podman with GPU attachment intact", () => {
    const authorityDeps = socketAuthorityDeps();
    const restore = activateHostLocalInferenceRuntime(
      { driverName: "podman" },
      {
        environment: { OPENSHELL_PODMAN_SOCKET: SOCKET_PATH },
        qualifiedPodmanRuntime: qualifiedPodmanRuntime(authorityDeps),
        socketAuthorityDeps: authorityDeps,
      },
    );
    try {
      const prefix = ["podman", "--url", `unix://${SOCKET_PATH}`];
      expect(
        hostContainerEngineArgv([
          "run",
          "-d",
          "--gpus",
          "all",
          "-p",
          "8000:8000",
          "--name",
          "nemoclaw-nim-alpha",
          "--shm-size",
          "16g",
          "-e",
          "NGC_API_KEY",
          "nvcr.io/nim/nvidia/model:latest",
        ]),
      ).toEqual([
        ...prefix,
        "run",
        "-d",
        "--device",
        "nvidia.com/gpu=all",
        "-p",
        "8000:8000",
        "--name",
        "nemoclaw-nim-alpha",
        "--shm-size",
        "16g",
        "-e",
        "NGC_API_KEY",
        "nvcr.io/nim/nvidia/model:latest",
      ]);
      expect(
        hostContainerEngineArgv([
          "run",
          "-d",
          "--pull=never",
          "--gpus",
          '"device=0,2"',
          "--ipc=host",
          "-v",
          "/home/test/.cache/huggingface:/root/.cache/huggingface",
          "--label",
          "com.nvidia.nemoclaw.managed-vllm=true",
          "--name",
          "nemoclaw-vllm",
          "nvcr.io/nvidia/vllm@sha256:deadbeef",
        ]),
      ).toEqual([
        ...prefix,
        "run",
        "-d",
        "--pull=never",
        "--device",
        "nvidia.com/gpu=0",
        "--device",
        "nvidia.com/gpu=2",
        "--ipc=host",
        "-v",
        "/home/test/.cache/huggingface:/root/.cache/huggingface",
        "--label",
        "com.nvidia.nemoclaw.managed-vllm=true",
        "--name",
        "nemoclaw-vllm",
        "nvcr.io/nvidia/vllm@sha256:deadbeef",
      ]);
    } finally {
      restore();
    }
  });

  it("fails closed instead of dropping or leaking unsupported Docker GPU modes", () => {
    expect(() =>
      translateLocalInferenceArgsForPodman(["run", "--gpus", "capabilities=compute", "image"]),
    ).toThrow("cannot translate Docker GPU selector");
    expect(() =>
      translateLocalInferenceArgsForPodman(["run", "--gpus", "device=0,0", "image"]),
    ).toThrow("duplicate device");
    expect(() =>
      translateLocalInferenceArgsForPodman(["run", "--runtime", "nvidia", "image"]),
    ).toThrow("refuses Docker's NVIDIA runtime mode");
    expect(() =>
      translateLocalInferenceArgsForPodman(["run", "--device", "/dev/nvidia0", "image"]),
    ).toThrow("refuses raw NVIDIA device paths");
    expect(() =>
      translateLocalInferenceArgsForPodman(["run", "--gpus", "device=9", "image"], {
        availableCdiDevices: ["nvidia.com/gpu=all", "nvidia.com/gpu=0"],
      }),
    ).toThrow("does not advertise");
  });

  it("keeps Linux arm64 on the same exact Podman runtime authority", () => {
    const authorityDeps = socketAuthorityDeps();
    let command: HostContainerEngineCommand | null = null;

    activateHostLocalInferenceRuntime(
      { driverName: "podman" },
      {
        environment: {
          OPENSHELL_PODMAN_NETWORK_NAME: "openshell-arm64",
          OPENSHELL_PODMAN_SOCKET: SOCKET_PATH,
        },
        qualifiedPodmanRuntime: qualifiedPodmanRuntime(authorityDeps, "arm64"),
        socketAuthorityDeps: authorityDeps,
        configureContainerEngine: (next) => {
          command = next;
          return () => undefined;
        },
      },
    );

    expect(command).toMatchObject({
      driverName: "podman",
      runtimeArchitecture: "arm64",
      sandboxNetworkName: "openshell-arm64",
    });
    expect(() => command?.assertAuthority?.()).not.toThrow();
  });

  it("rejects socket/runtime mismatch and later socket replacement", () => {
    const authorityDeps = socketAuthorityDeps();
    const qualified = qualifiedPodmanRuntime(authorityDeps);
    expect(() =>
      activateHostLocalInferenceRuntime(
        { driverName: "podman" },
        {
          environment: { OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/other.sock" },
          qualifiedPodmanRuntime: qualified,
          socketAuthorityDeps: authorityDeps,
        },
      ),
    ).toThrow("does not match the qualified Podman socket");

    let socketInode = 100n;
    const changingDeps = socketAuthorityDeps();
    const originalLstat = changingDeps.lstat!;
    const mutableDeps: PodmanSocketAuthorityDeps = {
      ...changingDeps,
      lstat: (filePath) => {
        const stat = originalLstat(filePath);
        return filePath === SOCKET_PATH ? { ...stat, ino: socketInode } : stat;
      },
    };
    let command: HostContainerEngineCommand | null = null;
    activateHostLocalInferenceRuntime(
      { driverName: "podman" },
      {
        environment: { OPENSHELL_PODMAN_SOCKET: SOCKET_PATH },
        qualifiedPodmanRuntime: qualifiedPodmanRuntime(mutableDeps),
        socketAuthorityDeps: mutableDeps,
        configureContainerEngine: (next) => {
          command = next;
          return () => undefined;
        },
      },
    );
    socketInode = 101n;
    expect(() => command?.assertAuthority?.()).toThrow("changed after it was qualified");
  });

  it("routes an injected MXC adapter without inheriting Podman", () => {
    const activate = vi.fn(() => vi.fn());
    const adapters: HostLocalInferenceRuntimeAdapterRegistry = {
      mxc: { driverName: "mxc", activate },
    };

    activateHostLocalInferenceRuntime({ driverName: "mxc" }, {}, adapters);

    expect(activate).toHaveBeenCalledOnce();
  });

  it("fails closed when a driver has no local-inference runtime adapter", () => {
    expect(() => activateHostLocalInferenceRuntime({ driverName: "mxc" }, {}, {})).toThrow(
      "has no registered host-local inference runtime adapter",
    );
  });
});
