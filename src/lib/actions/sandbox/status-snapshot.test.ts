// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxGatewayState } from "./gateway-state";
import type { ProviderHealthStatus } from "../../inference/health";

type CollectSandboxStatusSnapshot =
  typeof import("./status-snapshot")["collectSandboxStatusSnapshot"];

const requireDist = createRequire(import.meta.url);
const snapshotModulePath = "./status-snapshot.js";

// Warm the CommonJS source graph outside the first test's timeout.
requireDist(snapshotModulePath);
delete require.cache[requireDist.resolve(snapshotModulePath)];

const presentLookup: SandboxGatewayState = {
  state: "present",
  output: "Name: alpha\nPhase: Ready\n",
};

const reachableCloudHealth: ProviderHealthStatus = {
  ok: true,
  probed: true,
  providerLabel: "NVIDIA Cloud",
  endpoint: "https://integrate.api.nvidia.com/v1/models",
  detail: "reachable",
};

function createSnapshotHarness(options: {
  provider: string | null;
  inferenceOutput: string;
}) {
  delete require.cache[requireDist.resolve(snapshotModulePath)];

  const runtime = requireDist("../../adapters/openshell/runtime.js");
  const processRecovery = requireDist("./process-recovery.js");

  vi.spyOn(runtime, "captureOpenshellForStatus").mockResolvedValue({
    status: 0,
    output: options.inferenceOutput,
  });
  const probeSandboxInferenceGatewayHealthSpy = vi
    .spyOn(processRecovery, "probeSandboxInferenceGatewayHealth")
    .mockResolvedValue({
      ok: false,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 0,
      detail: "Inference gateway unreachable on https://inference.local/v1/models",
    });

  const sandboxEntry = {
    name: "alpha",
    agent: "openclaw",
    model: "registry-model",
    ...(options.provider ? { provider: options.provider } : {}),
    openshellDriver: "docker",
  };

  const collectSandboxStatusSnapshot: CollectSandboxStatusSnapshot =
    requireDist(snapshotModulePath).collectSandboxStatusSnapshot;

  return {
    probeSandboxInferenceGatewayHealthSpy,
    run: () =>
      collectSandboxStatusSnapshot("alpha", {
        deps: {
          getSandbox: (() => sandboxEntry) as never,
          reconcile: async () => presentLookup,
          // Upstream provider reachability is healthy on its own; the broken
          // in-sandbox route must still be surfaced.
          probeProviderHealthImpl: (provider: string) =>
            provider === "unknown" ? null : reachableCloudHealth,
        },
      }),
  };
}

describe("collectSandboxStatusSnapshot inference.local subprobe (#6192)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve(snapshotModulePath)];
  });

  it("probes the inference.local route for a cloud provider and reports it broken", async () => {
    const harness = createSnapshotHarness({
      provider: "nvidia-prod",
      inferenceOutput: "Provider: nvidia-prod\nModel: nemotron\n",
    });

    const snapshot = await harness.run();

    // Before #6192 the gateway chain was probed only for ollama/vllm-local, so
    // a cloud route never had inference.local checked.
    expect(harness.probeSandboxInferenceGatewayHealthSpy).toHaveBeenCalledWith("alpha");
    expect(snapshot.currentProvider).toBe("nvidia-prod");
    expect(snapshot.inferenceHealth?.ok).toBe(true);
    expect(snapshot.inferenceHealth?.subprobes).toEqual([
      expect.objectContaining({
        providerLabel: "Inference gateway chain",
        probeLabel: "gateway",
        ok: false,
      }),
    ]);
  });

  it("skips the inference.local subprobe when the provider is unknown", async () => {
    const harness = createSnapshotHarness({
      provider: null,
      inferenceOutput: "",
    });

    const snapshot = await harness.run();

    expect(snapshot.currentProvider).toBe("unknown");
    expect(harness.probeSandboxInferenceGatewayHealthSpy).not.toHaveBeenCalled();
  });
});
