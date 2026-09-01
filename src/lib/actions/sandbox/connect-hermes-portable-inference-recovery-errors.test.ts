// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("Hermes Portable connect recovery errors", () => {
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
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

  it("retains the route-unavailable retry boundary (#10423)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      inferenceProbeResponses: ["BROKEN 503"],
      registryEntry: {
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain(
      "is unreachable. Resume the existing portable onboarding transaction or run `nemoclaw alpha doctor` before retrying",
    );
    expect(output).not.toContain("Hermes Portable inference recovery for 'alpha' failed");
  });

  it("carries current schema-6 authority through compatible-endpoint recovery", async () => {
    const entry = {
      name: "alpha",
      agent: "hermes",
      provider: "compatible-endpoint",
      model: "descriptor/model",
      endpointUrl: "https://example.test/v1/chat/completions",
      preferredInferenceApi: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
      policies: [],
      openshellDriver: "docker",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
    } as never;
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: entry,
      inferenceGetOutput:
        "Gateway inference:\n  Provider: compatible-endpoint\n  Model: descriptor/model\n",
      inferenceProbeResponses: ["OK 200"],
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.registryEntries[0]?.hostLocalInferenceReceipt).toBeUndefined();
    expect(harness.requalifyPortableAgentAuthoritySpy).not.toHaveBeenCalled();
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.captureResolvedOpenshellSpy).toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.objectContaining({ openshellBinary: "/usr/bin/openshell" }),
    );
    expect(
      harness.captureResolvedOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
      ),
    ).toBe(true);
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "authority drift",
      "authority-drift",
      "Recorded managed inference authority changed during recovery",
    ],
    [
      "runtime restoration uncertainty",
      "runtime-restoration-unproved",
      "could not prove restoration of the exact stopped managed inference runtime",
    ],
    [
      "registry restoration uncertainty",
      "registry-restoration-unproved",
      "could not prove restoration of the exact stopped Portable registry",
    ],
    [
      "an unclassified recovery failure",
      "recovery-failed",
      "Managed inference recovery stopped without a verified result",
    ],
  ] as const)(
    "preserves the fixed %s class at the connect boundary (#10423)",
    async (_label, hermesInferenceRecoveryFailure, expectedDetail) => {
      const harness = createConnectHarness({
        agentName: "hermes",
        sessionAgent: { name: "hermes" },
        hermesInferenceRecoveryFailure,
        registryEntry: {
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "generation-1",
        },
        portableReceiptDisposition: { kind: "hermes", phase: "active" },
        portableRecoveryResult: { kind: "already-running" },
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );
      const output = harness.errorSpy.mock.calls.flat().join("\n");
      expect(output).toContain("Hermes Portable inference recovery for 'alpha' failed");
      expect(output).toContain(expectedDetail);
      expect(output).toContain("Do not run another probe or launch");
      expect(output).not.toContain("nested recovery diagnostic canary");
      expect(output).not.toContain("before retrying");
      expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "REGISTRY_PREPARATION_AUTHORITY",
    "REGISTRY_PREPARATION_START_DISPATCH",
    "REGISTRY_PREPARATION_SETTLEMENT_CURRENTNESS",
    "REGISTRY_PREPARATION_NETWORK_INSPECTION",
    "REGISTRY_PREPARATION_PINNED_REGISTRY_INSPECTION",
    "REGISTRY_PREPARATION_PENDING_DEADLINE",
    "REGISTRY_PREPARATION_POSTCONDITION",
    "RUNTIME_AUTHORITY",
    "LIFECYCLE_AUTHORITY",
    "PRIVATE_PUBLICATION_AUTHORITY",
    "EXACT_RUNTIME_INSPECTION",
  ] as const)("prints only the fixed %s recovery boundary (#10423)", async (phase) => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      hermesInferenceRecoveryPhase: phase,
      registryEntry: {
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain(`Managed inference recovery stopped at boundary ${phase}`);
    expect(output).toContain("Do not run another probe or launch");
    expect(output).not.toContain("nested recovery diagnostic canary");
    expect(output).not.toContain("before retrying");
    expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
  });
});
