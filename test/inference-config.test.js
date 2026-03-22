// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

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
    assert.deepEqual(
      CLOUD_MODEL_OPTIONS.map((option) => option.id),
      [
        "nvidia/nemotron-3-super-120b-a12b",
        "moonshotai/kimi-k2.5",
        "z-ai/glm5",
        "minimaxai/minimax-m2.5",
        "qwen/qwen3.5-397b-a17b",
        "openai/gpt-oss-120b",
      ],
    );
  });

  it("maps ollama-local to the sandbox inference route and default model", () => {
    assert.deepEqual(getProviderSelectionConfig("ollama-local"), {
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
    assert.deepEqual(getProviderSelectionConfig("nvidia-nim", "nvidia/nemotron-3-super-120b-a12b"), {
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

  it("maps custom to the sandbox inference route with user-specified model", () => {
    assert.deepEqual(getProviderSelectionConfig("custom", "gemini-2.5-flash"), {
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "gemini-2.5-flash",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
      provider: "custom",
      providerLabel: "Custom Provider",
    });
  });

  it("returns null model for custom provider when no model specified", () => {
    const config = getProviderSelectionConfig("custom");
    assert.equal(config.model, null);
    assert.equal(config.providerLabel, "Custom Provider");
  });

  it("returns all expected fields for custom provider", () => {
    const config = getProviderSelectionConfig("custom", "gemini-2.5-flash");
    assert.equal(config.endpointType, "custom");
    assert.equal(config.endpointUrl, INFERENCE_ROUTE_URL);
    assert.equal(config.ncpPartner, null);
    assert.equal(config.credentialEnv, DEFAULT_ROUTE_CREDENTIAL_ENV);
    assert.equal(config.profile, DEFAULT_ROUTE_PROFILE);
  });

  it("returns null for unknown provider", () => {
    assert.equal(getProviderSelectionConfig("unknown-provider"), null);
  });

  it("builds a qualified OpenClaw primary model for ollama-local", () => {
    assert.equal(
      getOpenClawPrimaryModel("ollama-local", "nemotron-3-nano:30b"),
      `${MANAGED_PROVIDER_ID}/nemotron-3-nano:30b`,
    );
  });
});
