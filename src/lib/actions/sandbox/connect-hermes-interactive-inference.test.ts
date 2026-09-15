// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

const originalIsTTY = process.stdout.isTTY;
const inferenceAdapter = requireDist(
  "../../src/lib/actions/sandbox/probe/hermes-portable-inference-recovery.js",
) as typeof import("./probe/hermes-portable-inference-recovery");
const realConnectRecovery = inferenceAdapter.recoverHermesPortableInferenceForConnect;
const inferenceEngine = requireDist(
  "../../src/lib/onboard/experimental/hermes-portable-ollama-inference.js",
) as typeof import("../../onboard/experimental/hermes-portable-ollama-inference");
const forwardRecovery = requireDist(
  "../../src/lib/actions/sandbox/probe/hermes-portable-forward-adapter-recovery.js",
) as typeof import("./probe/hermes-portable-forward-adapter-recovery");
function harness(options: Parameters<typeof createConnectHarness>[0] = {}) {
  return createConnectHarness({
    agentName: "hermes",
    sessionAgent: { name: "hermes" },
    registryEntry: {
      provider: "ollama-local",
      model: "qwen3-vl:4b",
      openshellDriver: "docker",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
    },
    portableReceiptDisposition: { kind: "hermes", phase: "active" },
    portableRecoveryResult: { kind: "already-running" },
    ...options,
  });
}
function prepare() {
  const connect = requireDist(connectModulePath) as typeof import("./connect");
  return connect.prepareInteractiveSession("alpha");
}

describe("Hermes Portable interactive inference recovery", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("recovers the managed route before preparing an interactive session (#11757)", async () => {
    const h = harness({ inferenceProbeResponses: ["BROKEN 503", "OK 200"] });
    h.recoverHermesPortableOllamaInferenceSpy.mockImplementation(realConnectRecovery);
    const engine = vi
      .spyOn(inferenceEngine, "recoverHermesPortableOllamaInference")
      .mockImplementation(async (input) => {
        await input.verifyRoute();
        (await input.prepareProbeDependency?.())?.release();
        return "recovered";
      });
    const prepareForwards = vi.spyOn(forwardRecovery, "prepareHermesPortableLaunchForwards");
    await expect(prepare()).resolves.toMatchObject({
      hermesPortable: true,
      sb: { provider: "ollama-local", model: "qwen3-vl:4b" },
    });
    expect(h.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
    expect(h.ensureOllamaAuthProxySpy).not.toHaveBeenCalled();
    expect(engine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        intent: "connect-interactive",
        sandboxName: "alpha",
        entry: expect.objectContaining({
          gatewayName: "nemoclaw",
          lifecycleGeneration: "generation-1",
          provider: "ollama-local",
          model: "qwen3-vl:4b",
        }),
      }),
    );
    expect(prepareForwards).toHaveBeenCalledOnce();
  });

  it("keeps healthy interactive inference on verification without recovery (#11757)", async () => {
    const h = harness({ inferenceProbeResponses: ["OK 200"] });
    const prepareForwards = vi.spyOn(forwardRecovery, "prepareHermesPortableLaunchForwards");
    await expect(prepare()).resolves.toMatchObject({ hermesPortable: true });
    expect(h.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(prepareForwards).toHaveBeenCalledOnce();
  });

  it.each([
    "authority-drift",
    "runtime-restoration-unproved",
    "registry-restoration-unproved",
    "recovery-failed",
  ] as const)(
    "refuses interactive handoff after %s during inference recovery (#11757)",
    async (hermesInferenceRecoveryFailure) => {
      const h = harness({
        inferenceProbeResponses: ["BROKEN 503"],
        hermesInferenceRecoveryFailure,
      });
      await expect(prepare()).rejects.toThrow("process.exit(1)");
      expect(h.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
      expect(h.errorSpy.mock.calls.flat().join("\n")).toContain(
        "Hermes Portable inference recovery",
      );
      expect(h.errorSpy.mock.calls.flat().join("\n")).toContain("nemoclaw alpha doctor");
      expect(h.errorSpy.mock.calls.flat().join("\n")).not.toContain(
        "nested recovery diagnostic canary",
      );
    },
  );

  it("rejects a mismatched recorded route without starting recovery (#11757)", async () => {
    const h = harness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: ollama-local\n  Model: different-model\n",
    });
    await expect(prepare()).rejects.toThrow("process.exit(1)");
    expect(h.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
  });

  it("keeps unavailable external providers outside managed Ollama recovery (#11757)", async () => {
    const h = harness({
      registryEntry: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      },
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      inferenceProbeResponses: ["BROKEN 503"],
    });
    await expect(prepare()).rejects.toThrow("process.exit(1)");
    expect(h.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
  });

  it("rejects receipt generation drift during the failed route probe before recovery (#11757)", async () => {
    const h = harness();
    h.sandboxRunBufferedSpy.mockImplementation(async () => {
      h.registryEntries[0]!.lifecycleGeneration = "replacement-generation";
      return { outcome: { kind: "completed", exitCode: 0 }, stdout: "BROKEN 503", stderr: "" };
    });
    await expect(prepare()).rejects.toThrow("process.exit(1)");
    expect(h.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(h.forwardAdapterStartSpy).not.toHaveBeenCalled();
  });

  it("refuses handoff when the recovered inference route remains unhealthy (#11757)", async () => {
    const h = harness({ inferenceProbeResponses: ["BROKEN 503", "BROKEN 503"] });
    await expect(prepare()).rejects.toThrow("process.exit(1)");
    expect(h.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
    expect(h.forwardAdapterStartSpy).not.toHaveBeenCalled();
  });

  it("preserves the probe-only intent for the probe consumer (#11757)", async () => {
    const h = harness({ inferenceProbeResponses: ["OK 200"] });
    await h.connectSandbox("alpha", { probeOnly: true });
    expect(h.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "connect-probe-only" }),
    );
  });

  it("refuses interactive handoff when the real recovery adapter's engine fails (#11757)", async () => {
    const h = harness({ inferenceProbeResponses: ["BROKEN 503"] });
    h.recoverHermesPortableOllamaInferenceSpy.mockImplementation(realConnectRecovery);
    const engine = vi
      .spyOn(inferenceEngine, "recoverHermesPortableOllamaInference")
      .mockRejectedValue(new Error("engine failure canary"));
    const prepareForwards = vi.spyOn(forwardRecovery, "prepareHermesPortableLaunchForwards");
    await expect(prepare()).rejects.toThrow("process.exit(1)");
    expect(engine).toHaveBeenCalledOnce();
    expect(prepareForwards).not.toHaveBeenCalled();
    expect(h.errorSpy.mock.calls.flat().join("\n")).not.toContain("engine failure canary");
  });
});
