// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  applyCloudFallbackSelection,
  clearNimContainerBeforeRetry,
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
  };
}

describe("setupNim selection state helpers", () => {
  it("applies a complete cloud fallback and clears stale NIM state", () => {
    const state = makeState();

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
