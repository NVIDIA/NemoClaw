// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { activatePersistedSandboxHostContainerRuntime } from "../../actions/sandbox/gateway-target";
import {
  configureHostContainerEngine,
  hostContainerEngineArgv,
  resetHostContainerEngineForTests,
} from "../../adapters/container-engine";
import type { ManagedGatewayRuntimeBinding } from "../docker-driver-gateway-config";
import type { HostLocalInferenceRuntimeAdapterRegistry } from "./host-local-inference-runtime";
import { activatePersistedHostContainerRuntime } from "./persisted-host-container-runtime";
import {
  capturePodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "./podman/socket-authority";
import type { NativePodmanPreflightReceipt } from "./podman-preflight";
import type { ManagedGatewayRecoveryAdapterRegistry } from "./recovery-runtime";

const SOCKET_PATH = "/run/user/1000/podman/podman.sock";
const STATE_DIR = "/state/nemoclaw/openshell-docker-gateway";

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
  authorityDeps: PodmanSocketAuthorityDeps,
): NativePodmanPreflightReceipt {
  return {
    driverName: "podman",
    version: "5.6.2",
    socketPath: SOCKET_PATH,
    socketAuthority: capturePodmanSocketAuthority(SOCKET_PATH, authorityDeps),
    rootless: true,
    cgroupVersion: "v2",
    os: "linux",
    architecture: "arm64",
    networkBackend: "netavark",
    cdiDevices: ["nvidia.com/gpu=all"],
  };
}

function runtimeBinding(driverName: string): ManagedGatewayRuntimeBinding {
  return {
    version: 1,
    driverName,
    configSha256: "a".repeat(64),
    values: {},
  };
}

describe("persisted host-container runtime activation", () => {
  afterEach(() => {
    resetHostContainerEngineForTests();
  });

  it("rehydrates exact Podman socket authority in a fresh process without ambient socket state", () => {
    resetHostContainerEngineForTests();
    expect(hostContainerEngineArgv(["ps"])).toEqual(["docker", "ps"]);

    const authorityDeps = socketAuthorityDeps();
    const qualification = qualifiedPodmanRuntime(authorityDeps);
    const qualifyEnvironment = vi.fn(() => qualification);
    const readRuntimeBinding = vi.fn(() => runtimeBinding("podman"));
    const recoveryRuntimeAdapters: ManagedGatewayRecoveryAdapterRegistry = {
      podman: {
        driverName: "podman",
        qualifyEnvironment,
        resolveEnvironment: () => ({
          OPENSHELL_PODMAN_SOCKET: SOCKET_PATH,
          OPENSHELL_PODMAN_NETWORK_NAME: "persisted-net",
          OPENSHELL_SUPERVISOR_IMAGE: "registry.example/supervisor@sha256:abc",
        }),
      },
    };
    const environment: NodeJS.ProcessEnv = {
      HOME: "/home/test",
      NEMOCLAW_PODMAN_BIN: "/opt/podman",
    };

    const restore = activatePersistedHostContainerRuntime(
      { driverName: "podman", stateDir: STATE_DIR },
      {
        environment,
        hostRuntimeInput: { socketAuthorityDeps: authorityDeps },
        readRuntimeBinding,
        recoveryRuntimeAdapters,
      },
    );
    try {
      expect(readRuntimeBinding).toHaveBeenCalledExactlyOnceWith(STATE_DIR);
      expect(qualifyEnvironment).toHaveBeenCalledExactlyOnceWith({
        OPENSHELL_PODMAN_SOCKET: SOCKET_PATH,
        OPENSHELL_PODMAN_NETWORK_NAME: "persisted-net",
        OPENSHELL_SUPERVISOR_IMAGE: "registry.example/supervisor@sha256:abc",
      });
      expect(hostContainerEngineArgv(["inspect", "--type", "container", "nim-alpha"])).toEqual([
        "/opt/podman",
        "--url",
        `unix://${SOCKET_PATH}`,
        "inspect",
        "--type",
        "container",
        "nim-alpha",
      ]);
      expect(
        hostContainerEngineArgv(["run", "--gpus", "all", "registry.example/nim:latest"]),
      ).toEqual([
        "/opt/podman",
        "--url",
        `unix://${SOCKET_PATH}`,
        "run",
        "--device",
        "nvidia.com/gpu=all",
        "registry.example/nim:latest",
      ]);
      for (const operation of [
        ["ps", "--filter", "name=nim-alpha"],
        ["stop", "nim-alpha"],
        ["rm", "-f", "nemoclaw-vllm"],
      ]) {
        expect(hostContainerEngineArgv(operation)).toEqual([
          "/opt/podman",
          "--url",
          `unix://${SOCKET_PATH}`,
          ...operation,
        ]);
      }
      expect(environment.OPENSHELL_PODMAN_SOCKET).toBeUndefined();
    } finally {
      restore();
    }
    expect(hostContainerEngineArgv(["ps"])).toEqual(["docker", "ps"]);
  });

  it.each([
    "docker",
    "kubernetes",
    "vm",
    null,
  ])("keeps the exact Docker engine for persisted driver %s", (driverName) => {
    const readRuntimeBinding = vi.fn();
    const restore = activatePersistedHostContainerRuntime(
      { driverName },
      { environment: {}, readRuntimeBinding },
    );
    try {
      expect(hostContainerEngineArgv(["container", "ls"])).toEqual(["docker", "container", "ls"]);
      expect(readRuntimeBinding).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("requires both persisted recovery and host adapters for a future runtime", () => {
    const qualification = { endpoint: "unix:///run/mxc/runtime.sock", generation: 7 };
    const activate = vi.fn((input) =>
      configureHostContainerEngine({
        driverName: "mxc",
        executable: "mxcctl",
        prefixArgs: ["--endpoint", input.environment?.OPENSHELL_MXC_ENDPOINT ?? ""],
      }),
    );
    const hostRuntimeAdapters: HostLocalInferenceRuntimeAdapterRegistry = {
      mxc: { driverName: "mxc", activate },
    };
    const recoveryRuntimeAdapters: ManagedGatewayRecoveryAdapterRegistry = {
      mxc: {
        driverName: "mxc",
        qualifyEnvironment: () => qualification,
        resolveEnvironment: () => ({
          OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc/runtime.sock",
        }),
      },
    };
    const restore = activatePersistedHostContainerRuntime(
      { driverName: "mxc", stateDir: "/state/mxc" },
      {
        environment: {},
        hostRuntimeAdapters,
        readRuntimeBinding: () => runtimeBinding("mxc"),
        recoveryRuntimeAdapters,
      },
    );
    try {
      expect(hostContainerEngineArgv(["workload", "list"])).toEqual([
        "mxcctl",
        "--endpoint",
        "unix:///run/mxc/runtime.sock",
        "workload",
        "list",
      ]);
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.objectContaining({
            OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc/runtime.sock",
          }),
          qualifiedRuntime: qualification,
        }),
      );
    } finally {
      restore();
    }
  });

  it("fails closed for an unregistered native runtime instead of inheriting Docker", () => {
    expect(() =>
      activatePersistedHostContainerRuntime(
        { driverName: "mxc", stateDir: "/state/mxc" },
        {
          environment: {},
          readRuntimeBinding: () => runtimeBinding("mxc"),
        },
      ),
    ).toThrow("Managed recovery runtime adapter 'mxc' is not registered");
    expect(hostContainerEngineArgv(["ps"])).toEqual(["docker", "ps"]);
  });

  it("derives a sandbox runtime binding from its persisted gateway and driver", () => {
    const readRuntimeBinding = vi.fn(() => runtimeBinding("podman"));
    const authorityDeps = socketAuthorityDeps();
    const recoveryRuntimeAdapters: ManagedGatewayRecoveryAdapterRegistry = {
      podman: {
        driverName: "podman",
        qualifyEnvironment: () => qualifiedPodmanRuntime(authorityDeps),
        resolveEnvironment: () => ({
          OPENSHELL_PODMAN_SOCKET: SOCKET_PATH,
          OPENSHELL_PODMAN_NETWORK_NAME: "openshell",
          OPENSHELL_SUPERVISOR_IMAGE: "supervisor",
        }),
      },
    };

    const restore = activatePersistedSandboxHostContainerRuntime(
      {
        name: "alpha",
        gatewayName: "nemoclaw-8090",
        gatewayPort: 8090,
        openshellDriver: "podman",
      },
      {
        environment: { HOME: "/home/test" },
        hostRuntimeInput: { socketAuthorityDeps: authorityDeps },
        readRuntimeBinding,
        recoveryRuntimeAdapters,
      },
    );
    try {
      expect(readRuntimeBinding).toHaveBeenCalledExactlyOnceWith(
        "/home/test/.local/state/nemoclaw/openshell-docker-gateway-8090",
      );
      expect(hostContainerEngineArgv(["ps"])).toEqual([
        "podman",
        "--url",
        `unix://${SOCKET_PATH}`,
        "ps",
      ]);
    } finally {
      restore();
    }
  });
});
