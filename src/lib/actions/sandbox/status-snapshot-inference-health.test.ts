// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ProviderHealthStatus } from "../../inference/health";
import type { SandboxEntry } from "../../state/registry";
import type { SandboxInferenceInvocationResult } from "./inference-invocation-probe";
import type { SandboxInferenceRouteHealth } from "./inference-route-health";
import { collectSandboxStatusSnapshot } from "./status-snapshot";

// Direct, unmocked coverage of `buildSandboxInferenceRouteHealth` through the
// exported `collectSandboxStatusSnapshot` entry point (it is not itself
// exported). status-flow.test.ts mocks collectSandboxStatusSnapshot wholesale
// and never exercises this code, so it never proves okLabel is actually set
// in production wiring rather than merely respected if present (#6846).
function snapshotDeps(
  gateway: SandboxInferenceRouteHealth | null,
  providerHealth: ProviderHealthStatus | null = null,
  invocation: SandboxInferenceInvocationResult = { ok: true },
) {
  const sandbox: SandboxEntry = {
    name: "alpha",
    agent: "openclaw",
    policies: [],
    provider: "nvidia",
    model: "nvidia/nemotron",
  };
  return {
    suppressInferenceProbe: false,
    deps: {
      getSandbox: () => sandbox,
      listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: sandbox.name }),
      reconcile: async () => ({ state: "present" as const, output: "Phase: Ready" }),
      // The live-route RPC lookup is independent of the authoritative
      // inference.local gateway probe under test; throwing here just leaves
      // liveRoute/routeDrift null without needing a fabricated exec transcript.
      captureOpenshellForStatusImpl: async () => {
        throw new Error("live route lookup not needed for this test");
      },
      probeProviderHealthImpl: () => providerHealth,
      probeSandboxInferenceGatewayHealthImpl: async () => gateway,
      probeSandboxInferenceInvocationImpl: () => invocation,
    },
  };
}

describe("collectSandboxStatusSnapshot inference route health", () => {
  it("restores the guarded agent and host-forward chain before probing a Docker-recovered sandbox", async () => {
    const order: string[] = [];
    const gateway: SandboxInferenceRouteHealth = {
      ok: true,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 200,
      detail: "reachable",
    };
    const options = snapshotDeps(gateway);
    options.deps.reconcile = async () => {
      order.push("reconcile");
      return {
        state: "present",
        output: "Phase: Ready",
        recoveredSandbox: true,
        recoverySandboxVia: "started-stopped-original",
      };
    };
    const recoverSandboxProcesses = vi.fn(() => {
      order.push("recover-agent-and-forward");
      return {
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      };
    });
    options.deps.probeSandboxInferenceGatewayHealthImpl = async () => {
      order.push("probe-inference");
      return gateway;
    };

    await collectSandboxStatusSnapshot("alpha", {
      ...options,
      deps: { ...options.deps, recoverSandboxProcesses },
    });

    expect(recoverSandboxProcesses).toHaveBeenCalledWith("alpha", { quiet: true });
    expect(order).toEqual(["reconcile", "recover-agent-and-forward", "probe-inference"]);
  });

  it("waits for the inference route after recovering the agent gateway", async () => {
    const unreachable: SandboxInferenceRouteHealth = {
      ok: false,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 0,
      detail: "unreachable",
    };
    const healthy: SandboxInferenceRouteHealth = {
      ok: true,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 200,
      detail: "reachable",
    };
    const options = snapshotDeps(unreachable);
    options.deps.reconcile = async () => ({
      state: "present",
      output: "Phase: Ready",
      recoveredSandbox: true,
      recoverySandboxVia: "started-stopped-original",
    });
    const probeSandboxInferenceGatewayHealthImpl = vi
      .fn()
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(healthy);
    const delayInferenceRecoveryProbe = vi.fn(async () => undefined);
    const recoverSandboxProcesses = vi.fn(() => ({
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: true,
    }));

    const snapshot = await collectSandboxStatusSnapshot("alpha", {
      ...options,
      deps: {
        ...options.deps,
        delayInferenceRecoveryProbe,
        probeSandboxInferenceGatewayHealthImpl,
        recoverSandboxProcesses,
      },
    });

    expect(probeSandboxInferenceGatewayHealthImpl).toHaveBeenCalledTimes(2);
    expect(delayInferenceRecoveryProbe).toHaveBeenCalledOnce();
    expect(delayInferenceRecoveryProbe).toHaveBeenCalledWith(2_000);
    expect(snapshot.inferenceHealth).toMatchObject({ ok: true, probed: true });
  });

  it("reports the inference route as unreachable after all post-recovery probes", async () => {
    const unreachable: SandboxInferenceRouteHealth = {
      ok: false,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 0,
      detail: "unreachable",
    };
    const options = snapshotDeps(unreachable);
    options.deps.reconcile = async () => ({
      state: "present",
      output: "Phase: Ready",
      recoveredSandbox: true,
      recoverySandboxVia: "started-stopped-original",
    });
    const probeSandboxInferenceGatewayHealthImpl = vi.fn(async () => unreachable);
    const delayInferenceRecoveryProbe = vi.fn(async () => undefined);
    const recoverSandboxProcesses = vi.fn(() => ({
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: true,
    }));

    const snapshot = await collectSandboxStatusSnapshot("alpha", {
      ...options,
      deps: {
        ...options.deps,
        delayInferenceRecoveryProbe,
        probeSandboxInferenceGatewayHealthImpl,
        recoverSandboxProcesses,
      },
    });

    expect(probeSandboxInferenceGatewayHealthImpl).toHaveBeenCalledTimes(3);
    expect(delayInferenceRecoveryProbe).toHaveBeenCalledTimes(2);
    expect(snapshot.inferenceHealth).toMatchObject({ ok: false, failureLabel: "unreachable" });
  });

  it("does not mutate the agent or host forward during an ordinary present status lookup", async () => {
    const options = snapshotDeps(null);
    const recoverSandboxProcesses = vi.fn();
    const delayInferenceRecoveryProbe = vi.fn(async () => undefined);
    const probeSandboxInferenceGatewayHealthImpl = vi.fn(
      options.deps.probeSandboxInferenceGatewayHealthImpl,
    );

    await collectSandboxStatusSnapshot("alpha", {
      ...options,
      deps: {
        ...options.deps,
        delayInferenceRecoveryProbe,
        probeSandboxInferenceGatewayHealthImpl,
        recoverSandboxProcesses,
      },
    });

    expect(recoverSandboxProcesses).not.toHaveBeenCalled();
    expect(probeSandboxInferenceGatewayHealthImpl).toHaveBeenCalledOnce();
    expect(delayInferenceRecoveryProbe).not.toHaveBeenCalled();
  });

  it("reports a served agent request as healthy and keeps reachability as its own hop (#6846)", async () => {
    const gateway: SandboxInferenceRouteHealth = {
      ok: true,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 200,
      detail:
        "Inference gateway responded HTTP 200 on https://inference.local/v1/models (full chain reachable).",
    };

    const snapshot = await collectSandboxStatusSnapshot("alpha", snapshotDeps(gateway));

    expect(snapshot.inferenceHealth).toMatchObject({
      ok: true,
      probed: true,
      providerLabel: "Inference route",
      endpoint: "https://inference.local/v1/models",
    });
    expect(snapshot.inferenceHealth?.failureLabel).toBeUndefined();
    expect(snapshot.inferenceHealth?.okLabel).toBeUndefined();
    expect(snapshot.inferenceHealth?.subprobes).toEqual([
      {
        ok: true,
        probed: true,
        providerLabel: "Inference route",
        probeLabel: "route reachability",
        endpoint: "https://inference.local/v1/models",
        detail: gateway.detail,
        okLabel: "reachable",
      },
    ]);
  });

  it("does not set okLabel for a 5xx route failure, and classifies it unhealthy (#6846)", async () => {
    const gateway: SandboxInferenceRouteHealth = {
      ok: false,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 502,
      detail:
        "Inference gateway returned HTTP 502 on https://inference.local/v1/models; the route is reachable but unhealthy.",
    };

    const snapshot = await collectSandboxStatusSnapshot("alpha", snapshotDeps(gateway));

    expect(snapshot.inferenceHealth).toMatchObject({
      ok: false,
      failureLabel: "unhealthy",
    });
    expect(snapshot.inferenceHealth?.okLabel).toBeUndefined();
  });

  it("does not set okLabel when the route is unreachable (#6846)", async () => {
    const gateway: SandboxInferenceRouteHealth = {
      ok: false,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 0,
      detail:
        "Inference gateway unreachable on https://inference.local/v1/models from inside the sandbox.",
    };

    const snapshot = await collectSandboxStatusSnapshot("alpha", snapshotDeps(gateway));

    expect(snapshot.inferenceHealth).toMatchObject({
      ok: false,
      failureLabel: "unreachable",
    });
    expect(snapshot.inferenceHealth?.okLabel).toBeUndefined();
  });

  it("stays unprobed with no okLabel when the gateway probe is unavailable (#6846)", async () => {
    const snapshot = await collectSandboxStatusSnapshot("alpha", snapshotDeps(null));

    expect(snapshot.inferenceHealth).toMatchObject({
      ok: false,
      probed: false,
      providerLabel: "Inference route",
    });
    expect(snapshot.inferenceHealth?.okLabel).toBeUndefined();
    expect(snapshot.inferenceHealth?.failureLabel).toBeUndefined();
  });

  it("keeps an upstream subprobe failure out of the served-route verdict (#6846)", async () => {
    const gateway: SandboxInferenceRouteHealth = {
      ok: true,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 200,
      detail:
        "Inference gateway responded HTTP 200 on https://inference.local/v1/models (full chain reachable).",
    };
    const providerHealth: ProviderHealthStatus = {
      ok: false,
      probed: true,
      providerLabel: "NVIDIA Endpoints",
      endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
      detail: "model invocation probe failed",
      failureLabel: "unauthorized",
    };

    const snapshot = await collectSandboxStatusSnapshot(
      "alpha",
      snapshotDeps(gateway, providerHealth),
    );

    expect(snapshot.inferenceHealth).toMatchObject({ ok: true });
    expect(snapshot.inferenceHealth?.subprobes).toContainEqual({
      ...providerHealth,
      probeLabel: "upstream",
    });
  });

  it("reports an unauthorized verdict when the reachable route rejects an agent request", async () => {
    const gateway: SandboxInferenceRouteHealth = {
      ok: true,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 401,
      detail:
        "Inference gateway responded HTTP 401 on https://inference.local/v1/models (full chain reachable).",
    };

    const snapshot = await collectSandboxStatusSnapshot(
      "alpha",
      snapshotDeps(gateway, null, {
        ok: false,
        detail: "sandbox inference invocation probe returned HTTP 401",
        httpStatus: 401,
      }),
    );

    expect(snapshot.inferenceHealth).toMatchObject({
      ok: false,
      probed: true,
      failureLabel: "unauthorized",
    });
    expect(snapshot.inferenceHealth?.okLabel).toBeUndefined();
    expect(snapshot.inferenceHealth?.detail).toContain("HTTP 401");
    expect(snapshot.inferenceHealth?.subprobes).toContainEqual(
      expect.objectContaining({ probeLabel: "route reachability", ok: true }),
    );
  });

  it("does not send an agent request when the route probe already failed", async () => {
    const gateway: SandboxInferenceRouteHealth = {
      ok: false,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 0,
      detail:
        "Inference gateway unreachable on https://inference.local/v1/models from inside the sandbox.",
    };
    const options = snapshotDeps(gateway);
    const probeSandboxInferenceInvocationImpl = vi.fn(() => ({ ok: true }) as const);

    const snapshot = await collectSandboxStatusSnapshot("alpha", {
      ...options,
      deps: { ...options.deps, probeSandboxInferenceInvocationImpl },
    });

    expect(probeSandboxInferenceInvocationImpl).not.toHaveBeenCalled();
    expect(snapshot.inferenceHealth).toMatchObject({ ok: false, failureLabel: "unreachable" });
  });
});
