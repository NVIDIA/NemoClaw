// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  collectSandboxStatusSnapshot,
  getSandboxStatusInferenceHealth,
  getSandboxStatusReport,
} from "./status";

describe("sandbox status inference.local route health (#6192)", () => {
  function snapshotDeps(options: {
    agent?: string;
    lookupState?: "present" | "missing";
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
      agent: options.agent ?? "openclaw",
      model: "nvidia/nemotron",
      provider,
    };
    return {
      getSandbox: () => sandbox,
      listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: "alpha" }),
      reconcile: async () =>
        options.lookupState === "missing"
          ? { state: "missing" as const, output: "sandbox alpha not found" }
          : { state: "present" as const, output: "Name: alpha\nPhase: Ready\n" },
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
      probeTerminalRuntimeHealth: vi.fn(() => ({ kind: "ok" as const, oomKillCount: 0 as const })),
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
    expect(snapshot.servingProcessHealth).toEqual({ checked: false });

    const report = await getSandboxStatusReport("alpha", deps);
    expect(report.servingProcessHealth).toEqual({ checked: false });
  });

  it("does not invent serving-process health for terminal agents (#7003)", async () => {
    const deps = snapshotDeps({
      agent: "langchain-deepagents-code",
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.servingProcessHealth).toBeNull();
    expect(deps.probeTerminalRuntimeHealth).toHaveBeenCalledWith("alpha");

    const report = await getSandboxStatusReport("alpha", deps);
    expect(report.servingProcessHealth).toBeNull();
  });

  it("does not invent serving-process health when the gateway is unavailable (#7003)", async () => {
    const deps = snapshotDeps({
      lookupState: "missing",
      routeHealth: null,
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.servingProcessHealth).toBeNull();
    expect(deps.probeSandboxInferenceGatewayHealthImpl).not.toHaveBeenCalled();

    const report = await getSandboxStatusReport("alpha", deps);
    expect(report.servingProcessHealth).toBeNull();
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
