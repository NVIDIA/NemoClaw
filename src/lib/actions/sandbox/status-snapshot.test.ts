// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ProviderHealthStatus } from "../../inference/health";
import type { SandboxGatewayState } from "./gateway-state";
import { collectSandboxStatusSnapshot } from "./status-snapshot";

const presentLookup: SandboxGatewayState = {
  state: "present",
  output: "Name: alpha\nPhase: Ready\n",
};

// Upstream provider endpoint is reachable on its own; a broken in-sandbox
// route must still be surfaced.
const reachableProviderHealth: ProviderHealthStatus = {
  ok: true,
  probed: true,
  providerLabel: "NVIDIA Cloud",
  endpoint: "https://integrate.api.nvidia.com/v1/models",
  detail: "reachable",
};

function runSnapshot(options: { provider: string | null; gatewayOk: boolean }) {
  const sandboxEntry = {
    name: "alpha",
    agent: "openclaw",
    model: "registry-model",
    ...(options.provider ? { provider: options.provider } : {}),
    openshellDriver: "docker",
  };
  const probeInferenceGateway = vi.fn(async () =>
    options.gatewayOk
      ? {
          ok: true,
          endpoint: "https://inference.local/v1/models",
          httpStatus: 200,
          detail: "Inference gateway responded HTTP 200 (full chain reachable).",
        }
      : {
          ok: false,
          endpoint: "https://inference.local/v1/models",
          httpStatus: 0,
          detail: "Inference gateway unreachable on https://inference.local/v1/models",
        },
  );
  const snapshot = collectSandboxStatusSnapshot("alpha", {
    deps: {
      getSandbox: (() => sandboxEntry) as never,
      reconcile: async () => presentLookup,
      // Live `inference get` reports the active provider so the snapshot picks
      // the cloud route without spawning openshell.
      captureLiveInference: (async () => ({
        status: 0,
        output: options.provider ? `Provider: ${options.provider}\nModel: nemotron\n` : "",
      })) as never,
      probeInferenceGateway: probeInferenceGateway as never,
      // A fresh clone per call: the snapshot mutates `subprobes`/`ok` in place.
      probeProviderHealthImpl: (provider: string) =>
        provider === "unknown" ? null : { ...reachableProviderHealth },
    },
  });
  return { probeInferenceGateway, snapshot };
}

describe("collectSandboxStatusSnapshot inference.local subprobe (#6192)", () => {
  it("degrades the aggregate to unhealthy when the inference.local route is broken", async () => {
    const { probeInferenceGateway, snapshot } = runSnapshot({
      provider: "nvidia-prod",
      gatewayOk: false,
    });
    const result = await snapshot;

    // Cloud providers now have the route the agent actually uses probed.
    expect(probeInferenceGateway).toHaveBeenCalledWith("alpha");
    expect(result.currentProvider).toBe("nvidia-prod");
    // The aggregate is surfaced verbatim as `report.inferenceHealth` in --json
    // and drives the text summary. It must NOT stay healthy when the real route
    // is broken, even though the upstream provider endpoint is reachable.
    expect(result.inferenceHealth?.ok).toBe(false);
    expect(result.inferenceHealth?.failureLabel).toBe("unreachable");
    expect(result.inferenceHealth?.subprobes).toEqual([
      expect.objectContaining({
        providerLabel: "Inference gateway chain",
        probeLabel: "gateway",
        ok: false,
      }),
    ]);
  });

  it("keeps the aggregate healthy when the inference.local route is reachable", async () => {
    const { snapshot } = runSnapshot({ provider: "nvidia-prod", gatewayOk: true });
    const result = await snapshot;

    expect(result.inferenceHealth?.ok).toBe(true);
    expect(result.inferenceHealth?.failureLabel).toBeUndefined();
    expect(result.inferenceHealth?.subprobes?.[0]?.ok).toBe(true);
  });

  it("skips the inference.local subprobe when the provider is unknown", async () => {
    const { probeInferenceGateway, snapshot } = runSnapshot({ provider: null, gatewayOk: false });
    const result = await snapshot;

    expect(result.currentProvider).toBe("unknown");
    expect(probeInferenceGateway).not.toHaveBeenCalled();
  });
});
