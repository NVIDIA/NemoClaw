// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { destroyGatewayWithVolumeCleanup, type DestroyGatewayDeps } from "./gateway-destroy";

function deps(overrides: Partial<DestroyGatewayDeps> = {}): DestroyGatewayDeps {
  return {
    clearRegistry: vi.fn(),
    dockerRemoveVolumesByPrefix: vi.fn(),
    gatewayName: "nemoclaw",
    hasLifecycleCommands: vi.fn(() => true),
    isDockerDriverGatewayEnabled: vi.fn(() => false),
    removeDockerDriverGatewayRegistration: vi.fn(() => true),
    runOpenshell: vi.fn(() => ({ status: 0 })),
    stopDockerDriverGatewayProcess: vi.fn(),
    ...overrides,
  };
}

describe("destroyGatewayWithVolumeCleanup", () => {
  it("destroys lifecycle gateways and removes their OpenShell cluster volumes", () => {
    const d = deps();

    expect(destroyGatewayWithVolumeCleanup(d)).toBe(true);

    expect(d.runOpenshell).toHaveBeenCalledWith(["gateway", "destroy", "-g", "nemoclaw"], {
      ignoreError: true,
    });
    expect(d.clearRegistry).toHaveBeenCalledOnce();
    expect(d.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith("openshell-cluster-nemoclaw", {
      ignoreError: true,
    });
  });

  it("stops Docker-driver gateways, unregisters them, and removes cluster volumes", () => {
    const d = deps({
      hasLifecycleCommands: vi.fn(() => false),
      isDockerDriverGatewayEnabled: vi.fn(() => true),
    });

    expect(destroyGatewayWithVolumeCleanup(d)).toBe(true);

    expect(d.stopDockerDriverGatewayProcess).toHaveBeenCalledOnce();
    expect(d.removeDockerDriverGatewayRegistration).toHaveBeenCalledOnce();
    expect(d.runOpenshell).not.toHaveBeenCalled();
    expect(d.clearRegistry).toHaveBeenCalledOnce();
    expect(d.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith("openshell-cluster-nemoclaw", {
      ignoreError: true,
    });
  });

  it("does not clear registry or remove volumes when gateway removal fails", () => {
    const d = deps({ runOpenshell: vi.fn(() => ({ status: 1 })) });

    expect(destroyGatewayWithVolumeCleanup(d)).toBe(false);

    expect(d.clearRegistry).not.toHaveBeenCalled();
    expect(d.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });

  it("preserves legacy gateway behavior without Docker volume cleanup", () => {
    const d = deps({ hasLifecycleCommands: vi.fn(() => false) });

    expect(destroyGatewayWithVolumeCleanup(d)).toBe(true);

    expect(d.runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
    });
    expect(d.clearRegistry).toHaveBeenCalledOnce();
    expect(d.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });
});
