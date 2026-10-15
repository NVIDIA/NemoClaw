// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import { requireValue } from "../core/require-value";
import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import {
  abortFailedNimStartup,
  clearNimContainerBeforeRetry,
  createRemoteModelValidator,
  resolveCompatibleEndpointSelection,
  type SetupNimSelectionState,
} from "./setup-nim-selection";

function makeState(): SetupNimSelectionState {
  return {
    model: "nvidia/local-nim",
    provider: "vllm-local",
    endpointUrl: "http://127.0.0.1:8000/v1",
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: "openai-completions",
    nimContainer: "nemoclaw-nim-test",
    allowToolsIncompatible: false,
    skipHostInferenceSmoke: false,
  };
}

describe("setupNim selection state helpers", () => {
  it("removes the owned NIM container before clearing its route marker", () => {
    const state = makeState();
    state.localNimSelected = true;
    const remove = vi.fn((name: string) => {
      expect(name).toBe("nemoclaw-nim-test");
      expect(state.nimContainer).toBe(name);
      expect(state.localNimSelected).toBe(true);
    });

    clearNimContainerBeforeRetry(state, remove);

    expect(remove).toHaveBeenCalledOnce();
    assert.equal(state.nimContainer, null);
    expect(state.localNimSelected).toBeUndefined();
    assert.equal(state.model, "nvidia/local-nim");
    assert.equal(state.provider, "vllm-local");
  });

  it("keeps the NIM marker when owned-container removal fails", () => {
    const state = makeState();
    state.localNimSelected = true;

    expect(() =>
      clearNimContainerBeforeRetry(state, () => {
        throw new Error("remove failed");
      }),
    ).toThrow("remove failed");

    expect(state.nimContainer).toBe("nemoclaw-nim-test");
    expect(state.localNimSelected).toBe(true);
  });

  it("stops onboarding after unhealthy NIM cleanup without selecting cloud inference", () => {
    const state = makeState();
    state.localNimSelected = true;
    const remove = vi.fn((id: string) => {
      expect(id).toBe("a".repeat(64));
      expect(state.localNimSelected).toBe(true);
    });

    const started = { name: "nemoclaw-nim-test", id: "a".repeat(64) };
    expect(() => abortFailedNimStartup(state, started, remove)).toThrow(
      "Local NVIDIA NIM failed to become healthy. Onboarding stopped.",
    );

    expect(remove).toHaveBeenCalledOnce();
    expect(state.nimContainer).toBeNull();
    expect(state.localNimSelected).toBeUndefined();
    expect(state.model).toBe("nvidia/local-nim");
    expect(state.provider).toBe("vllm-local");
    expect(state.credentialEnv).toBeNull();
  });

  it("removes the exact started NIM container even when identity revalidation fails", () => {
    const state = makeState();
    state.localNimSelected = true;
    state.revalidateSandboxIdentity = vi.fn(() => {
      throw new Error("sandbox identity changed");
    });
    const started = { name: "nemoclaw-nim-test", id: "b".repeat(64) };
    const remove = vi.fn((id: string) => {
      expect(id).toBe(started.id);
      expect(state.nimContainer).toBe(started.name);
    });

    expect(() => abortFailedNimStartup(state, started, remove)).toThrow(
      "Local NVIDIA NIM failed to become healthy. Onboarding stopped.",
    );
    expect(state.revalidateSandboxIdentity).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledExactlyOnceWith(started.id);
    expect(state.nimContainer).toBeNull();
    expect(state.localNimSelected).toBeUndefined();
  });

  it("retains the NIM marker when exact-container cleanup fails", () => {
    const state = makeState();
    state.localNimSelected = true;
    const started = { name: "nemoclaw-nim-test", id: "c".repeat(64) };

    expect(() =>
      abortFailedNimStartup(state, started, () => {
        throw new Error(`Remove container ${started.id} manually`);
      }),
    ).toThrow(started.id);
    expect(state.nimContainer).toBe(started.name);
    expect(state.localNimSelected).toBe(true);
  });
});

describe("resolveCompatibleEndpointSelection", () => {
  it("rejects an unsafe endpoint at the onboarding selection boundary", async () => {
    const prompt = vi.fn(async () => "https://later.example.test/v1");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);

    try {
      await expect(
        resolveCompatibleEndpointSelection({
          kind: "openai",
          envUrl: "ftp://unsafe.example.test/v1",
          recoveredEndpointUrl: null,
          nonInteractive: true,
          prompt,
        }),
      ).rejects.toThrow("process.exit:1");
      expect(prompt).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("  Endpoint URL must use HTTP or HTTPS.");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe("createRemoteModelValidator", () => {
  it.each(["openai-completions", "anthropic-messages"] as const)(
    "uses the intended %s runtime API when validating custom Anthropic selections (#6289)",
    async (expectedApi) => {
      const state = makeState();
      state.provider = "compatible-anthropic-endpoint";
      state.endpointUrl = "https://compatible.example";
      state.model = "custom-model";
      let validatedApi: string | undefined;
      const { validateSelectedRemoteModel } = createRemoteModelValidator({
        OPENAI_ENDPOINT_URL: "https://default-openai.example/v1",
        ANTHROPIC_ENDPOINT_URL: "https://default-anthropic.example/v1",
        requireValue,
        isBackToSelection: (_value): _value is never => false,
        validateCustomOpenAiLikeSelection: async () => ({
          ok: false,
          retry: "selection",
        }),
        validateCustomAnthropicSelection: async (
          _label,
          _endpointUrl,
          _model,
          _credentialEnv,
          _helpUrl,
          options,
        ) => {
          validatedApi = options?.intendedApi;
          return { ok: true, api: validatedApi ?? null };
        },
        validateAnthropicSelectionWithRetryMessage: async () => ({
          ok: false,
          retry: "selection",
        }),
        validateOpenAiLikeSelection: async () => ({
          ok: false,
          retry: "selection",
        }),
        shouldRequireResponsesToolCalling: () => false,
        shouldSkipResponsesProbe: () => false,
        getProbeAuthMode: () => undefined,
      });

      const result = await validateSelectedRemoteModel({
        selected: { key: "anthropicCompatible" },
        remoteConfig: {
          label: "Other Anthropic-compatible endpoint",
          endpointUrl: "https://compatible.example",
          helpUrl: null,
        },
        state,
        selectedCredentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        intendedInferenceApi: expectedApi,
      });

      assert.equal(result, "selected");
      assert.equal(validatedApi, expectedApi);
      assert.equal(state.preferredInferenceApi, expectedApi);
    },
  );

  it("forces custom compatible endpoints to chat completions unless the API is explicit", async () => {
    const state = makeState();
    state.provider = "openai-compatible";
    state.endpointUrl = "https://compatible.example/v1";
    state.model = "model-a";
    const capabilityCache = new OnboardInferenceCapabilityCache();
    state.inferenceCapabilityCache = capabilityCache;
    let calledEndpoint: string | null = null;
    let receivedCapabilityCache: OnboardInferenceCapabilityCache | undefined;
    let configuredReasoning = false;
    const logLines: string[] = [];
    const { validateSelectedRemoteModel } = createRemoteModelValidator({
      OPENAI_ENDPOINT_URL: "https://default-openai.example/v1",
      ANTHROPIC_ENDPOINT_URL: "https://default-anthropic.example/v1",
      requireValue: (value, message) => {
        if (value === null || value === undefined) throw new Error(message);
        return value;
      },
      isBackToSelection: (_value): _value is never => false,
      validateCustomOpenAiLikeSelection: async (
        _label,
        endpointUrl,
        _model,
        _credentialEnv,
        _helpUrl,
        selectedCapabilityCache,
      ) => {
        calledEndpoint = endpointUrl;
        receivedCapabilityCache = selectedCapabilityCache;
        return { ok: true, api: "responses" };
      },
      validateCustomAnthropicSelection: async () => ({
        ok: false,
        retry: "selection",
      }),
      validateAnthropicSelectionWithRetryMessage: async () => ({
        ok: false,
        retry: "selection",
      }),
      validateOpenAiLikeSelection: async () => ({
        ok: false,
        retry: "selection",
      }),
      shouldRequireResponsesToolCalling: () => false,
      shouldSkipResponsesProbe: () => false,
      getProbeAuthMode: () => undefined,
      configureCompatibleEndpointReasoning: async () => {
        configuredReasoning = true;
        return "true";
      },
      log: (message) => logLines.push(message),
    });

    const result = await validateSelectedRemoteModel({
      selected: { key: "custom" },
      remoteConfig: {
        label: "Other OpenAI-compatible endpoint",
        endpointUrl: "https://remote-config.example/v1",
        helpUrl: null,
      },
      state,
      selectedCredentialEnv: "OPENAI_API_KEY",
    });

    assert.equal(result, "selected");
    assert.equal(calledEndpoint, "https://compatible.example/v1");
    assert.equal(receivedCapabilityCache, capabilityCache);
    assert.equal(state.preferredInferenceApi, "openai-completions");
    assert.equal(state.compatibleEndpointReasoning, "true");
    assert.equal(configuredReasoning, true);
    assert.deepEqual(logLines, [
      "  ⚠ Reasoning mode validates Chat Completions only; tools and streaming are unverified.",
    ]);
  });

  it("maps provider validation model retries without mutating selected model state", async () => {
    const state = makeState();
    const { validateSelectedRemoteModel } = createRemoteModelValidator({
      OPENAI_ENDPOINT_URL: "https://default-openai.example/v1",
      ANTHROPIC_ENDPOINT_URL: "https://default-anthropic.example/v1",
      requireValue: (value, message) => {
        if (value === null || value === undefined) throw new Error(message);
        return value;
      },
      isBackToSelection: (_value): _value is never => false,
      validateCustomOpenAiLikeSelection: async () => ({
        ok: false,
        retry: "selection",
      }),
      validateCustomAnthropicSelection: async () => ({
        ok: false,
        retry: "model",
      }),
      validateAnthropicSelectionWithRetryMessage: async () => ({
        ok: false,
        retry: "selection",
      }),
      validateOpenAiLikeSelection: async () => ({
        ok: false,
        retry: "selection",
      }),
      shouldRequireResponsesToolCalling: () => false,
      shouldSkipResponsesProbe: () => false,
      getProbeAuthMode: () => undefined,
    });

    const result = await validateSelectedRemoteModel({
      selected: { key: "anthropicCompatible" },
      remoteConfig: {
        label: "Other Anthropic-compatible endpoint",
        endpointUrl: "https://anthropic.example/v1",
        helpUrl: null,
      },
      state,
      selectedCredentialEnv: "ANTHROPIC_API_KEY",
    });

    assert.equal(result, "retry-model");
    assert.equal(state.model, "nvidia/local-nim");
    assert.equal(state.nimContainer, "nemoclaw-nim-test");
  });

  it.each(["nvidia-prod", "nvidia-nim"])(
    "selects the Nemotron probe payload for NVIDIA Endpoints provider %s (#10880)",
    async (provider) => {
      const state = makeState();
      state.provider = provider;
      state.endpointUrl = "https://integrate.api.nvidia.com/v1";
      state.model = "nvidia/nemotron-3-super-120b-a12b";
      let receivedOptions: { useNvidiaEndpointProbePayload?: boolean } | undefined;
      const { validateSelectedRemoteModel } = createRemoteModelValidator({
        OPENAI_ENDPOINT_URL: "https://default-openai.example/v1",
        ANTHROPIC_ENDPOINT_URL: "https://default-anthropic.example/v1",
        requireValue,
        isBackToSelection: (_value): _value is never => false,
        validateCustomOpenAiLikeSelection: async () => ({
          ok: false,
          retry: "selection",
        }),
        validateCustomAnthropicSelection: async () => ({
          ok: false,
          retry: "selection",
        }),
        validateAnthropicSelectionWithRetryMessage: async () => ({
          ok: false,
          retry: "selection",
        }),
        validateOpenAiLikeSelection: async (
          _label,
          _endpointUrl,
          _model,
          _credentialEnv,
          _retryMessage,
          _helpUrl,
          options,
        ) => {
          receivedOptions = options;
          return { ok: true, api: "openai-completions" };
        },
        shouldRequireResponsesToolCalling: () => false,
        shouldSkipResponsesProbe: () => true,
        getProbeAuthMode: () => undefined,
      });

      assert.equal(
        await validateSelectedRemoteModel({
          selected: { key: "build" },
          remoteConfig: {
            label: "NVIDIA Endpoints",
            endpointUrl: "https://integrate.api.nvidia.com/v1",
            helpUrl: null,
          },
          state,
          selectedCredentialEnv: "NVIDIA_INFERENCE_API_KEY",
        }),
        "selected",
      );
      assert.equal(receivedOptions?.useNvidiaEndpointProbePayload, true);
    },
  );
});
