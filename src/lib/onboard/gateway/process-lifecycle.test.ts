// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { gatewayAdaptersForTest } from "../../../../test/helpers/openshell-gateway-adapters";
import * as gatewayAuthority from "../gateway-teardown-authority";
import { resolveGatewayOwner } from "../gateway-ownership";
import { describe, expect, it, vi } from "vitest";
import {
  createGatewayProcessLifecycle,
  type GatewayProcessLifecycleDeps,
} from "./process-lifecycle";

function dependencies(
  overrides: Partial<GatewayProcessLifecycleDeps> = {},
): GatewayProcessLifecycleDeps {
  return {
    lifecycle: gatewayAdaptersForTest().lifecycle,
    resolveAuthority: () =>
      resolveGatewayOwner({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        declaration: null,
        hasPackagedService: false,
      }),
    gatewayName: () => "nemoclaw",
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
    destroyGatewayWithVolumeCleanup: async () => true,
    ...overrides,
  };
}

describe("gateway process lifecycle", () => {
  it("resolves default teardown authority for the current named port", async () => {
    const target = { gatewayName: "nemoclaw-8091", gatewayPort: 8091 };
    const authority = vi
      .spyOn(gatewayAuthority, "resolveGatewayTeardownAuthority")
      .mockReturnValue(
        resolveGatewayOwner({ ...target, declaration: null, hasPackagedService: false }),
      );
    try {
      const deps = dependencies({
        resolveAuthority: undefined,
        gatewayName: () => target.gatewayName,
        gatewayPort: () => target.gatewayPort,
      });
      await expect(
        createGatewayProcessLifecycle(deps).removeDockerDriverGatewayRegistration(),
      ).resolves.toBe(true);
      expect(authority).toHaveBeenCalledWith(target);
      expect(deps.lifecycle.removeGateway).toHaveBeenCalledWith({
        target: { kind: "named", gatewayName: target.gatewayName },
      });
    } finally {
      authority.mockRestore();
    }
  });

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

  it("delegates unsupported removal to authorized legacy cleanup", async () => {
    const adapters = gatewayAdaptersForTest();
    adapters.lifecycle.removeGateway.mockResolvedValue({
      ok: false,
      unsupported: true,
      ambiguous: false,
      error: { kind: "command", reason: "failed", message: "Unsupported removal." },
    });
    const lifecycle = createGatewayProcessLifecycle(
      dependencies({ lifecycle: adapters.lifecycle }),
    );
    await expect(lifecycle.removeDockerDriverGatewayRegistration()).resolves.toBe(true);
    expect(adapters.lifecycle.destroyGateway).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
    });
  });

  it("retains failed removal without a destructive fallback", async () => {
    const adapters = gatewayAdaptersForTest();
    adapters.lifecycle.removeGateway.mockResolvedValue({
      ok: false,
      unsupported: false,
      ambiguous: true,
      error: { kind: "timeout", message: "Timed out." },
    });
    const lifecycle = createGatewayProcessLifecycle(
      dependencies({ lifecycle: adapters.lifecycle }),
    );
    await expect(lifecycle.removeDockerDriverGatewayRegistration()).resolves.toBe(false);
    expect(adapters.lifecycle.removeGateway).toHaveBeenCalledOnce();
    expect(adapters.lifecycle.destroyGateway).not.toHaveBeenCalled();
    expect(adapters.lifecycle.listGateways).toHaveBeenCalledOnce();
  });
});
