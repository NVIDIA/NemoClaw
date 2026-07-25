// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  cleanupOrphanedGatewayContainer,
  type OrphanGatewayCleanupDeps,
} from "./preflight-orphan-gateway-cleanup";

function makeDeps(overrides: Partial<OrphanGatewayCleanupDeps> = {}) {
  const deps: OrphanGatewayCleanupDeps = {
    gatewayReuseState: "missing",
    isDockerDriverGatewayEnabled: false,
    externallySupervised: false,
    gatewayName: "nemoclaw",
    // Container exists, and is gone after removal.
    dockerInspect: vi.fn(() => ({ status: 0 })),
    dockerStop: vi.fn(),
    dockerRm: vi.fn(),
    dockerRemoveVolumesByPrefix: vi.fn(),
    clearRegistry: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
  return deps;
}

describe("cleanupOrphanedGatewayContainer (#6576)", () => {
  it("performs no container, volume, or registry mutation under external supervision", () => {
    // "missing" only means NemoClaw holds no metadata; the supervisor's
    // container is still the live gateway.
    const deps = makeDeps({ externallySupervised: true });

    cleanupOrphanedGatewayContainer(deps);

    expect(deps.dockerInspect).not.toHaveBeenCalled();
    expect(deps.dockerStop).not.toHaveBeenCalled();
    expect(deps.dockerRm).not.toHaveBeenCalled();
    expect(deps.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
    expect(deps.clearRegistry).not.toHaveBeenCalled();
  });

  it("removes a genuinely orphaned container when NemoClaw owns the gateway", () => {
    let inspectCalls = 0;
    const deps = makeDeps({
      // Present first, absent after removal.
      dockerInspect: vi.fn(() => ({ status: inspectCalls++ === 0 ? 0 : 1 })),
    });

    cleanupOrphanedGatewayContainer(deps);

    expect(deps.dockerStop).toHaveBeenCalledWith("openshell-cluster-nemoclaw", expect.anything());
    expect(deps.dockerRm).toHaveBeenCalledWith("openshell-cluster-nemoclaw", expect.anything());
    expect(deps.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith(
      "openshell-cluster-nemoclaw",
      expect.anything(),
    );
    expect(deps.clearRegistry).toHaveBeenCalledOnce();
  });

  it("warns without clearing state when the container survives removal", () => {
    const deps = makeDeps({ dockerInspect: vi.fn(() => ({ status: 0 })) });

    cleanupOrphanedGatewayContainer(deps);

    expect(deps.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
    expect(deps.clearRegistry).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      "  ! Found an orphaned gateway container, but automatic cleanup failed.",
    );
  });

  it("does nothing when the gateway is reusable or on the Docker-driver path", () => {
    for (const overrides of [
      { gatewayReuseState: "healthy" },
      { isDockerDriverGatewayEnabled: true },
    ]) {
      const deps = makeDeps(overrides);

      cleanupOrphanedGatewayContainer(deps);

      expect(deps.dockerInspect).not.toHaveBeenCalled();
    }
  });

  it("does nothing when no orphaned container is present", () => {
    const deps = makeDeps({ dockerInspect: vi.fn(() => ({ status: 1 })) });

    cleanupOrphanedGatewayContainer(deps);

    expect(deps.dockerStop).not.toHaveBeenCalled();
    expect(deps.clearRegistry).not.toHaveBeenCalled();
  });
});
