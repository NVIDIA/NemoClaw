// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { GatewayReuseState } from "../state/gateway";
import type { GatewayContainerState } from "./gateway-container-running";
import {
  type PreflightGatewaySequenceDeps,
  runPreflightGatewaySequence,
} from "./preflight-gateway-sequence";

interface SequenceHarness {
  deps: PreflightGatewaySequenceDeps;
  destructive: Record<string, ReturnType<typeof vi.fn>>;
}

function harness(overrides: {
  gatewayReuseState: GatewayReuseState;
  externallySupervised: boolean;
  containerState?: GatewayContainerState;
  orphanContainerPresent?: boolean;
  httpReady?: boolean;
  imageDrift?: { currentVersion: string; expectedVersion: string } | null;
  destroyedReuseState?: GatewayReuseState;
}): SequenceHarness {
  const destroyGateway = vi.fn(() => true);
  const destroyGatewayForReuse = vi.fn(
    (): GatewayReuseState => overrides.destroyedReuseState ?? "missing",
  );
  const runOpenshell = vi.fn();
  const dockerStop = vi.fn();
  const dockerRm = vi.fn();
  const dockerRemoveVolumesByPrefix = vi.fn();
  const clearRegistry = vi.fn();
  const stopDashboardForward = vi.fn();
  const stopAllDashboardForwards = vi.fn();
  const exitProcess = vi.fn((code: number): never => {
    throw new Error(`exit ${code}`);
  });
  let inspectCalls = 0;
  const deps: PreflightGatewaySequenceDeps = {
    gatewayReuseState: overrides.gatewayReuseState,
    externallySupervised: overrides.externallySupervised,
    supportsLifecycleCommands: true,
    isDockerDriverGatewayEnabled: false,
    gatewayName: "nemoclaw",
    cliDisplayName: "NemoClaw",
    dashboardPort: 3000,
    verifyGatewayContainerRunning: () => overrides.containerState ?? "running",
    recoverGatewayRuntime: async () => true,
    waitForGatewayHttpReady: async () => overrides.httpReady ?? true,
    getGatewayLocalEndpoint: () => "http://127.0.0.1:8080",
    stopDashboardForward,
    stopAllDashboardForwards,
    getGatewayClusterImageDrift: () => overrides.imageDrift ?? null,
    exitProcess: exitProcess as unknown as (code: number) => never,
    destroyGateway,
    destroyGatewayForReuse,
    runOpenshell,
    dockerInspect: () => {
      inspectCalls += 1;
      // Only the first inspect finds the orphan; the post-removal inspect
      // reports the container gone so volume/registry cleanup proceeds.
      const present = (overrides.orphanContainerPresent ?? false) && inspectCalls === 1;
      return { status: present ? 0 : 1 };
    },
    dockerStop,
    dockerRm,
    dockerRemoveVolumesByPrefix,
    clearRegistry,
    log: () => {},
    warn: () => {},
  };
  return {
    deps,
    destructive: {
      destroyGateway,
      destroyGatewayForReuse,
      dockerStop,
      dockerRm,
      dockerRemoveVolumesByPrefix,
      clearRegistry,
      runOpenshell,
      stopDashboardForward,
      stopAllDashboardForwards,
    },
  };
}

function expectNoDestructiveEffect(h: SequenceHarness): void {
  for (const [name, fn] of Object.entries(h.destructive)) {
    expect(fn, `${name} must not run under external supervision`).not.toHaveBeenCalled();
  }
}

describe("full preflight gateway sequence under external supervision (#6576)", () => {
  it("crosses the whole path with zero destructive effects when metadata is missing and an orphan-looking container exists", async () => {
    // The original regression: "missing" only means NemoClaw holds no
    // metadata, but the container is the supervisor's live gateway.
    const h = harness({
      gatewayReuseState: "missing",
      externallySupervised: true,
      orphanContainerPresent: true,
    });
    const result = await runPreflightGatewaySequence(h.deps);
    expect(result).toBe("missing");
    expectNoDestructiveEffect(h);
  });

  it.each<GatewayReuseState>([
    "healthy",
    "stale",
    "active-unnamed",
    "foreign-active",
  ])("performs no cleanup and preserves reuse state %s", async (gatewayReuseState) => {
    const h = harness({
      gatewayReuseState,
      externallySupervised: true,
      containerState: "missing",
      orphanContainerPresent: true,
      httpReady: false,
      imageDrift: { currentVersion: "1.0.0", expectedVersion: "2.0.0" },
    });
    const result = await runPreflightGatewaySequence(h.deps);
    expect(result).toBe(gatewayReuseState);
    expectNoDestructiveEffect(h);
  });
});

describe("full preflight gateway sequence when NemoClaw owns the gateway (#6576)", () => {
  it("still removes a genuinely orphaned container end-to-end", async () => {
    const h = harness({
      gatewayReuseState: "missing",
      externallySupervised: false,
      orphanContainerPresent: true,
    });
    await runPreflightGatewaySequence(h.deps);
    expect(h.destructive.dockerStop).toHaveBeenCalledWith("openshell-cluster-nemoclaw", {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(h.destructive.dockerRm).toHaveBeenCalled();
    expect(h.destructive.dockerRemoveVolumesByPrefix).toHaveBeenCalled();
    expect(h.destructive.clearRegistry).toHaveBeenCalled();
  });

  it("still destroys a stale legacy session through the cleanup stage", async () => {
    const h = harness({
      gatewayReuseState: "stale",
      externallySupervised: false,
      destroyedReuseState: "missing",
    });
    await runPreflightGatewaySequence(h.deps);
    expect(h.destructive.destroyGatewayForReuse).toHaveBeenCalledTimes(1);
    expect(h.destructive.runOpenshell).toHaveBeenCalledWith(["forward", "stop", "3000"], {
      ignoreError: true,
    });
  });

  it("feeds each stage the reuse state the previous stage produced", async () => {
    // Reconciliation downgrades "healthy" (stale metadata, container gone) to
    // "missing"; the orphan stage must then consume that downgraded state and
    // clean up. A composition regression that re-reads the original input
    // would skip the orphan stage entirely.
    const h = harness({
      gatewayReuseState: "healthy",
      externallySupervised: false,
      containerState: "missing",
      orphanContainerPresent: true,
      destroyedReuseState: "missing",
    });
    const result = await runPreflightGatewaySequence(h.deps);
    expect(h.destructive.destroyGatewayForReuse).toHaveBeenCalledTimes(1);
    expect(h.destructive.dockerStop).toHaveBeenCalled();
    expect(result).toBe("missing");
  });
});
