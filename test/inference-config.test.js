// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  CLOUD_MODEL_OPTIONS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_ROUTE_CREDENTIAL_ENV,
  DEFAULT_ROUTE_PROFILE,
  INFERENCE_ROUTE_URL,
  MANAGED_PROVIDER_ID,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
} = require("../bin/lib/inference-config");

describe("inference selection config", () => {
  it("exposes the curated cloud model picker options", () => {
    expect(CLOUD_MODEL_OPTIONS.map((option) => option.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "z-ai/glm5",
      "minimaxai/minimax-m2.5",
      "qwen/qwen3.5-397b-a17b",
      "openai/gpt-oss-120b",
    ]);
  });

  it("maps ollama-local to the sandbox inference route and default model", () => {
    expect(getProviderSelectionConfig("ollama-local")).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: DEFAULT_OLLAMA_MODEL,
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
      provider: "ollama-local",
      providerLabel: "Local Ollama",
    });
  });

  it("maps nvidia-nim to the sandbox inference route", () => {
    expect(
      getProviderSelectionConfig("nvidia-nim", "nvidia/nemotron-3-super-120b-a12b")
    ).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "nvidia/nemotron-3-super-120b-a12b",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
      provider: "nvidia-nim",
      providerLabel: "NVIDIA Endpoint API",
    });
  });

  it("builds a qualified OpenClaw primary model for ollama-local", () => {
    expect(getOpenClawPrimaryModel("ollama-local", "nemotron-3-nano:30b")).toBe(`${MANAGED_PROVIDER_ID}/nemotron-3-nano:30b`);
  });
});
