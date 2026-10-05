// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { gatewayAdaptersForTest } from "../../../test/helpers/openshell-gateway-adapters";
import { resolveGatewayOwner } from "./gateway-ownership";
import { describe, expect, it, vi } from "vitest";

import { destroyGatewayWithVolumeCleanup, type DestroyGatewayDeps } from "./gateway-destroy";

function deps(overrides: Partial<DestroyGatewayDeps> = {}): DestroyGatewayDeps {
  return {
    lifecycle: gatewayAdaptersForTest().lifecycle,
    resolveAuthority: () =>
      resolveGatewayOwner({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        declaration: null,
        hasPackagedService: false,
      }),
    clearRegistry: vi.fn(),
    dockerRemoveVolumesByPrefix: vi.fn(),
    gatewayName: "nemoclaw",
    hasLifecycleCommands: vi.fn(() => true),
    isDockerDriverGatewayEnabled: vi.fn(() => false),
    removeDockerDriverGatewayRegistration: vi.fn(() => true),
    stopDockerDriverGatewayProcess: vi.fn(),
    ...overrides,
  };
}

describe("destroyGatewayWithVolumeCleanup", () => {
  it("removes lifecycle gateways and deletes their OpenShell cluster volumes", async () => {
    const d = deps();

    expect(await destroyGatewayWithVolumeCleanup(d)).toBe(true);

    expect(d.lifecycle.removeGateway).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
    });
    expect(d.clearRegistry).toHaveBeenCalledOnce();
    expect(d.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith("openshell-cluster-nemoclaw", {
      ignoreError: true,
    });
  });

  it("falls back to gateway destroy when remove is unavailable", async () => {
    const { lifecycle } = gatewayAdaptersForTest();
    lifecycle.removeGateway.mockResolvedValue({
      ok: false,
      unsupported: true,
      ambiguous: false,
      error: { kind: "command", reason: "failed", message: "Unsupported." },
    });
    const d = deps({ lifecycle });
    expect(await destroyGatewayWithVolumeCleanup(d)).toBe(true);
    expect(lifecycle.removeGateway).toHaveBeenCalledOnce();
    expect(lifecycle.destroyGateway).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
    });
  });

  it("retains registry and volumes after ambiguous removal without legacy destruction", async () => {
    const { lifecycle } = gatewayAdaptersForTest();
    lifecycle.removeGateway.mockResolvedValue({
      ok: false,
      unsupported: false,
      ambiguous: true,
      error: { kind: "timeout", message: "Timed out." },
    });
    const d = deps({ lifecycle });
    expect(await destroyGatewayWithVolumeCleanup(d)).toBe(false);
    expect(lifecycle.removeGateway).toHaveBeenCalledOnce();
    expect(lifecycle.listGateways).toHaveBeenCalledOnce();
    expect(lifecycle.destroyGateway).not.toHaveBeenCalled();
    expect(d.clearRegistry).not.toHaveBeenCalled();
    expect(d.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });

  it("stops Docker-driver gateways, unregisters them, and removes cluster volumes", async () => {
    const d = deps({
      hasLifecycleCommands: vi.fn(() => false),
      isDockerDriverGatewayEnabled: vi.fn(() => true),
    });

    expect(await destroyGatewayWithVolumeCleanup(d)).toBe(true);

    expect(d.stopDockerDriverGatewayProcess).toHaveBeenCalledOnce();
    expect(d.removeDockerDriverGatewayRegistration).toHaveBeenCalledOnce();
    expect(d.lifecycle.removeGateway).not.toHaveBeenCalled();
    expect(d.clearRegistry).toHaveBeenCalledOnce();
    expect(d.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith("openshell-cluster-nemoclaw", {
      ignoreError: true,
    });
  });

  it("does not clear registry or remove volumes when gateway removal fails", async () => {
    const { lifecycle } = gatewayAdaptersForTest();
    lifecycle.removeGateway.mockResolvedValue({
      ok: false,
      unsupported: false,
      ambiguous: false,
      error: { kind: "command", reason: "failed", message: "Removal failed." },
    });
    const d = deps({ lifecycle });

    expect(await destroyGatewayWithVolumeCleanup(d)).toBe(false);

    expect(d.clearRegistry).not.toHaveBeenCalled();
    expect(d.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });

  it("preserves legacy gateway behavior without Docker volume cleanup", async () => {
    const d = deps({ hasLifecycleCommands: vi.fn(() => false) });

    expect(await destroyGatewayWithVolumeCleanup(d)).toBe(true);

    expect(d.lifecycle.removeGateway).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
    });
    expect(d.clearRegistry).toHaveBeenCalledOnce();
    expect(d.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });
});
