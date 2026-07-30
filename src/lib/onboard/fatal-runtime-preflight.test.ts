// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import {
  assertSelectedContainerRuntimeReady,
  type FatalRuntimePreflightDriverAdapter,
  rejectUnsupportedContainerRuntime,
  resolveFatalRuntimePreflightDriverBehavior,
  runFatalOnboardRuntimePreflight,
} from "./fatal-runtime-preflight";
import type { HostAssessment } from "./preflight";

function hostWithRuntime(runtime: HostAssessment["runtime"]): HostAssessment {
  return {
    platform: process.platform,
    isWsl: false,
    runtime,
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: runtime === "podman",
    isHeadlessLikely: false,
    hasNvidiaGpu: false,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: false,
    notes: [],
  };
}

describe("rejectUnsupportedContainerRuntime (#7320)", () => {
  // The Docker-driver gateway path is forced on Linux and Apple Silicon macOS;
  // the reject gate only fires there. Gate the test on the same predicate via
  // it.skipIf (not an in-body `if`) so it runs on the Linux CI runner.
  it.skipIf(!isLinuxDockerDriverGatewayEnabled())(
    "exits when Podman is detected on a Docker-driver gateway platform",
    () => {
      const exit = vi.fn(() => {
        throw new Error("exit");
      });
      expect(() =>
        rejectUnsupportedContainerRuntime(hostWithRuntime("podman"), exit as never),
      ).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it("does not exit for a supported Docker runtime", () => {
    const exit = vi.fn();
    rejectUnsupportedContainerRuntime(hostWithRuntime("docker"), exit as never);
    expect(exit).not.toHaveBeenCalled();
  });

  it("preserves the registered Kubernetes readiness behavior", () => {
    const exit = vi.fn();
    const receipt = assertSelectedContainerRuntimeReady(
      hostWithRuntime("docker"),
      { driverName: "kubernetes", gatewayLauncher: "openshell" },
      { exitProcess: exit as never },
    );

    expect(receipt).toBeNull();
    expect(exit).not.toHaveBeenCalled();
  });

  it("qualifies a selected native Podman driver without Docker reachability", () => {
    const host = { ...hostWithRuntime("unknown"), dockerReachable: false };
    const env: NodeJS.ProcessEnv = {};
    const receipt = assertSelectedContainerRuntimeReady(
      host,
      { driverName: "podman", gatewayLauncher: "nemoclaw" },
      {
        env,
        nativePodmanDeps: {
          platform: "linux",
          architecture: "x64",
          env: { OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock" },
          uid: 1000,
          lstatSync: ((filePath: string) => {
            const socket = filePath.endsWith("/podman.sock");
            const currentUserPath = filePath.startsWith("/run/user/1000");
            return {
              dev: 8,
              ino: socket ? 9001 : filePath.length,
              mode: socket ? 0o600 : currentUserPath ? 0o700 : 0o755,
              uid: socket || currentUserPath ? 1000 : 0,
              isDirectory: () => !socket,
              isSocket: () => socket,
            };
          }) as never,
          run: (_command, args) => {
            if (args[0] === "--version") {
              return { status: 0, stdout: "podman version 5.6.2", stderr: "" };
            }
            if (args[0] === "unshare") {
              return { status: 0, stdout: "0 1000 1\n1 100000 65536\n", stderr: "" };
            }
            return {
              status: 0,
              stdout: JSON.stringify({
                host: {
                  arch: "amd64",
                  os: "linux",
                  cgroupVersion: "v2",
                  networkBackend: "netavark",
                  security: { rootless: true },
                },
              }),
              stderr: "",
            };
          },
        },
      },
    );

    expect(receipt?.driverName).toBe("podman");
    expect(env.OPENSHELL_PODMAN_SOCKET).toBe("/run/user/1000/podman/podman.sock");
  });

  it("dispatches an injected MXC fatal preflight without inherited runtime probes", () => {
    const host = {
      ...hostWithRuntime("unknown"),
      dockerInstalled: false,
      dockerRunning: false,
      dockerReachable: false,
    };
    const result = {
      gpu: null,
      host,
      sandboxGpuConfig: {
        mode: "0" as const,
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        sandboxGpuDevice: null,
        errors: [],
      },
      nativePodman: null,
    };
    const mxcAdapter = {
      driverName: "mxc",
      behavior: {
        checkContainerRuntimeResources: false,
        checkDockerBridgeDns: false,
        defaultSandboxGpuFlag: null,
        sandboxGpuUnsupportedMessage: null,
        skipDockerProbe: true,
      },
      assertReady: vi.fn(() => null),
      run: vi.fn(() => result),
    } satisfies FatalRuntimePreflightDriverAdapter;

    expect(
      assertSelectedContainerRuntimeReady(
        host,
        { driverName: "mxc", gatewayLauncher: "nemoclaw" },
        { driverPreflightAdapters: { mxc: mxcAdapter } },
      ),
    ).toBeNull();

    expect(
      runFatalOnboardRuntimePreflight(
        {},
        {
          nonInteractive: true,
          computePlan: { driverName: "mxc", gatewayLauncher: "nemoclaw" },
          driverPreflightAdapters: { mxc: mxcAdapter },
          nativePodmanDeps: {
            lstatSync: () => {
              throw new Error("Podman probe must not run");
            },
            run: () => {
              throw new Error("Podman probe must not run");
            },
          },
        },
      ),
    ).toBe(result);
    expect(mxcAdapter.assertReady).toHaveBeenCalledOnce();
    expect(mxcAdapter.run).toHaveBeenCalledOnce();
    expect(
      resolveFatalRuntimePreflightDriverBehavior(
        { driverName: "mxc", gatewayLauncher: "nemoclaw" },
        { mxc: mxcAdapter },
      ),
    ).toBe(mxcAdapter.behavior);
  });

  it("rejects a registry entry whose adapter identity does not match its driver key", () => {
    const dockerAdapter = {
      driverName: "docker",
      behavior: {
        checkContainerRuntimeResources: true,
        checkDockerBridgeDns: true,
        defaultSandboxGpuFlag: null,
        sandboxGpuUnsupportedMessage: null,
        skipDockerProbe: false,
      },
      assertReady: vi.fn(() => null),
      run: vi.fn(),
    } satisfies FatalRuntimePreflightDriverAdapter;

    expect(() =>
      resolveFatalRuntimePreflightDriverBehavior(
        { driverName: "mxc", gatewayLauncher: "nemoclaw" },
        { mxc: dockerAdapter },
      ),
    ).toThrow("has no registered fatal runtime preflight adapter");
  });
});
