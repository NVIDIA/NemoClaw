// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it, expect } from "vitest";

import {
  CLOUD_MODEL_OPTIONS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_ROUTE_CREDENTIAL_ENV,
  DEFAULT_ROUTE_PROFILE,
  INFERENCE_ROUTE_URL,
  MANAGED_PROVIDER_ID,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
} from "../bin/lib/inference-config";

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
      providerLabel: "NVIDIA Endpoints",
    });
  });

  it("maps compatible-anthropic-endpoint to the sandbox inference route", () => {
    assert.deepEqual(getProviderSelectionConfig("compatible-anthropic-endpoint", "claude-sonnet-proxy"), {
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "claude-sonnet-proxy",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      provider: "compatible-anthropic-endpoint",
      providerLabel: "Other Anthropic-compatible endpoint",
    });
  });

  it("maps the remaining hosted providers to the sandbox inference route", () => {
    expect(getProviderSelectionConfig("openai-api", "gpt-5.4-mini")).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "gpt-5.4-mini",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: "OPENAI_API_KEY",
      provider: "openai-api",
      providerLabel: "OpenAI",
    });

    expect(getProviderSelectionConfig("anthropic-prod", "claude-sonnet-4-6")).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "claude-sonnet-4-6",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: "ANTHROPIC_API_KEY",
      provider: "anthropic-prod",
      providerLabel: "Anthropic",
    });

    expect(getProviderSelectionConfig("gemini-api", "gemini-2.5-pro")).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "gemini-2.5-pro",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: "GEMINI_API_KEY",
      provider: "gemini-api",
      providerLabel: "Google Gemini",
    });

    expect(getProviderSelectionConfig("compatible-endpoint", "openrouter/auto")).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "openrouter/auto",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: "COMPATIBLE_API_KEY",
      provider: "compatible-endpoint",
      providerLabel: "Other OpenAI-compatible endpoint",
    });

    expect(getProviderSelectionConfig("vllm-local", "meta-llama")).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "meta-llama",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
      provider: "vllm-local",
      providerLabel: "Local vLLM",
    });
  });

  it("returns null for unknown providers", () => {
    expect(getProviderSelectionConfig("bogus-provider")).toBe(null);
  });

  it("builds a qualified OpenClaw primary model for ollama-local", () => {
    expect(getOpenClawPrimaryModel("ollama-local", "nemotron-3-nano:30b")).toBe(`${MANAGED_PROVIDER_ID}/nemotron-3-nano:30b`);
  });

  it("falls back to provider defaults when model is omitted", () => {
    expect(getProviderSelectionConfig("openai-api").model).toBe("gpt-5.4");
    expect(getProviderSelectionConfig("anthropic-prod").model).toBe("claude-sonnet-4-6");
    expect(getProviderSelectionConfig("gemini-api").model).toBe("gemini-2.5-flash");
    expect(getProviderSelectionConfig("compatible-endpoint").model).toBe("custom-model");
    expect(getProviderSelectionConfig("compatible-anthropic-endpoint").model).toBe("custom-anthropic-model");
    expect(getProviderSelectionConfig("vllm-local").model).toBe("vllm-local");
  });

  it("builds a default OpenClaw primary model for non-ollama providers", () => {
    expect(getOpenClawPrimaryModel("nvidia-prod")).toBe(`${MANAGED_PROVIDER_ID}/nvidia/nemotron-3-super-120b-a12b`);
  });
});
