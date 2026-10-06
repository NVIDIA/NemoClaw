// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import { requireValue } from "../core/require-value";
import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import {
  applyCloudFallbackSelection,
  applyDefaultModelSelection,
  applyModelSelection,
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
  it("applies a complete cloud fallback and clears stale local-provider state", () => {
    const state = makeState();
    const onModelSelected = vi.fn();
    state.allowToolsIncompatible = true;
    state.onModelSelected = onModelSelected;

    applyCloudFallbackSelection(state, {
      providerName: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      defaultModel: "meta/llama-3.3-70b-instruct",
    });

    assert.deepEqual(state, {
      model: "meta/llama-3.3-70b-instruct",
      modelSource: "product_catalog",
      onModelSelected,
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: null,
      nimContainer: null,
      allowToolsIncompatible: false,
      skipHostInferenceSmoke: false,
      reuseGatewayCredentialWithoutLocalKey: false,
    });
    expect(onModelSelected).toHaveBeenCalledTimes(1);
    expect(onModelSelected).toHaveBeenCalledWith("product_catalog");
  });

  it.each(["custom", "product_catalog", "provider_catalog", "unknown"] as const)(
    "reports %s selection after assigning the model and before changing the API",
    (source) => {
      const state = makeState();
      const onModelSelected = vi.fn((selectedSource) => {
        expect(selectedSource).toBe(source);
        expect(state.model).toBe("chosen-model");
        expect(state.preferredInferenceApi).toBe("openai-completions");
      });
      state.onModelSelected = onModelSelected;

      applyModelSelection(state, "chosen-model", source);

      expect(onModelSelected).toHaveBeenCalledTimes(1);
      expect(onModelSelected).toHaveBeenCalledWith(source);
      expect(state.model).toBe("chosen-model");
      expect(state.preferredInferenceApi).toBe("openai-completions");
    },
  );

  it("propagates a selection callback error with the model assigned and the API unchanged", () => {
    const state = makeState();
    const callbackError = new Error("selection callback failed");
    const assertRouteCompatible = vi.fn();
    const onModelSelected = vi.fn(() => {
      expect(state.model).toBe("chosen-model");
      expect(state.preferredInferenceApi).toBe("openai-completions");
      throw callbackError;
    });
    state.onModelSelected = onModelSelected;
    state.assertRouteCompatible = assertRouteCompatible;

    expect(() => applyModelSelection(state, "chosen-model", "custom")).toThrow(callbackError);

    expect(onModelSelected).toHaveBeenCalledTimes(1);
    expect(onModelSelected).toHaveBeenCalledWith("custom");
    expect(state.model).toBe("chosen-model");
    expect(state.preferredInferenceApi).toBe("openai-completions");
    expect(assertRouteCompatible).not.toHaveBeenCalled();
  });

  it("assigns a model without requiring a selection callback", () => {
    const state = makeState();
    expect(state.onModelSelected).toBeUndefined();

    applyModelSelection(state, "chosen-model", "custom");

    expect(state.model).toBe("chosen-model");
    expect(state.preferredInferenceApi).toBe("openai-completions");
    expect(state.onModelSelected).toBeUndefined();
  });

  it.each([
    {
      flags: { requested: true, constrained: true, environmentOverride: true, recovered: true },
      source: "custom",
    },
    {
      flags: { requested: false, constrained: true, environmentOverride: true, recovered: true },
      source: "unknown",
    },
    {
      flags: { requested: false, constrained: false, environmentOverride: true, recovered: true },
      source: "custom",
    },
    {
      flags: { requested: false, constrained: false, environmentOverride: false, recovered: true },
      source: "unknown",
    },
    {
      flags: { requested: false, constrained: false, environmentOverride: false, recovered: false },
      source: "product_catalog",
    },
  ] as const)("applies default selection with source $source for $flags", ({ flags, source }) => {
    const state = makeState();
    const onModelSelected = vi.fn(() => {
      expect(state.model).toBe("default-model");
      expect(state.preferredInferenceApi).toBe("openai-completions");
    });
    state.onModelSelected = onModelSelected;

    applyDefaultModelSelection(state, "default-model", flags);

    expect(onModelSelected).toHaveBeenCalledTimes(1);
    expect(onModelSelected).toHaveBeenCalledWith(source);
    expect(state.model).toBe("default-model");
    expect(state.preferredInferenceApi).toBe("openai-completions");
  });

  it("classifies a default using the previous model state before assigning its replacement", () => {
    const state = makeState();
    state.model = null;
    const modelReads: SetupNimSelectionState["model"][] = [];
    const onModelSelected = vi.fn();
    state.onModelSelected = onModelSelected;
    const flags = {
      requested: false,
      get constrained() {
        modelReads.push(state.model);
        return Boolean(state.model);
      },
      environmentOverride: false,
      recovered: false,
    };

    applyDefaultModelSelection(state, "default-model", flags);

    expect(modelReads).toEqual([null]);
    expect(state.model).toBe("default-model");
    expect(state.preferredInferenceApi).toBe("openai-completions");
    expect(onModelSelected).toHaveBeenCalledTimes(1);
    expect(onModelSelected).toHaveBeenCalledWith("product_catalog");
  });

  it("clears stale NIM containers before retrying provider selection", () => {
    const state = makeState();

    clearNimContainerBeforeRetry(state);

    assert.equal(state.nimContainer, null);
    assert.equal(state.model, "nvidia/local-nim");
    assert.equal(state.provider, "vllm-local");
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
        validateCustomOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
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
        validateOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
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
      validateCustomAnthropicSelection: async () => ({ ok: false, retry: "selection" }),
      validateAnthropicSelectionWithRetryMessage: async () => ({ ok: false, retry: "selection" }),
      validateOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
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
      validateCustomOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
      validateCustomAnthropicSelection: async () => ({ ok: false, retry: "model" }),
      validateAnthropicSelectionWithRetryMessage: async () => ({ ok: false, retry: "selection" }),
      validateOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
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
        validateCustomOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
        validateCustomAnthropicSelection: async () => ({ ok: false, retry: "selection" }),
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
