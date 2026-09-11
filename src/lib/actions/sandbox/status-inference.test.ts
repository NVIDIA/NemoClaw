// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildSandboxInferenceInvocationCommand } from "./inference-invocation-probe";
import {
  collectSandboxStatusSnapshot,
  getSandboxStatusInferenceHealth,
  getSandboxStatusReport,
  type SandboxStatusPreflightResult,
} from "./status";

describe("sandbox status inference.local route health (#6192)", () => {
  function snapshotDeps(options: {
    agent?: string;
    confirmedStopped?: boolean;
    stopped?: boolean;
    lookupState?: "present" | "missing";
    lookupPhase?: "Ready" | "Running";
    provider?: string;
    liveProvider?: string;
    liveModel?: string;
    preferredInferenceApi?: string;
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
    let sandbox = {
      name: "alpha",
      agent: options.agent ?? "openclaw",
      model: "nvidia/nemotron",
      provider,
      preferredInferenceApi: options.preferredInferenceApi,
      ...(options.stopped !== undefined ? { stopped: options.stopped } : {}),
    };
    return {
      getSandbox: () => sandbox,
      listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: "alpha" }),
      updateSandbox: vi.fn((_name: string, updates: { stopped?: boolean }) => {
        sandbox = { ...sandbox, ...updates };
        return true;
      }),
      reconcile: vi.fn(async () =>
        options.lookupState === "missing"
          ? { state: "missing" as const, output: "sandbox alpha not found" }
          : {
              state: "present" as const,
              phase: options.lookupPhase ?? "Ready",
              output: `Name: alpha\nPhase: ${options.lookupPhase ?? "Ready"}\n`,
            },
      ),
      captureOpenshellForStatusImpl: vi.fn(
        async () =>
          ({
            status: 0,
            output: `Gateway inference:\n  Provider: ${options.liveProvider ?? provider}\n  Model: ${options.liveModel ?? "nvidia/nemotron"}\n`,
          }) as never,
      ),
      getSandboxStatusPreflightImpl: vi.fn(async (): Promise<SandboxStatusPreflightResult> => ({
        failure: null,
        failureLayer: null,
        intentionalStopConfirmed: options.confirmedStopped === true,
        suppressInferenceProbe: options.confirmedStopped === true,
        exitCode: 0,
      })),
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
      probeSandboxInferenceInvocationImpl: vi.fn(
        async (_input: Parameters<typeof buildSandboxInferenceInvocationCommand>[0]) =>
          ({ ok: true }) as const,
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

  it("does not probe terminal runtime health when the sandbox is stopped (#11025)", async () => {
    const deps = snapshotDeps({
      agent: "langchain-deepagents-code",
      confirmedStopped: true,
      stopped: true,
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.terminalRuntimeHealth).toBeNull();
    expect(deps.probeTerminalRuntimeHealth).not.toHaveBeenCalled();
    expect(deps.probeProviderHealthImpl).not.toHaveBeenCalled();
    expect(deps.probeSandboxInferenceGatewayHealthImpl).not.toHaveBeenCalled();
  });

  it("reports a missing provider-confirmed intentional stop as Stopped (#11025)", async () => {
    const deps = snapshotDeps({
      confirmedStopped: true,
      stopped: true,
      lookupState: "missing",
      routeHealth: null,
    });

    const report = await getSandboxStatusReport("alpha", deps);

    expect(report.phase).toBe("Stopped");
    expect(report.failureLayer).toBeNull();
    expect(report.inferenceHealth).toBeNull();
    expect(deps.captureOpenshellForStatusImpl).not.toHaveBeenCalled();
    expect(deps.probeProviderHealthImpl).not.toHaveBeenCalled();
    expect(deps.probeSandboxInferenceGatewayHealthImpl).not.toHaveBeenCalled();
  });

  it("revokes a stale stop marker observed Running before a later unexpected stop (#11025)", async () => {
    const deps = snapshotDeps({
      stopped: true,
      lookupPhase: "Running",
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });

    const running = await getSandboxStatusReport("alpha", deps);

    expect(running.phase).toBe("Running");
    expect(deps.updateSandbox).toHaveBeenCalledWith("alpha", { stopped: false });
    expect(deps.probeSandboxInferenceGatewayHealthImpl).toHaveBeenCalled();

    deps.getSandboxStatusPreflightImpl.mockResolvedValue({
      failure: { layer: "sandbox_container_stopped", dockerUnreachable: false },
      failureLayer: "sandbox_container_stopped",
      intentionalStopConfirmed: false,
      suppressInferenceProbe: true,
      exitCode: 1,
    });
    deps.reconcile.mockResolvedValue({ state: "missing", output: "sandbox alpha not found" });

    const stopped = await getSandboxStatusReport("alpha", deps);

    expect(stopped.failureLayer).toBe("sandbox_container_stopped");
    expect(stopped.gatewayState).toBe("missing");
    expect(stopped.inferenceHealth).toBeNull();
  });

  it("reports a running sandbox whose stale stop marker cannot be revoked (#11025)", async () => {
    const deps = snapshotDeps({
      stopped: true,
      routeHealth: null,
    });
    deps.updateSandbox.mockReturnValue(false);

    const report = await getSandboxStatusReport("alpha", deps);

    expect(report.gatewayState).toBe("stop_intent_update_failed");
    expect(report.inferenceHealth).toBeNull();
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

  it.each(["nvidia-router", "hermes-provider"])(
    "probes inference.local for %s without a direct health probe (#6192)",
    async (provider) => {
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

      expect(deps.probeSandboxInferenceGatewayHealthImpl).toHaveBeenCalledWith("alpha", {
        gatewayName: "nemoclaw",
      });
      expect(snapshot.inferenceHealth).toMatchObject({ ok: true, probed: true });
    },
  );

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
    expect(snapshot.inferenceHealth?.subprobes).toContainEqual(
      expect.objectContaining({ ok: false, probeLabel: "upstream" }),
    );
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

  it("does not apply the recorded API family to a different live route", async () => {
    const deps = snapshotDeps({
      provider: "compatible-endpoint",
      preferredInferenceApi: "openai-responses",
      liveProvider: "openai-api",
      liveModel: "gpt-5.2",
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });
    deps.probeSandboxInferenceInvocationImpl.mockImplementation(async (input) => {
      const command = buildSandboxInferenceInvocationCommand(input);
      expect(command).toContain("https://inference.local/v1/chat/completions");
      expect(command).not.toContain("https://inference.local/v1/responses");
      return { ok: true };
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.inferenceHealth).toMatchObject({ ok: true, probed: true });
    expect(deps.probeSandboxInferenceInvocationImpl).toHaveBeenCalledWith(
      {
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        provider: "openai-api",
        model: "gpt-5.2",
        preferredInferenceApi: null,
      },
      {},
      95_000,
    );
  });

  it("preserves the recorded Responses API for an unchanged live route (#8731)", async () => {
    const deps = snapshotDeps({
      provider: "compatible-endpoint",
      preferredInferenceApi: "openai-responses",
      liveProvider: "compatible-endpoint",
      liveModel: "nvidia/nemotron",
      routeHealth: {
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "route reachable",
      },
    });
    deps.probeSandboxInferenceInvocationImpl.mockImplementation(async (input) => {
      const command = buildSandboxInferenceInvocationCommand(input);
      expect(command).toContain("https://inference.local/v1/responses");
      expect(command).not.toContain("https://inference.local/v1/chat/completions");
      return { ok: true };
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", { deps });

    expect(snapshot.inferenceHealth).toMatchObject({ ok: true, probed: true });
    expect(deps.probeSandboxInferenceInvocationImpl).toHaveBeenCalledWith(
      {
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        provider: "compatible-endpoint",
        model: "nvidia/nemotron",
        preferredInferenceApi: "openai-responses",
      },
      {},
      95_000,
    );
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
    expect(snapshot.inferenceHealth?.subprobes).toContainEqual(
      expect.objectContaining({
        ok: false,
        probed: false,
        probeLabel: "upstream",
        detail: "Direct provider health probe could not run.",
      }),
    );
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
      "route reachability",
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
