// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { collectSandboxStatusSnapshot, getSandboxStatusInferenceHealth } from "./status";

describe("sandbox status inference.local route health (#6192)", () => {
  function snapshotDeps(options: {
    provider?: string;
    liveProvider?: string;
    liveModel?: string;
    providerHealth?: ReturnType<typeof getSandboxStatusInferenceHealth>;
    providerProbeThrows?: boolean;
    routeHealth: {
      ok: boolean;
      endpoint: string;
      httpStatus: number;
      detail: string;
    } | null;
    routeProbeThrows?: boolean;
  }) {
    const provider = options.provider ?? "nvidia-prod";
    const reportInferenceProbeError = vi.fn();
    const sandbox = {
      name: "alpha",
      agent: "openclaw",
      model: "nvidia/nemotron",
      provider,
    };
    return {
      getSandbox: () => sandbox,
      listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: "alpha" }),
      reconcile: async () => ({
        state: "present" as const,
        output: "Name: alpha\nPhase: Ready\n",
      }),
      captureOpenshellForStatusImpl: async () =>
        ({
          status: 0,
          output: `Gateway inference:\n  Provider: ${options.liveProvider ?? provider}\n  Model: ${options.liveModel ?? "nvidia/nemotron"}\n`,
        }) as never,
      probeProviderHealthImpl: vi.fn(
        options.providerProbeThrows
          ? () => {
              throw new Error("upstream probe crashed");
            }
          : () => options.providerHealth ?? null,
      ),
      probeSandboxInferenceGatewayHealthImpl: vi.fn(
        options.routeProbeThrows
          ? async () => Promise.reject(new Error("openshell unavailable TOKEN=super-secret"))
          : async () => options.routeHealth,
      ),
      reportInferenceProbeError,
    };
  }

  it("makes a broken inference.local route authoritative over a healthy upstream", async () => {
    const deps = snapshotDeps({
      providerHealth: {
        ok: true,
        probed: true,
        providerLabel: "NVIDIA Endpoints",
        endpoint: "https://integrate.api.nvidia.com/v1/models",
        detail: "upstream reachable",
      },
      routeHealth: {
        ok: false,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 0,
        detail: "inference.local unreachable",
      },
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.inferenceHealth).toMatchObject({
      ok: false,
      probed: true,
      endpoint: "https://inference.local/v1/models",
      failureLabel: "unreachable",
    });
    expect(snapshot.inferenceHealth?.subprobes).toEqual([
      expect.objectContaining({ ok: true, probeLabel: "upstream" }),
    ]);
  });

  it.each([
    "nvidia-router",
    "hermes-provider",
  ])("probes inference.local for %s without a direct health probe (#6192)", async (provider) => {
    const deps = snapshotDeps({
      provider,
      providerHealth: null,
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(deps.probeSandboxInferenceGatewayHealthImpl).toHaveBeenCalledWith("alpha");
    expect(snapshot.inferenceHealth).toMatchObject({ ok: true, probed: true });
  });

  it("keeps an upstream failure diagnostic when inference.local is healthy (#6192)", async () => {
    const deps = snapshotDeps({
      providerHealth: {
        ok: false,
        probed: true,
        providerLabel: "NVIDIA Endpoints",
        endpoint: "https://integrate.api.nvidia.com/v1/models",
        detail: "host-side upstream probe failed",
        failureLabel: "unreachable",
      },
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.inferenceHealth).toMatchObject({ ok: true, probed: true });
    expect(snapshot.inferenceHealth?.subprobes).toEqual([
      expect.objectContaining({ ok: false, probeLabel: "upstream" }),
    ]);
  });

  it("probes the live route while status displays the sandbox's recorded route (#6315)", async () => {
    const deps = snapshotDeps({
      provider: "nvidia-prod",
      liveProvider: "openai-api",
      liveModel: "gpt-5.2",
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.currentProvider).toBe("nvidia-prod");
    expect(snapshot.currentModel).toBe("nvidia/nemotron");
    expect(snapshot.routeDrift).toEqual({
      live: { provider: "openai-api", model: "gpt-5.2" },
      recorded: { provider: "nvidia-prod", model: "nvidia/nemotron" },
      canConnect: true,
    });
    expect(deps.probeProviderHealthImpl).toHaveBeenCalledWith("openai-api", {
      model: "gpt-5.2",
    });
  });

  it("keeps inference.local authoritative when the upstream diagnostic throws (#6192)", async () => {
    const deps = snapshotDeps({
      providerProbeThrows: true,
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.inferenceHealth).toMatchObject({ ok: true, probed: true });
    expect(snapshot.inferenceHealth?.subprobes).toEqual([
      expect.objectContaining({
        ok: false,
        probed: false,
        probeLabel: "upstream",
        detail: "Direct provider health probe could not run.",
      }),
    ]);
  });

  it("preserves local backend and auth-proxy diagnostics beneath the route result", async () => {
    const deps = snapshotDeps({
      provider: "ollama-local",
      providerHealth: {
        ok: true,
        probed: true,
        providerLabel: "Ollama",
        endpoint: "http://127.0.0.1:11434/api/tags",
        detail: "backend reachable",
        probeLabel: "ollama backend",
        subprobes: [
          {
            ok: true,
            probed: true,
            providerLabel: "Ollama auth proxy",
            endpoint: "http://127.0.0.1:11435/v1/models",
            detail: "proxy reachable",
            probeLabel: "auth proxy",
          },
        ],
      },
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.inferenceHealth?.subprobes?.map((probe) => probe.probeLabel)).toEqual([
      "ollama backend",
      "auth proxy",
    ]);
  });

  it("fails closed when the in-sandbox route probe returns no trusted result (#6192)", async () => {
    const deps = snapshotDeps({
      providerHealth: {
        ok: true,
        probed: true,
        providerLabel: "NVIDIA Endpoints",
        endpoint: "https://integrate.api.nvidia.com/v1/models",
        detail: "upstream reachable",
      },
      routeHealth: null,
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.inferenceHealth).toMatchObject({
      ok: false,
      probed: false,
      endpoint: "https://inference.local/v1/models",
    });
    expect(deps.reportInferenceProbeError).not.toHaveBeenCalled();
  });

  it("fails closed and redacts a thrown in-sandbox route probe error (#6192)", async () => {
    const deps = snapshotDeps({
      providerHealth: {
        ok: true,
        probed: true,
        providerLabel: "NVIDIA Endpoints",
        endpoint: "https://integrate.api.nvidia.com/v1/models",
        detail: "upstream reachable",
      },
      routeHealth: null,
      routeProbeThrows: true,
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.inferenceHealth).toMatchObject({
      ok: false,
      probed: false,
      endpoint: "https://inference.local/v1/models",
    });
    expect(deps.reportInferenceProbeError).toHaveBeenCalledWith(
      expect.stringContaining("openshell unavailable"),
    );
    expect(deps.reportInferenceProbeError).not.toHaveBeenCalledWith(
      expect.stringContaining("super-secret"),
    );
  });
});
