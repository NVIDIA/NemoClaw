// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import type { SandboxInferenceRouteHealth } from "./inference-route-health";
import type { SandboxStatusPreflightResult } from "./status-preflight";
import { collectSandboxStatusSnapshot, getSandboxStatusReport } from "./status-snapshot";

const sandbox: SandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  provider: "nvidia",
  model: "nvidia/nemotron",
  openshellDriver: "docker",
  dashboardPort: 18789,
};

const stoppedPreflight: SandboxStatusPreflightResult = {
  failure: {
    layer: "sandbox_container_stopped",
    dockerUnreachable: false,
  },
  failureLayer: "sandbox_container_stopped",
  suppressInferenceProbe: true,
  exitCode: 1,
};

const clearPreflight: SandboxStatusPreflightResult = {
  failure: null,
  failureLayer: null,
  suppressInferenceProbe: false,
  exitCode: 0,
};

const conflictPreflight: SandboxStatusPreflightResult = {
  failure: {
    layer: "sandbox_dashboard_port_conflict",
    dockerUnreachable: false,
  },
  failureLayer: "sandbox_dashboard_port_conflict",
  suppressInferenceProbe: true,
  exitCode: 1,
};

const healthyRoute: SandboxInferenceRouteHealth = {
  ok: true,
  endpoint: "https://inference.local/v1/models",
  httpStatus: 200,
  detail: "reachable",
};

function recoveredLookup() {
  return Promise.resolve({
    state: "present",
    phase: "Ready",
    output: "Phase: Ready",
    recoveredSandbox: true,
    recoverySandboxVia: "started-stopped-original",
  });
}

function snapshotDeps(recoveryResult: unknown) {
  const probeProviderHealthImpl = vi.fn(() => null);
  const probeSandboxInferenceGatewayHealthImpl = vi.fn(async () => healthyRoute);
  return {
    getSandbox: () => sandbox,
    listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: sandbox.name }),
    reconcile: recoveredLookup,
    captureOpenshellForStatusImpl: async () => {
      throw new Error("live route lookup not needed");
    },
    probeProviderHealthImpl,
    probeSandboxInferenceGatewayHealthImpl,
    probeSandboxInferenceInvocationImpl: vi.fn(() => ({ ok: true }) as const),
    recoverSandboxProcesses: vi.fn(() => recoveryResult) as never,
  };
}

describe("collectSandboxStatusSnapshot Docker recovery", () => {
  it("recovers the delivery chain when OpenShell already reports the restarted container (#7824)", async () => {
    const deps = {
      ...snapshotDeps({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      }),
      reconcile: () =>
        Promise.resolve({
          state: "present" as const,
          phase: "Ready",
          output: "Phase: Ready",
        }),
    };

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(deps.recoverSandboxProcesses).toHaveBeenCalledWith("alpha", { quiet: true });
    expect(snapshot.lookup.state).toBe("present");
  });

  it("fails closed when the visible restarted container cannot recover OpenClaw (#7824)", async () => {
    const deps = {
      ...snapshotDeps({
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
      }),
      reconcile: () =>
        Promise.resolve({
          state: "present" as const,
          phase: "Ready",
          output: "Phase: Ready",
        }),
    };

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.lookup.state).toBe("sandbox_recovery_failed");
    expect(snapshot.lookup.output).toContain(
      "Sandbox 'alpha' is present, but its agent delivery chain could not be proven",
    );
    expect(deps.probeSandboxInferenceGatewayHealthImpl).not.toHaveBeenCalled();
  });

  it.each(["Provisioning", "Failed"])(
    "keeps the existing %s phase diagnosis ahead of markerless recovery (#7824)",
    async (phase) => {
      const deps = {
        ...snapshotDeps({
          checked: true,
          wasRunning: false,
          recovered: false,
          forwardRecovered: false,
        }),
        reconcile: () =>
          Promise.resolve({
            state: "present" as const,
            phase,
            output: `Phase: ${phase}`,
          }),
      };

      const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

      expect(deps.recoverSandboxProcesses).not.toHaveBeenCalled();
      expect(snapshot.lookup.state).toBe("present");
    },
  );

  it("keeps a host preflight failure ahead of markerless recovery (#7824)", async () => {
    const deps = {
      ...snapshotDeps({
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
      }),
      reconcile: () =>
        Promise.resolve({
          state: "present" as const,
          phase: "Ready",
          output: "Phase: Ready",
        }),
    };

    const snapshot = await collectSandboxStatusSnapshot("alpha", {
      deps,
      preflight: stoppedPreflight,
    });

    expect(deps.recoverSandboxProcesses).not.toHaveBeenCalled();
    expect(snapshot.lookup.state).toBe("present");
  });

  it.each([
    [
      "inspection",
      {
        checked: false,
        wasRunning: null,
        recovered: false,
        forwardRecovered: false,
      },
    ],
    [
      "secret-boundary",
      {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        secretBoundaryRefused: true,
        secretBoundaryReason: "persisted secret boundary refused recovery",
      },
    ],
    [
      "mcp-reconciliation",
      {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        mcpReconciliationRefused: true,
        mcpReconciliationReason: "MCP intent mismatch",
      },
    ],
    [
      "gateway-recovery",
      {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
      },
    ],
    [
      "forward-recovery",
      {
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: false,
      },
    ],
    [
      "forward-recovery",
      {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: "OpenShell forward state unavailable",
      },
    ],
  ])("fails closed at the %s layer", async (layer, recoveryResult) => {
    const deps = snapshotDeps(recoveryResult);

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.lookup.state).toBe("sandbox_recovery_failed");
    expect(snapshot.lookup.output).toContain(`(${layer}:`);
    expect(deps.probeProviderHealthImpl).not.toHaveBeenCalled();
    expect(deps.probeSandboxInferenceGatewayHealthImpl).not.toHaveBeenCalled();
  });

  it("accepts a recovered gateway only when the primary forward is proven", async () => {
    const deps = snapshotDeps({
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: true,
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.lookup.state).toBe("present");
    expect(deps.probeSandboxInferenceGatewayHealthImpl).toHaveBeenCalledWith("alpha", {
      gatewayName: "nemoclaw",
    });
  });

  it("keeps a terminal runtime result neutral", async () => {
    const deps = snapshotDeps({
      checked: true,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
      runtime: "terminal",
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.lookup.state).toBe("present");
  });
});

describe("getSandboxStatusReport Docker recovery preflight refresh", () => {
  it("clears a stale stopped-container preflight after successful recovery", async () => {
    const getSandboxStatusPreflightImpl = vi
      .fn()
      .mockResolvedValueOnce(stoppedPreflight)
      .mockResolvedValueOnce(clearPreflight);
    const deps = {
      ...snapshotDeps({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      }),
      getSandboxStatusPreflightImpl,
    };

    const report = await getSandboxStatusReport("alpha", deps);

    expect(report.gatewayState).toBe("present");
    expect(report.failureLayer).toBeNull();
    expect(report.inferenceHealth).toMatchObject({ ok: true, probed: true });
    expect(getSandboxStatusPreflightImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves a dashboard-port conflict observed before Docker recovery", async () => {
    const getSandboxStatusPreflightImpl = vi
      .fn()
      .mockResolvedValueOnce(conflictPreflight)
      .mockResolvedValueOnce(clearPreflight);
    const deps = {
      ...snapshotDeps({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      }),
      getSandboxStatusPreflightImpl,
    };

    const report = await getSandboxStatusReport("alpha", deps);

    expect(report.failureLayer).toBe("sandbox_dashboard_port_conflict");
    expect(report.inferenceHealth).toBeNull();
    expect(getSandboxStatusPreflightImpl).toHaveBeenCalledOnce();
    expect(deps.probeSandboxInferenceGatewayHealthImpl).not.toHaveBeenCalled();
  });
});
