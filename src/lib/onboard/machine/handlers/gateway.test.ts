// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import type { GatewayContainerState } from "../../gateway-container-running";
import type { GatewayReuseState } from "../../../state/gateway";
import { handleGatewayState, type GatewayStateOptions } from "./gateway";

type Gpu = { type: string } | null;

function createDeps(overrides: Partial<GatewayStateOptions<Gpu>["deps"]> = {}) {
  const calls = {
    refresh: vi.fn(async (state: GatewayReuseState) => state),
    lifecycle: vi.fn(() => false),
    verifyContainer: vi.fn((_gatewayName: string): GatewayContainerState => "running"),
    waitHttp: vi.fn(async () => true),
    recoverGateway: vi.fn(async () => true),
    stopDashboardForward: vi.fn(),
    destroy: vi.fn(() => true),
    destroyForReuse: vi.fn(() => "missing" as GatewayReuseState),
    imageDrift: vi.fn(() => null),
    stopForwards: vi.fn(),
    reconcileGpu: vi.fn((opts: { gatewayReuseState: GatewayReuseState }) => opts.gatewayReuseState),
    dockerDriver: vi.fn(() => false),
    retireLegacy: vi.fn(),
    destroyGpuRuntime: vi.fn(() => true),
    skipped: vi.fn(),
    recordSkip: vi.fn(async () => createSession()),
    note: vi.fn(),
    startStep: vi.fn(async () => undefined),
    startGateway: vi.fn(async () => undefined),
    complete: vi.fn(async () => createSession()),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
  return {
    calls,
    deps: {
      refreshDockerDriverGatewayReuseState: calls.refresh,
      gatewayCliSupportsLifecycleCommands: calls.lifecycle,
      verifyGatewayContainerRunning: calls.verifyContainer,
      waitForGatewayHttpReady: calls.waitHttp,
      recoverGatewayRuntime: calls.recoverGateway,
      getGatewayLocalEndpoint: () => "http://127.0.0.1:31818",
      stopDashboardForward: calls.stopDashboardForward,
      destroyGateway: calls.destroy,
      destroyGatewayForReuse: calls.destroyForReuse,
      getGatewayClusterImageDrift: calls.imageDrift,
      stopAllDashboardForwards: calls.stopForwards,
      reconcileGatewayGpuReuseForGpuIntent: calls.reconcileGpu,
      isLinuxDockerDriverGatewayEnabled: calls.dockerDriver,
      retireLegacyGatewayForDockerDriverUpgrade: calls.retireLegacy,
      destroyGatewayRuntimeForGpuReuse: calls.destroyGpuRuntime,
      skippedStepMessage: calls.skipped,
      recordStateSkipped: calls.recordSkip,
      note: calls.note,
      startRecordedStep: calls.startStep,
      startGateway: calls.startGateway,
      recordStepComplete: calls.complete,
      exitProcess: calls.exit,
      ...overrides,
    },
  };
}

function baseOptions(
  deps: GatewayStateOptions<Gpu>["deps"],
  initialGatewayReuseState: GatewayReuseState = "missing",
  session: Session | null = createSession(),
): GatewayStateOptions<Gpu> {
  return {
    resume: false,
    session,
    initialGatewayReuseState,
    gpu: { type: "nvidia" },
    gpuPassthrough: true,
    gatewayName: "nemoclaw",
    recordedSandboxName: null,
    requestedSandboxName: "my-assistant",
    recreateSandbox: false,
    deps,
  };
}

describe("handleGatewayState", () => {
  it("starts the gateway when no reusable gateway exists", async () => {
    const { deps, calls } = createDeps();

    const result = await handleGatewayState(baseOptions(deps, "missing"));

    expect(calls.startStep).toHaveBeenCalledWith("gateway");
    expect(calls.startGateway).toHaveBeenCalledWith({ type: "nvidia" }, { gpuPassthrough: true });
    expect(calls.complete).toHaveBeenCalledWith("gateway");
    expect(result.gatewayReuseState).toBe("missing");
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "provider_selection",
      transitionKind: "advance",
      updates: undefined,
      metadata: { state: "gateway", gatewayReuseState: "missing" },
    });
  });

  it("reuses healthy gateways on fresh runs", async () => {
    const { deps, calls } = createDeps();

    await handleGatewayState(baseOptions(deps, "healthy"));

    expect(calls.skipped).toHaveBeenCalledWith("gateway", "running", "reuse");
    expect(calls.recordSkip).toHaveBeenCalledWith("gateway", {
      reason: "reuse",
      reuseState: "healthy",
    });
    expect(calls.note).toHaveBeenCalledWith("  Reusing healthy NemoClaw gateway.");
    expect(calls.startGateway).not.toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith("gateway");
  });

  it("reuses healthy gateways on resume only when the gateway step was complete", async () => {
    const session = createSession();
    session.steps.gateway.status = "complete";
    const { deps, calls } = createDeps();

    await handleGatewayState({ ...baseOptions(deps, "healthy", session), resume: true });

    expect(calls.skipped).toHaveBeenCalledWith("gateway", "running");
    expect(calls.recordSkip).toHaveBeenCalledWith("gateway", {
      reason: "resume",
      reuseState: "healthy",
    });
    expect(calls.startGateway).not.toHaveBeenCalled();
  });

  it("reuses a lifecycle gateway when container, HTTP, and image checks are healthy", async () => {
    const { deps, calls } = createDeps({
      gatewayCliSupportsLifecycleCommands: vi.fn(() => true),
    });

    await handleGatewayState(baseOptions(deps, "healthy"));

    expect(calls.verifyContainer).toHaveBeenCalledWith("nemoclaw");
    expect(calls.waitHttp).toHaveBeenCalledOnce();
    expect(calls.imageDrift).toHaveBeenCalledOnce();
    expect(calls.stopDashboardForward).not.toHaveBeenCalled();
    expect(calls.destroyForReuse).not.toHaveBeenCalled();
    expect(calls.startGateway).not.toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith("gateway");
  });

  it("cleans stale lifecycle metadata when the gateway container is missing", async () => {
    const { deps, calls } = createDeps({
      gatewayCliSupportsLifecycleCommands: vi.fn(() => true),
      verifyGatewayContainerRunning: vi.fn(() => "missing" as GatewayContainerState),
      destroyGatewayForReuse: vi.fn(() => "missing" as GatewayReuseState),
    });

    await handleGatewayState(baseOptions(deps, "healthy"));

    expect(calls.stopDashboardForward).toHaveBeenCalledOnce();
    expect(deps.destroyGatewayForReuse).toHaveBeenCalledWith(
      deps.destroyGateway,
      "  ✓ Stale gateway metadata cleaned up",
      "  ! Stale gateway metadata cleanup failed; leaving registry state intact.",
    );
    expect(calls.startGateway).toHaveBeenCalled();
  });

  it("recovers a stopped lifecycle gateway without destroying volumes (#4187)", async () => {
    const recoverGateway = vi.fn(async () => true);
    const { deps, calls } = createDeps({
      gatewayCliSupportsLifecycleCommands: vi.fn(() => true),
      verifyGatewayContainerRunning: vi.fn(() => "stopped" as GatewayContainerState),
      recoverGatewayRuntime: recoverGateway,
    });

    await handleGatewayState(baseOptions(deps, "healthy"));

    expect(recoverGateway).toHaveBeenCalledOnce();
    expect(calls.stopDashboardForward).not.toHaveBeenCalled();
    expect(calls.destroyForReuse).not.toHaveBeenCalled();
    expect(calls.exit).not.toHaveBeenCalled();
    expect(calls.startGateway).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith("gateway", "running", "reuse");
    expect(calls.complete).toHaveBeenCalledWith("gateway");
  });

  it("refuses to destroy volumes when stopped-container recovery fails (#4187)", async () => {
    const recoverGateway = vi.fn(async () => false);
    const { deps, calls } = createDeps({
      gatewayCliSupportsLifecycleCommands: vi.fn(() => true),
      verifyGatewayContainerRunning: vi.fn(() => "stopped" as GatewayContainerState),
      recoverGatewayRuntime: recoverGateway,
    });

    await expect(handleGatewayState(baseOptions(deps, "healthy"))).rejects.toThrow("exit 1");

    expect(recoverGateway).toHaveBeenCalledOnce();
    expect(calls.exit).toHaveBeenCalledWith(1);
    expect(calls.destroyForReuse).not.toHaveBeenCalled();
    expect(calls.stopDashboardForward).not.toHaveBeenCalled();
  });

  it("still recreates a recovered stopped gateway when image drift is detected (#4187)", async () => {
    const recoverGateway = vi.fn(async () => true);
    const { deps, calls } = createDeps({
      gatewayCliSupportsLifecycleCommands: vi.fn(() => true),
      verifyGatewayContainerRunning: vi.fn(() => "stopped" as GatewayContainerState),
      recoverGatewayRuntime: recoverGateway,
      getGatewayClusterImageDrift: vi.fn(() => ({
        currentVersion: "0.0.38",
        expectedVersion: "0.0.39",
      })),
      destroyGatewayForReuse: vi.fn(() => "missing" as GatewayReuseState),
    });

    await handleGatewayState(baseOptions(deps, "healthy"));

    expect(recoverGateway).toHaveBeenCalledOnce();
    expect(calls.stopForwards).toHaveBeenCalledOnce();
    expect(deps.destroyGatewayForReuse).toHaveBeenCalledWith(
      deps.destroyGateway,
      "  ✓ Previous gateway cleaned up",
      "  ! Previous gateway cleanup failed; leaving registry state intact.",
    );
  });

  it("refuses to destroy an unknown container state when HTTP is also unavailable", async () => {
    const { deps, calls } = createDeps({
      gatewayCliSupportsLifecycleCommands: vi.fn(() => true),
      verifyGatewayContainerRunning: vi.fn(
        (_gatewayName: string): GatewayContainerState => "unknown",
      ),
      waitForGatewayHttpReady: vi.fn(async () => false),
    });

    await expect(handleGatewayState(baseOptions(deps, "healthy"))).rejects.toThrow("exit 1");

    expect(calls.exit).toHaveBeenCalledWith(1);
    expect(calls.destroyForReuse).not.toHaveBeenCalled();
  });

  it("recreates a running lifecycle gateway when the HTTP endpoint is unhealthy", async () => {
    const { deps, calls } = createDeps({
      gatewayCliSupportsLifecycleCommands: vi.fn(() => true),
      waitForGatewayHttpReady: vi.fn(async () => false),
      destroyGatewayForReuse: vi.fn(() => "missing" as GatewayReuseState),
    });

    await handleGatewayState(baseOptions(deps, "healthy"));

    expect(calls.stopDashboardForward).toHaveBeenCalledOnce();
    expect(deps.destroyGatewayForReuse).toHaveBeenCalledWith(
      deps.destroyGateway,
      "  ✓ Stale gateway cleaned up",
      "  ! Stale gateway cleanup failed; leaving registry state intact.",
    );
  });

  it("recreates on gateway image drift after stopping dashboard forwards", async () => {
    const { deps, calls } = createDeps({
      gatewayCliSupportsLifecycleCommands: vi.fn(() => true),
      waitForGatewayHttpReady: vi.fn(async () => true),
      getGatewayClusterImageDrift: vi.fn(() => ({
        currentVersion: "0.0.38",
        expectedVersion: "0.0.39",
      })),
      destroyGatewayForReuse: vi.fn(() => "missing" as GatewayReuseState),
    });

    await handleGatewayState(baseOptions(deps, "healthy"));

    expect(calls.stopForwards).toHaveBeenCalledOnce();
    expect(deps.destroyGatewayForReuse).toHaveBeenCalledWith(
      deps.destroyGateway,
      "  ✓ Previous gateway cleaned up",
      "  ! Previous gateway cleanup failed; leaving registry state intact.",
    );
  });

  it("replaces legacy metadata before starting the Docker-driver gateway", async () => {
    const { deps, calls } = createDeps({
      isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
      reconcileGatewayGpuReuseForGpuIntent: vi.fn(() => "stale" as GatewayReuseState),
    });

    const result = await handleGatewayState(baseOptions(deps, "healthy"));

    expect(calls.note).toHaveBeenCalledWith(
      "  Replacing legacy OpenShell gateway metadata with Docker-driver gateway.",
    );
    expect(calls.retireLegacy).toHaveBeenCalledOnce();
    expect(calls.startGateway).toHaveBeenCalledOnce();
    expect(result.gatewayReuseState).toBe("missing");
  });

  it("emits the step [2/8] header before retiring the legacy Docker-driver gateway", async () => {
    const order: string[] = [];
    const { deps, calls } = createDeps({
      isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
      reconcileGatewayGpuReuseForGpuIntent: vi.fn(() => "stale" as GatewayReuseState),
      startRecordedStep: vi.fn(async (step: string) => {
        order.push(`startRecordedStep:${step}`);
      }),
      retireLegacyGatewayForDockerDriverUpgrade: vi.fn(() => {
        order.push("retireLegacy");
      }),
      startGateway: vi.fn(async () => {
        order.push("startGateway");
      }),
    });

    await handleGatewayState(baseOptions(deps, "healthy"));

    expect(order).toEqual(["startRecordedStep:gateway", "retireLegacy", "startGateway"]);
    expect(calls.note).toHaveBeenCalledWith(
      "  Replacing legacy OpenShell gateway metadata with Docker-driver gateway.",
    );
  });

  it("does not retire a foreign-active Docker-driver gateway (concurrent instances)", async () => {
    const { deps, calls } = createDeps({
      isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
      reconcileGatewayGpuReuseForGpuIntent: vi.fn(() => "foreign-active" as GatewayReuseState),
    });

    const result = await handleGatewayState(baseOptions(deps, "foreign-active"));

    expect(calls.retireLegacy).not.toHaveBeenCalled();
    expect(calls.note).not.toHaveBeenCalledWith(
      "  Replacing legacy OpenShell gateway metadata with Docker-driver gateway.",
    );
    expect(calls.startGateway).toHaveBeenCalledOnce();
    expect(result.gatewayReuseState).toBe("missing");
  });
});
