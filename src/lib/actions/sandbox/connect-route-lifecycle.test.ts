// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("connectSandbox route lifecycle", () => {
  let exitSpy: MockInstance;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("skips the vLLM model preflight only for probe-only connects (#4585)", async () => {
    const harness = createConnectHarness();

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();
    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();
    expect(harness.preflightVllmSpy).not.toHaveBeenCalled();

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");
    expect(harness.preflightVllmSpy).toHaveBeenCalledOnce();
  });

  it("warns and aligns a diverged route during a quiet probe-only connect (#3726)", async () => {
    const harness = createConnectHarness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      registryEntry: {
        model: "claude-sonnet-4-20250514",
        provider: "anthropic-prod",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("differs from the recorded route");
    expect(errorOutput).toContain(
      "Aligning the gateway to anthropic-prod/claude-sonnet-4-20250514",
    );
    expect(errorOutput).toContain(
      "nemoclaw inference set --provider 'nvidia-prod' --model 'nvidia/nemotron-3-super-120b-a12b' --sandbox 'alpha'",
    );
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
  });

  it("shell-quotes hostile route values in drift recovery commands (#3726)", async () => {
    const sandboxName = "alpha's box";
    const harness = createConnectHarness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: openai; touch /tmp/pwn\n  Model: $(id) model\n",
      registryEntry: {
        name: sandboxName,
        model: "claude-sonnet-4-20250514",
        provider: "anthropic-prod",
      },
    });

    await expect(harness.connectSandbox(sandboxName, { probeOnly: true })).resolves.toBeUndefined();

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "nemoclaw inference set --provider 'openai; touch /tmp/pwn' --model '$(id) model' --sandbox 'alpha'\\''s box'",
    );
  });

  it("wires the forced VM DNS monkeypatch into connect route repair", async () => {
    vi.stubEnv("NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH", "1");
    try {
      const harness = createConnectHarness({
        inferenceGetOutput:
          "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
        inferenceProbeResponses: ['BROKEN 503 {"error":"inference service unavailable"}', "OK 200"],
        registryEntry: {
          model: "nvidia/nemotron-3-super-120b-a12b",
          openshellDriver: "vm",
          provider: "nvidia-prod",
        },
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

      expect(harness.applyVmDnsMonkeypatchSpy).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ openshellDriver: "vm" }),
      );
      expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
      const routeProbeCalls = harness.captureOpenshellSpy.mock.calls.filter((call) =>
        JSON.stringify(call[0]).includes("inference.local/v1/models"),
      );
      expect(routeProbeCalls).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["null", null, null],
    ["provider-only", "nvidia-prod", null],
    ["model-only", null, "nvidia/test"],
    ["blank-provider", "   ", "nvidia/test"],
    ["blank-model", "nvidia-prod", "   "],
  ] as const)("skips inference reconciliation for %s registry entries (#5937)", async (_description, provider, model) => {
    const harness = createConnectHarness({ registryEntry: { model, provider } });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).not.toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.any(Object),
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
  });

  it("does not reset an inference route that already matches the sandbox", async () => {
    const harness = createConnectHarness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      registryEntry: {
        model: "nvidia/nemotron-3-super-120b-a12b",
        provider: "nvidia-prod",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
  });

  it("does not claim repair ran when route inspection fails before repair (#6192)", async () => {
    const harness = createConnectHarness({
      registryEntry: {
        model: "nvidia/nemotron-3-super-120b-a12b",
        provider: "nvidia-prod",
      },
    });
    harness.captureOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: "alpha Ready" })
      .mockImplementationOnce(() => {
        throw new Error("gateway inference read failed");
      });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("failed to verify or repair inference route");
    expect(errorOutput).toContain("did not return a trusted result");
    expect(errorOutput).toContain("route is not known healthy");
    expect(errorOutput).not.toContain("after DNS and route repair");
    expect(errorOutput).not.toContain("route is known to be broken");
    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("stops before opening SSH when route repair and reset both fail", async () => {
    const harness = createConnectHarness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      inferenceProbeResponses: Array(7).fill('BROKEN 503 {"error":"upstream unavailable"}'),
      registryEntry: {
        model: "nvidia/nemotron-3-super-120b-a12b",
        openshellDriver: "kubernetes",
        provider: "nvidia-prod",
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(harness.runSetupDnsProxySpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
        "--no-verify",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("inference.local is still unavailable");
    expect(errorOutput).toContain(
      "Connect is stopping because the sandbox inference route is known to be broken",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
