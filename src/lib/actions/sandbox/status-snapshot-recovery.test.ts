// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const intentionalStopPreflight: SandboxStatusPreflightResult = {
  ...clearPreflight,
  intentionalStopConfirmed: true,
  suppressInferenceProbe: true,
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
    listPublishedSandboxesAcrossGatewayRoots: () => [sandbox],
    listPublishedSandboxNamesAcrossGatewayRoots: () => [sandbox.name],
    reconcile: recoveredLookup,
    inferenceRouteObserver: {
      observeInferenceRoute: async () => {
        throw new Error("live route lookup not needed");
      },
    },
    probeProviderHealthImpl,
    probeSandboxInferenceGatewayHealthImpl,
    probeSandboxInferenceInvocationImpl: vi.fn(async () => ({ ok: true }) as const),
    recoverSandboxProcesses: vi.fn(async () => recoveryResult) as never,
  };
}

describe("collectSandboxStatusSnapshot Docker recovery", () => {
  it("uses an explicit cross-root sandbox entry instead of the local registry fallback", async () => {
    const crossRootSandbox: SandboxEntry = { ...sandbox, openshellDriver: "mxc" };
    const getSandbox = vi.fn(() => null);
    const reconcile = vi.fn(async () => ({
      state: "present" as const,
      phase: "Error",
      output: "Phase: Error",
    }));
    const deps = {
      ...snapshotDeps({
        checked: false,
        wasRunning: null,
        recovered: false,
        forwardRecovered: false,
      }),
      getSandbox,
      reconcile,
    };

    const snapshot = await collectSandboxStatusSnapshot("alpha", {
      deps,
      sandboxEntry: crossRootSandbox,
      suppressInferenceProbe: true,
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith("alpha");
    expect(snapshot.sb).toEqual(crossRootSandbox);
    expect(snapshot.recordedRoute).toEqual({
      provider: crossRootSandbox.provider,
      model: crossRootSandbox.model,
    });
  });

  it("clears stale stop intent in the cross-root registry that owns the sandbox", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-status-cross-root-"));
    const registryDir = path.join(home, ".nemoclaw", "gateways", "8245");
    const registryFile = path.join(registryDir, "sandboxes.json");
    const crossRootSandbox: SandboxEntry = {
      ...sandbox,
      agent: "langchain-deepagents-code",
      gatewayPort: 8245,
      stopped: true,
    };
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: null,
        defaultSelectionRevision: 1,
        sandboxes: { alpha: crossRootSandbox },
      }),
    );
    vi.stubEnv("HOME", home);

    try {
      const snapshot = await collectSandboxStatusSnapshot("alpha", {
        sandboxEntry: crossRootSandbox,
        preflight: clearPreflight,
        deps: {
          ...snapshotDeps({
            checked: false,
            wasRunning: null,
            recovered: false,
            forwardRecovered: false,
          }),
          reconcile: async () => ({
            state: "present" as const,
            phase: "Ready",
            output: "Phase: Ready",
          }),
        },
      });

      const persisted = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
        sandboxes: { alpha: SandboxEntry };
      };
      expect(snapshot.lookup.state).toBe("present");
      expect(persisted.sandboxes.alpha.stopped).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves agent delivery recovery to the native image runtime", async () => {
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

    expect(deps.recoverSandboxProcesses).not.toHaveBeenCalled();
    expect(snapshot.lookup.state).toBe("present");
  });

  it("does not reinterpret a ready sandbox when native recovery is unavailable", async () => {
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

    expect(deps.recoverSandboxProcesses).not.toHaveBeenCalled();
    expect(snapshot.lookup.state).toBe("present");
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

  it("does not recover delivery after provider-confirmed intentional stop (#11025)", async () => {
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

    const snapshot = await collectSandboxStatusSnapshot("alpha", {
      deps,
      preflight: intentionalStopPreflight,
    });

    expect(deps.recoverSandboxProcesses).not.toHaveBeenCalled();
    expect(snapshot.lookup.state).toBe("present");
    expect(snapshot.inferenceHealth).toBeNull();
    expect(deps.probeSandboxInferenceGatewayHealthImpl).not.toHaveBeenCalled();
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

describe("getSandboxStatusReport", () => {
  it("uses cross-root sandbox authority for the JSON status report", async () => {
    const crossRootSandbox: SandboxEntry = {
      ...sandbox,
      openshellDriver: "mxc",
      gatewayPort: 19000,
    };
    const findSandboxAcrossGatewayRoots = vi.fn(() => ({
      entry: crossRootSandbox,
      gatewayPort: 19000,
      registryFile: "/test/.nemoclaw-gateway-19000/sandboxes.json",
    }));
    const { getSandbox: _getSandbox, ...deps } = snapshotDeps({
      checked: false,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
    });

    const report = await getSandboxStatusReport("alpha", {
      ...deps,
      findSandboxAcrossGatewayRoots,
      getGatewayPresets: async () => [],
      getSandboxStatusPreflightImpl: vi.fn(async () => clearPreflight),
      reconcile: vi.fn(async () => ({
        state: "present" as const,
        phase: "Error",
        output: "Phase: Error",
      })),
    });

    expect(findSandboxAcrossGatewayRoots).toHaveBeenCalledWith("alpha");
    expect(report.found).toBe(true);
    expect(report.openshellDriver).toBe("mxc");
    expect(report.recordedRoute).toEqual({
      provider: crossRootSandbox.provider,
      model: crossRootSandbox.model,
    });
  });

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
