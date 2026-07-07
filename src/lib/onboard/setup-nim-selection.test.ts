// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { requireValue } from "../core/require-value";
import {
  applyCloudFallbackSelection,
  clearNimContainerBeforeRetry,
  createRemoteModelValidator,
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
    state.allowToolsIncompatible = true;

    applyCloudFallbackSelection(state, {
      providerName: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      defaultModel: "meta/llama-3.3-70b-instruct",
    });

    assert.deepEqual(state, {
      model: "meta/llama-3.3-70b-instruct",
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
  });

  it("clears stale NIM containers before retrying provider selection", () => {
    const state = makeState();

    clearNimContainerBeforeRetry(state);

    assert.equal(state.nimContainer, null);
    assert.equal(state.model, "nvidia/local-nim");
    assert.equal(state.provider, "vllm-local");
  });
});

describe("createRemoteModelValidator", () => {
  it.each([
    "openai-completions",
    "anthropic-messages",
  ] as const)("uses the intended %s runtime API when validating custom Anthropic selections (#6289)", async (expectedApi) => {
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
  });

  it("forces custom compatible endpoints to chat completions unless the API is explicit", async () => {
    const state = makeState();
    state.provider = "openai-compatible";
    state.endpointUrl = "https://compatible.example/v1";
    state.model = "model-a";
    let calledEndpoint: string | null = null;
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
      validateCustomOpenAiLikeSelection: async (_label, endpointUrl) => {
        calledEndpoint = endpointUrl;
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
});
