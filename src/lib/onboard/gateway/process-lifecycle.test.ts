// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createGatewayProcessLifecycle,
  type GatewayProcessLifecycleDeps,
} from "./process-lifecycle";

function dependencies(
  overrides: Partial<GatewayProcessLifecycleDeps> = {},
): GatewayProcessLifecycleDeps {
  return {
    gatewayName: () => "nemoclaw",
    runOpenshell: () => ({ status: 0 }),
    runCaptureOpenshell: () => "",
    dockerInspect: () => ({ status: 1 }),
    dockerStop: vi.fn(),
    dockerRm: vi.fn(),
    dockerRemoveVolumesByPrefix: vi.fn(),
    getGatewayClusterContainerName: (name) => `openshell-cluster-${name}`,
    getDockerDriverGatewayPid: () => null,
    isPidAlive: () => false,
    isDockerDriverGatewayProcess: () => false,
    resolveOpenShellGatewayBinary: () => "/usr/bin/openshell-gateway",
    clearDockerDriverGatewayRuntimeFiles: vi.fn(),
    sleepSeconds: vi.fn(),
    isDockerDriverGatewayEnabled: () => true,
    clearRegistry: vi.fn(),
    killProcess: vi.fn(),
    log: vi.fn(),
    gatewayCliSupportsLifecycleCommands: () => false,
    destroyGatewayWithVolumeCleanup: () => true,
    ...overrides,
  };
}

describe("gateway process lifecycle", () => {
  it("does not signal a process that does not match the gateway binary", () => {
    const clearRuntimeFiles = vi.fn();
    const killProcess = vi.fn();
    const lifecycle = createGatewayProcessLifecycle(
      dependencies({
        getDockerDriverGatewayPid: () => 42,
        isPidAlive: () => true,
        isDockerDriverGatewayProcess: () => false,
        clearDockerDriverGatewayRuntimeFiles: clearRuntimeFiles,
        killProcess,
      }),
    );

    expect(lifecycle.stopDockerDriverGatewayProcess()).toBe(false);
    expect(killProcess).not.toHaveBeenCalled();
    expect(clearRuntimeFiles).toHaveBeenCalledOnce();
  });

  it("uses gateway destroy when gateway remove is unsupported", () => {
    const runOpenshell = vi
      .fn<GatewayProcessLifecycleDeps["runOpenshell"]>()
      .mockReturnValueOnce({
        status: 1,
        stderr: Buffer.from("unrecognized subcommand 'remove'"),
      })
      .mockReturnValueOnce({ status: 0 });
    const lifecycle = createGatewayProcessLifecycle(dependencies({ runOpenshell }));

    expect(lifecycle.removeDockerDriverGatewayRegistration()).toBe(true);
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["gateway", "destroy", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
  });

  it("does not hide a current gateway remove failure behind the legacy verb", () => {
    const runOpenshell = vi.fn<GatewayProcessLifecycleDeps["runOpenshell"]>(() => ({
      status: 1,
      stderr: Buffer.from("connection refused"),
    }));
    const lifecycle = createGatewayProcessLifecycle(dependencies({ runOpenshell }));

    expect(lifecycle.removeDockerDriverGatewayRegistration()).toBe(false);
    expect(runOpenshell).toHaveBeenCalledTimes(1);
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["gateway", "destroy", "-g", "nemoclaw"],
      expect.anything(),
    );
  });
});
