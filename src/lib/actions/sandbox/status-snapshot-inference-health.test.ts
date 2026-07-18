// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ProviderHealthStatus } from "../../inference/health";
import type { SandboxEntry } from "../../state/registry";
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
    },
  };
}

describe("collectSandboxStatusSnapshot inference route health", () => {
  it("labels a reachable route okLabel: reachable, not a bare healthy claim (#6846)", async () => {
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
      okLabel: "reachable",
    });
    expect(snapshot.inferenceHealth?.failureLabel).toBeUndefined();
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

  it("keeps a failed model-invocation subprobe distinct from the reachable route label (#6846)", async () => {
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

    expect(snapshot.inferenceHealth).toMatchObject({ ok: true, okLabel: "reachable" });
    expect(snapshot.inferenceHealth?.subprobes).toEqual([
      { ...providerHealth, probeLabel: "upstream" },
    ]);
  });
});
