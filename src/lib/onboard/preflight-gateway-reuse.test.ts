// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { GatewayContainerState } from "./gateway-container-running";
import type { GatewayReuseState } from "../state/gateway";
import {
  reconcilePreflightGatewayReuseState,
  type PreflightGatewayReuseDeps,
} from "./preflight-gateway-reuse";

function makeDeps(
  overrides: Partial<PreflightGatewayReuseDeps> = {},
): PreflightGatewayReuseDeps {
  return {
    gatewayReuseState: "healthy",
    supportsLifecycleCommands: true,
    gatewayName: "nemoclaw",
    verifyGatewayContainerRunning: vi.fn(() => "running" as GatewayContainerState),
    recoverGatewayRuntime: vi.fn(async () => true),
    waitForGatewayHttpReady: vi.fn(async () => true),
    getGatewayLocalEndpoint: () => "http://127.0.0.1:31818",
    stopDashboardForward: vi.fn(),
    stopAllDashboardForwards: vi.fn(),
    destroyGateway: vi.fn(() => true),
    destroyGatewayForReuse: vi.fn(() => "missing" as GatewayReuseState),
    getGatewayClusterImageDrift: vi.fn(() => null),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
    ...overrides,
  };
}

describe("reconcilePreflightGatewayReuseState", () => {
  it("short-circuits when reuse state is not healthy", async () => {
    const verify = vi.fn(() => "running" as GatewayContainerState);
    const deps = makeDeps({ gatewayReuseState: "missing", verifyGatewayContainerRunning: verify });

    const result = await reconcilePreflightGatewayReuseState(deps);

    expect(result).toBe("missing");
    expect(verify).not.toHaveBeenCalled();
  });

  it("short-circuits when lifecycle commands are not supported", async () => {
    const verify = vi.fn(() => "running" as GatewayContainerState);
    const deps = makeDeps({ supportsLifecycleCommands: false, verifyGatewayContainerRunning: verify });

    const result = await reconcilePreflightGatewayReuseState(deps);

    expect(result).toBe("healthy");
    expect(verify).not.toHaveBeenCalled();
  });

  it("recovers a stopped container without removing volumes (#4187)", async () => {
    const recover = vi.fn(async () => true);
    const destroyForReuse = vi.fn(() => "missing" as GatewayReuseState);
    const deps = makeDeps({
      verifyGatewayContainerRunning: vi.fn(() => "stopped" as GatewayContainerState),
      recoverGatewayRuntime: recover,
      destroyGatewayForReuse: destroyForReuse,
    });

    const result = await reconcilePreflightGatewayReuseState(deps);

    expect(result).toBe("healthy");
    expect(recover).toHaveBeenCalledOnce();
    expect(destroyForReuse).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("exits without destroying volumes when stopped-container recovery fails (#4187)", async () => {
    const destroyForReuse = vi.fn(() => "missing" as GatewayReuseState);
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const deps = makeDeps({
      verifyGatewayContainerRunning: vi.fn(() => "stopped" as GatewayContainerState),
      recoverGatewayRuntime: vi.fn(async () => false),
      destroyGatewayForReuse: destroyForReuse,
      exitProcess: exit,
    });

    await expect(reconcilePreflightGatewayReuseState(deps)).rejects.toThrow("exit 1");

    expect(exit).toHaveBeenCalledWith(1);
    expect(destroyForReuse).not.toHaveBeenCalled();
  });

  it("cleans stale metadata when the container is missing", async () => {
    const destroyForReuse = vi.fn(() => "missing" as GatewayReuseState);
    const deps = makeDeps({
      verifyGatewayContainerRunning: vi.fn(() => "missing" as GatewayContainerState),
      destroyGatewayForReuse: destroyForReuse,
    });

    const result = await reconcilePreflightGatewayReuseState(deps);

    expect(result).toBe("missing");
    expect(deps.stopDashboardForward).toHaveBeenCalledOnce();
    expect(destroyForReuse).toHaveBeenCalledWith(
      deps.destroyGateway,
      "  ✓ Stale gateway metadata cleaned up",
      "  ! Stale gateway metadata cleanup failed; leaving registry state intact.",
    );
  });

  it("recreates a running gateway when HTTP is unhealthy", async () => {
    const destroyForReuse = vi.fn(() => "missing" as GatewayReuseState);
    const deps = makeDeps({
      verifyGatewayContainerRunning: vi.fn(() => "running" as GatewayContainerState),
      waitForGatewayHttpReady: vi.fn(async () => false),
      destroyGatewayForReuse: destroyForReuse,
    });

    const result = await reconcilePreflightGatewayReuseState(deps);

    expect(result).toBe("missing");
    expect(deps.stopDashboardForward).toHaveBeenCalledOnce();
    expect(destroyForReuse).toHaveBeenCalledWith(
      deps.destroyGateway,
      "  ✓ Stale gateway cleaned up",
      "  ! Stale gateway cleanup failed; leaving registry state intact.",
    );
  });

  it("recreates on image drift after stopping dashboard forwards", async () => {
    const destroyForReuse = vi.fn(() => "missing" as GatewayReuseState);
    const deps = makeDeps({
      verifyGatewayContainerRunning: vi.fn(() => "running" as GatewayContainerState),
      getGatewayClusterImageDrift: vi.fn(() => ({ currentVersion: "0.0.38", expectedVersion: "0.0.39" })),
      destroyGatewayForReuse: destroyForReuse,
    });

    const result = await reconcilePreflightGatewayReuseState(deps);

    expect(result).toBe("missing");
    expect(deps.stopAllDashboardForwards).toHaveBeenCalledOnce();
    expect(destroyForReuse).toHaveBeenCalledWith(
      deps.destroyGateway,
      "  ✓ Previous gateway cleaned up",
      "  ! Previous gateway cleanup failed; leaving registry state intact.",
    );
  });

  it("does not destroy on unknown container state when HTTP is responding", async () => {
    const destroyForReuse = vi.fn(() => "missing" as GatewayReuseState);
    const deps = makeDeps({
      verifyGatewayContainerRunning: vi.fn(() => "unknown" as GatewayContainerState),
      waitForGatewayHttpReady: vi.fn(async () => true),
      destroyGatewayForReuse: destroyForReuse,
    });

    const result = await reconcilePreflightGatewayReuseState(deps);

    expect(result).toBe("healthy");
    expect(destroyForReuse).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  // #2020 safety case: a transient docker inspect failure plus an HTTP warm-up
  // miss must NOT downgrade reuse state into destructive cleanup. Locks the
  // behavior described in the implementation comment so it can't regress.
  it("does not destroy on unknown container state when HTTP is not responding", async () => {
    const destroyForReuse = vi.fn(() => "missing" as GatewayReuseState);
    const deps = makeDeps({
      verifyGatewayContainerRunning: vi.fn(() => "unknown" as GatewayContainerState),
      waitForGatewayHttpReady: vi.fn(async () => false),
      destroyGatewayForReuse: destroyForReuse,
    });

    const result = await reconcilePreflightGatewayReuseState(deps);

    expect(result).toBe("healthy");
    expect(destroyForReuse).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });
});
