// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { requireValue } from "../core/require-value";
import { createRemoteModelValidator, type SetupNimSelectionState } from "./setup-nim-selection";

describe("Gemini selection diagnostic context", () => {
  it("keeps the selected model and forwards the provider-owned default separately (#11141)", async () => {
    const selectedModel = "gemini-selected-model";
    const providerDefaultModel = "gemini-fixture-default";
    const endpointUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    const state: SetupNimSelectionState = {
      model: selectedModel,
      provider: "gemini-api",
      endpointUrl,
      credentialEnv: "GEMINI_API_KEY",
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: null,
      nimContainer: null,
      allowToolsIncompatible: false,
    };
    let receivedModel: string | undefined;
    let receivedOptions: { provider?: string; providerDefaultModel?: string } | undefined;
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
        model,
        _credentialEnv,
        _retryMessage,
        _helpUrl,
        options,
      ) => {
        receivedModel = model;
        receivedOptions = options;
        return { ok: true, api: "openai-completions" };
      },
      shouldRequireResponsesToolCalling: () => true,
      shouldSkipResponsesProbe: () => true,
      getProbeAuthMode: () => undefined,
    });

    const result = await validateSelectedRemoteModel({
      selected: { key: "gemini" },
      remoteConfig: {
        label: "Google Gemini",
        endpointUrl,
        helpUrl: null,
        defaultModel: providerDefaultModel,
      },
      state,
      selectedCredentialEnv: "GEMINI_API_KEY",
    });

    assert.equal(result, "selected");
    assert.equal(state.model, selectedModel);
    assert.equal(receivedModel, selectedModel);
    assert.equal(receivedOptions?.provider, "gemini-api");
    assert.equal(receivedOptions?.providerDefaultModel, providerDefaultModel);
  });
});
