// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// #6192: `status` must treat the in-sandbox `inference.local` route as the
// authoritative inference-health signal. These tests drive the real
// `collectSandboxStatusSnapshot` production path, injecting only the upstream
// provider probe and the in-sandbox route probe, and assert the resulting
// `inferenceHealth` (the object serialized into `status --json` and the object
// the command's exit gate keys off `inferenceHealth.ok`).

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderHealthStatus } from "../../inference/health";
import type { SandboxInferenceGatewayHealth } from "./process-recovery";
import type { collectSandboxStatusSnapshot as CollectSnapshot } from "./status-snapshot";

const requireDist = createRequire(import.meta.url);
const snapshotModulePath = "./status-snapshot.js";

function loadSnapshot(): typeof CollectSnapshot {
  delete require.cache[requireDist.resolve(snapshotModulePath)];
  const runtime = requireDist("../../adapters/openshell/runtime.js");
  // reconcile reports "present", so the snapshot issues `inference get`; stub it
  // (empty output) so currentProvider falls back to the registry provider and no
  // real openshell process is spawned.
  vi.spyOn(runtime, "captureOpenshellForStatus").mockResolvedValue({ status: 0, output: "" });
  return requireDist(snapshotModulePath).collectSandboxStatusSnapshot;
}

const upstreamHealthy: ProviderHealthStatus = {
  ok: true,
  probed: true,
  providerLabel: "NVIDIA Cloud",
  endpoint: "https://integrate.api.nvidia.com/v1/models",
  detail: "healthy",
};

function runSnapshot(
  provider: string,
  route: SandboxInferenceGatewayHealth,
  upstream: ProviderHealthStatus | null,
) {
  const collect = loadSnapshot();
  return collect("alpha", {
    deps: {
      getSandbox: () =>
        ({
          name: "alpha",
          agent: "openclaw",
          model: "m",
          provider,
          openshellDriver: "docker",
          gatewayName: "nemoclaw-19080",
          gatewayPort: 19080,
        }) as never,
      reconcile: async () => ({ state: "present", output: "" }) as never,
      probeProviderHealthImpl: () => upstream,
      probeInferenceGatewayHealthImpl: async () => route,
    },
  });
}

function route(state: SandboxInferenceGatewayHealth["state"], httpStatus: number) {
  return {
    ok: state === "reachable",
    state,
    endpoint: "https://inference.local/v1/models",
    httpStatus,
    detail: `route ${state}`,
  };
}

describe("collectSandboxStatusSnapshot inference.local authority (#6192)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes a reachable route the authoritative healthy result, upstream demoted", async () => {
    const snap = await runSnapshot("nvidia-prod", route("reachable", 200), upstreamHealthy);
    expect(snap.inferenceHealth?.ok).toBe(true);
    expect(snap.inferenceHealth?.probed).toBe(true);
    expect(snap.inferenceHealth?.endpoint).toBe("https://inference.local/v1/models");
    // upstream reachability retained as a demoted, labeled diagnostic
    expect(snap.inferenceHealth?.subprobes).toEqual([
      expect.objectContaining({ probeLabel: "provider", ok: true }),
    ]);
  });

  it("fails closed on a 5xx route even when upstream is healthy", async () => {
    const snap = await runSnapshot("nvidia-prod", route("unhealthy", 503), upstreamHealthy);
    expect(snap.inferenceHealth?.ok).toBe(false);
    expect(snap.inferenceHealth?.failureLabel).toBe("unhealthy");
  });

  it("fails closed on a broken (000) route even when upstream is healthy", async () => {
    const snap = await runSnapshot("nvidia-prod", route("broken", 0), upstreamHealthy);
    expect(snap.inferenceHealth?.ok).toBe(false);
    expect(snap.inferenceHealth?.failureLabel).toBe("unreachable");
  });

  it("fails closed when the route probe is unavailable", async () => {
    const snap = await runSnapshot("nvidia-prod", route("unavailable", 0), upstreamHealthy);
    expect(snap.inferenceHealth?.ok).toBe(false);
  });

  it("probes the route for providers with no registered direct health probe", async () => {
    // nvidia-router / hermes-provider return null from probeProviderHealth; the
    // route must still be probed and become the authoritative result.
    const snap = await runSnapshot("nvidia-router", route("broken", 0), null);
    expect(snap.inferenceHealth?.probed).toBe(true);
    expect(snap.inferenceHealth?.ok).toBe(false);
    expect(snap.inferenceHealth?.subprobes).toEqual([]);
  });
});
