// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleProviderInferenceState } from "../../src/lib/onboard/machine/handlers/provider-inference";
import {
  baseOptions,
  baseSelection,
  createDeps,
} from "../../src/lib/onboard/machine/handlers/provider-inference.test-support";
import { nativeLocalSetupReceipt } from "../support/native-local-setup-harness";
import { createDirectSetupInferenceHarness } from "../helpers/onboard-split-context";

// Abandoned-reservation recovery has its own state tests. Keep this harness from
// reading the developer's registry through the CommonJS onboarding boundary.
const require = createRequire(import.meta.url);
beforeEach(() => {
  vi.spyOn(
    require("../../src/lib/onboard/sandbox-lifecycle.ts"),
    "releaseAbandonedRouteReservation",
  ).mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe("native provider ownership before route reservation", () => {
  it.each(["langchain-deepagents-code", "pi"])(
    "selects the recorded %s route only while holding the sandbox mutation lock (#13197)",
    async (agent) => {
      let locked = false;
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          applyLocalInferenceRoute: undefined,
          getSandbox: () => {
            expect(locked).toBe(true);
            return {
              name: "test-box",
              agent,
              pendingRouteReservation: true,
            };
          },
          withSandboxMutationLock: async (_name, operation) => {
            locked = true;
            try {
              return await operation();
            } finally {
              locked = false;
            }
          },
        },
      });
      await expect(harness.setupInference("test-box", "meta-llama", "vllm-local")).resolves.toEqual(
        {
          ok: true,
        },
      );
      expect(harness.native.adapter.createProvider).toHaveBeenCalledOnce();
      expect([...harness.native.authorities.values()][0]?.agent).toBe(
        agent === "pi" ? "pi" : undefined,
      );
      expect(harness.commands.some(({ command }) => command.startsWith("inference set"))).toBe(
        false,
      );
    },
  );

  it("retires an unreserved provider after host smoke fails (#12558)", async () => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        verifyOnboardInferenceSmoke: async () => {
          throw new Error("host smoke refused");
        },
      },
    });
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "langchain-deepagents-code",
      }),
    ).rejects.toThrow("host smoke refused");
    expect(harness.native.adapter.createProvider).toHaveBeenCalledOnce();
    expect(harness.updateSandbox).not.toHaveBeenCalled();
    expect(harness.native.providers.size).toBe(0);
    expect(harness.native.authorities.size).toBe(0);
  });
});

describe("native provider cleanup uncertainty", () => {
  it("retains authority when deletion cannot be confirmed (#12558)", async () => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        verifyOnboardInferenceSmoke: async () => {
          throw new Error("host smoke refused");
        },
      },
    });
    harness.native.adapter.deleteProvider.mockResolvedValue({
      ok: false,
      error: { kind: "transport", reason: "connection_loss", message: "delete outcome unknown" },
    });
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "langchain-deepagents-code",
      }),
    ).rejects.toThrow(/host smoke refused[\s\S]*cleanup was not confirmed/);
    expect(harness.native.providers.size).toBe(1);
    expect(harness.native.authorities.size).toBe(1);
  });

  it("retains authority after a failed reservation response (#12558)", async () => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        updateSandbox: () => {
          throw new Error("reservation response lost");
        },
      },
    });
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "langchain-deepagents-code",
      }),
    ).rejects.toThrow("reservation response lost");
    expect(harness.native.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(harness.native.providers.size).toBe(1);
    expect(harness.native.authorities.size).toBe(1);
  });

  it("keeps an existing selected provider after a pre-reservation failure (#12558)", async () => {
    const existing = nativeLocalSetupReceipt({
      provider: "vllm-local",
      sandboxName: "test-box",
      gatewayName: "nemoclaw",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      authMode: "sentinel",
    });
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        getSandbox: () => ({
          name: "test-box",
          provider: "vllm-local",
          nativeLocalProviderAttachment: existing,
        }),
        verifyOnboardInferenceSmoke: async () => {
          throw new Error("host smoke refused");
        },
      },
    });
    harness.native.seed(existing);
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "langchain-deepagents-code",
      }),
    ).rejects.toThrow("host smoke refused");
    expect(harness.native.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(harness.native.providers.size).toBe(1);
    expect(harness.native.authorities.size).toBe(1);
  });
});

function legacyRecreationHarness(
  previousProvider = "vllm-local",
  agent = "langchain-deepagents-code",
) {
  const row = {
    name: "legacy-native",
    agent,
    provider: previousProvider,
    model: previousProvider === "ollama-local" ? "old-model" : "meta-llama",
    endpointUrl:
      previousProvider === "ollama-local" ? null : "http://host.openshell.internal:8000/v1",
    gatewayName: "nemoclaw",
  };
  const before = structuredClone(row);
  const unloadOllamaModels = vi.fn(() => undefined);
  const harness = createDirectSetupInferenceHarness({
    overrides: {
      unloadOllamaModels,
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      getSandbox: () => row,
      isNonInteractive: () => true,
      applyLocalInferenceRoute: undefined,
    },
  });
  const { deps } = createDeps({
    setupNim: vi.fn(async () => ({
      ...baseSelection,
      provider: "vllm-local",
      model: "meta-llama",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    })),
    setupInference: harness.setupInference,
    getSandboxRegistryEntry: () => row,
    hasSandboxLifecycleAuthority: () => true,
  });
  const run = (recreateSandbox: boolean) =>
    handleProviderInferenceState({
      ...baseOptions(deps),
      fresh: true,
      recreateSandbox,
      sandboxName: row.name,
      agent: { name: row.agent, inference: { provider_type: "openai_compatible" } },
    });
  return { row, before, harness, unloadOllamaModels, run };
}

describe("legacy native-local recreation", () => {
  it("rejects legacy DCode setup without explicit recreation (#13197)", async () => {
    const { row, before, harness, run } = legacyRecreationHarness();
    await expect(run(false)).rejects.toThrow(
      "Recreate this beta sandbox before using native local inference.",
    );
    expect(harness.native.adapter.createProvider).not.toHaveBeenCalled();
    expect(harness.updateSandbox).not.toHaveBeenCalled();
    expect(row).toEqual(before);
  });

  it.each([
    ["vllm-local", "langchain-deepagents-code"],
    ["ollama-local", "langchain-deepagents-code"],
    ["vllm-local", "pi"],
    ["ollama-local", "pi"],
  ])(
    "stages legacy %s for %s without changing its published source (#13197)",
    async (previousProvider, agent) => {
      const { row, before, harness, unloadOllamaModels, run } = legacyRecreationHarness(
        previousProvider,
        agent,
      );
      const result = await run(true);
      expect(result.stagedNativeLocalRecreation).toEqual({
        source: before,
        attachment: expect.objectContaining({
          sandboxName: row.name,
          gatewayName: "nemoclaw",
          provider: "vllm-local",
        }),
      });
      expect(harness.native.adapter.createProvider).toHaveBeenCalledOnce();
      expect(harness.updateSandbox).not.toHaveBeenCalled();
      expect(row).toEqual(before);
      expect(unloadOllamaModels).not.toHaveBeenCalled();
      expect(harness.commands.some(({ command }) => command.startsWith("inference set"))).toBe(
        false,
      );
    },
  );
});
