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
import type { SetupInferenceDeps } from "../../src/lib/onboard/setup-inference";
import { serializedHostLocalInferenceReceipt } from "../helpers/host-local-inference-receipt";

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
  it("clears stale host-local ownership when selecting native NVIDIA inference", async () => {
    const providerAdapter = {
      importProviderProfile: vi.fn(async () => ({ ok: true as const })),
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true as const, value: undefined })),
      getProvider: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "absent" },
        })
        .mockResolvedValue({
          ok: true,
          value: {
            name: "nemoclaw-nvidia-prod-v1",
            type: "nemoclaw-nvidia-inference-v1",
            credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
            configKeys: [],
            revision: { id: "native-identity", resourceVersion: 1 },
          },
        }),
      createProvider: vi.fn(async () => ({ ok: true as const })),
    } as unknown as NonNullable<SetupInferenceDeps["providerAdapter"]>;
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        providerAdapter,
        hydrateCredentialEnv: () => "host-secret",
        getNativeNvidiaProviderAuthority: () => undefined,
        setNativeNvidiaProviderAuthority: vi.fn(),
        getSandbox: () => ({
          name: "sandbox-a",
          provider: "vllm-local",
          model: "qwen3.5-9b",
          hostLocalInferenceReceipt: serializedHostLocalInferenceReceipt(),
        }),
      },
    });
    await expect(
      harness.setupInference(
        "sandbox-a",
        "remote-model",
        "nvidia-prod",
        null,
        "NVIDIA_API_KEY",
        null,
        [],
      ),
    ).resolves.toEqual({ ok: true });

    expect(harness.updateSandbox).toHaveBeenCalledWith(
      "sandbox-a",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "remote-model",
        hostLocalInferenceReceipt: null,
        nativeNvidiaProviderAttachment: expect.objectContaining({ providerId: "native-identity" }),
      }),
    );
    expect(harness.commands.some(({ command }) => command.startsWith("inference set"))).toBe(false);
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

describe("Hermes native provider ownership", () => {
  it("selects a Hermes-scoped provider without mutating a shared route", async () => {
    const harness = createDirectSetupInferenceHarness({
      overrides: { applyLocalInferenceRoute: undefined },
    });
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "hermes",
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.native.adapter.createProvider).toHaveBeenCalledOnce();
    expect([...harness.native.authorities.values()]).toEqual([
      expect.objectContaining({ agent: "hermes", sandboxName: "test-box", provider: "vllm-local" }),
    ]);
    expect(harness.commands.some(({ command }) => command.startsWith("inference set"))).toBe(false);
  });

  it("retires an unattached Hermes provider after host validation fails", async () => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        applyLocalInferenceRoute: undefined,
        isNonInteractive: () => true,
        verifyOnboardInferenceSmoke: async () => {
          throw new Error("host smoke refused");
        },
      },
    });
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "hermes",
      }),
    ).rejects.toThrow("host smoke refused");
    expect(harness.native.adapter.createProvider).toHaveBeenCalledOnce();
    expect(harness.updateSandbox).not.toHaveBeenCalled();
    expect(harness.native.providers.size).toBe(0);
    expect(harness.native.authorities.size).toBe(0);
  });
});

it("stages explicit legacy Hermes recreation with a Hermes-scoped receipt", async () => {
  const { row, before, harness, run } = legacyRecreationHarness("vllm-local", "hermes");
  const result = await run(true);
  expect(result.stagedNativeLocalRecreation).toEqual({
    source: before,
    attachment: expect.objectContaining({
      agent: "hermes",
      sandboxName: row.name,
      gatewayName: "nemoclaw",
    }),
  });
  expect(harness.native.adapter.createProvider).toHaveBeenCalledOnce();
  expect(harness.updateSandbox).not.toHaveBeenCalled();
  expect(row).toEqual(before);
  expect(harness.commands.some(({ command }) => command.startsWith("inference set"))).toBe(false);
});

it.each(["openai-completions", "openai-responses"] as const)(
  "creates a sandbox-owned OpenClaw compatible %s provider before publishing its reservation",
  async (api) => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        hydrateCredentialEnv: () => "fixture-only-host-key",
        isNonInteractive: () => true,
      },
    });
    await expect(
      harness.setupInference(
        "test-box",
        "served-alias",
        "compatible-endpoint",
        "http://127.0.0.1:8000/v1",
        "HOST_COMPATIBLE_KEY",
        null,
        [],
        { agentName: "openclaw", preferredInferenceApi: api },
      ),
    ).resolves.toEqual({ ok: true });
    expect([...harness.native.authorities.values()]).toEqual([
      expect.objectContaining({
        agent: "openclaw",
        provider: "compatible-endpoint",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        authMode: "authenticated",
      }),
    ]);
    expect(harness.native.profiles[0]).toMatchObject({
      endpoints: [
        {
          rules: [
            { allow: { method: "GET", path: "/v1/models" } },
            {
              allow: {
                method: "POST",
                path: api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions",
              },
            },
          ],
        },
      ],
    });
    expect(harness.commands.some(({ command }) => command.startsWith("inference "))).toBe(false);
  },
);

it.each([
  { agent: "openclaw", api: "openai-responses", expectedAgent: "openclaw" },
  { agent: "hermes", api: "openai-completions", expectedAgent: "hermes" },
  { agent: "hermes", api: "openai-responses", expectedAgent: "hermes" },
  { agent: "langchain-deepagents-code", api: "openai-completions", expectedAgent: undefined },
])(
  "registers $agent compatible inference on an accepted reserved-alias port",
  async ({ agent, api, expectedAgent }) => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        hydrateCredentialEnv: () => "fixture-only-host-key",
        isNonInteractive: () => true,
      },
    });
    await expect(
      harness.setupInference(
        "test-box",
        "served-alias",
        "compatible-endpoint",
        "http://host.openshell.internal:42103/v1",
        "HOST_COMPATIBLE_KEY",
        null,
        [],
        { agentName: agent, preferredInferenceApi: api },
      ),
    ).resolves.toEqual({ ok: true });
    expect([...harness.native.authorities.values()]).toEqual([
      expect.objectContaining({
        provider: "compatible-endpoint",
        endpointUrl: "http://host.openshell.internal:42103/v1",
        authMode: "authenticated",
      }),
    ]);
    expect([...harness.native.authorities.values()][0]?.agent).toBe(expectedAgent);
    expect(harness.native.profiles[0]).toMatchObject({
      endpoints: [
        {
          port: 42103,
          rules: [
            { allow: { method: "GET", path: "/v1/models" } },
            {
              allow: {
                method: "POST",
                path: api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions",
              },
            },
          ],
        },
      ],
    });
    expect(harness.commands.some(({ command }) => command.startsWith("inference "))).toBe(false);
  },
);

it.each(["openclaw", "hermes", "pi", "langchain-deepagents-code"])(
  "registers Local NIM as a sentinel native provider for %s",
  async (agent) => {
    const nim =
      require("../../src/lib/inference/nim.ts") as typeof import("../../src/lib/inference/nim");
    vi.spyOn(nim, "getServedModelId").mockReturnValue("local/nim-model");
    const getManagedVllmProviderBinding = vi.fn(() => ({
      baseUrl: "http://host.openshell.internal:18000/v1",
      apiKey: "managed-vllm-secret",
    }));
    const harness = createDirectSetupInferenceHarness({
      overrides: { applyLocalInferenceRoute: undefined, getManagedVllmProviderBinding },
    });
    await expect(
      harness.setupInference(
        "test-box",
        "local/nim-model",
        "vllm-local",
        nim.getNimInferenceEndpoints().baseUrl,
        null,
        null,
        [],
        { agentName: agent, localNimSelected: true },
      ),
    ).resolves.toEqual({ ok: true });
    const attachment = [...harness.native.authorities.values()][0];
    expect(attachment).toMatchObject({
      provider: "vllm-local",
      authMode: "sentinel",
      endpointUrl: nim.getNimInferenceEndpoints().baseUrl,
      sandboxName: "test-box",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    });
    expect(attachment.agent).toBe(agent === "langchain-deepagents-code" ? undefined : agent);
    expect(harness.native.adapter.createProvider.mock.calls[0][0].credentials).toEqual([
      { name: "NEMOCLAW_LOCAL_INFERENCE_TOKEN", value: "dummy" },
    ]);
    expect(getManagedVllmProviderBinding).not.toHaveBeenCalled();
    expect(harness.commands.some(({ command }) => command.startsWith("inference set"))).toBe(false);
  },
);

describe("published native route backup boundary", () => {
  it.each([
    {
      agent: "openclaw",
      model: "old-model",
      staged: false,
      key: "fixture-only-host-key",
      reuse: false,
    },
    {
      agent: "openclaw",
      model: "new-model",
      staged: true,
      key: "fixture-only-host-key",
      reuse: false,
    },
    { agent: "openclaw", model: "old-model", staged: false, key: null, reuse: true },
    { agent: "openclaw", model: "new-model", staged: true, key: null, reuse: true },
    { agent: "hermes", model: "old-model", staged: false, key: null, reuse: true },
    { agent: "hermes", model: "new-model", staged: true, key: null, reuse: true },
  ] as const)(
    "preserves the source and provider credential when selecting $model",
    async ({ agent, model, staged, key, reuse }) => {
      const attachment = nativeLocalSetupReceipt({
        agent,
        provider: "compatible-endpoint",
        sandboxName: "test-box",
        gatewayName: "nemoclaw",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        authMode: "authenticated",
      });
      const row = {
        name: "test-box",
        agent,
        provider: "compatible-endpoint",
        model: "old-model",
        gatewayName: "nemoclaw",
        endpointUrl: "http://127.0.0.1:8000/v1",
        credentialEnv: "HOST_COMPATIBLE_KEY",
        preferredInferenceApi: "openai-completions",
        nativeLocalProviderAttachment: attachment,
      };
      const before = structuredClone(row);
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          getSandbox: () => row,
          hydrateCredentialEnv: () => key,
          isNonInteractive: () => true,
        },
      });
      harness.native.seed(attachment);
      const providers = structuredClone(harness.native.providers);
      const result = await harness.setupInference(
        "test-box",
        model,
        "compatible-endpoint",
        row.endpointUrl,
        row.credentialEnv,
        null,
        [],
        {
          agentName: agent,
          preferredInferenceApi: "openai-completions",
          deferPublishedRouteReservation: true,
          reservationSessionId: "session",
          reuseGatewayCredentialWithoutLocalKey: reuse,
          skipHostInferenceSmoke: reuse,
        },
      );
      expect(result).toEqual(
        staged
          ? { ok: true, stagedNativeLocalRecreation: { source: before, attachment } }
          : { ok: true },
      );
      expect(row).toEqual(before);
      expect(harness.updateSandbox).not.toHaveBeenCalled();
      expect(harness.native.adapter.updateProvider).not.toHaveBeenCalled();
      expect(harness.native.adapter.createProvider).not.toHaveBeenCalled();
      expect(harness.native.providers).toEqual(providers);
    },
  );
});
