// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import {
  CLOUD_MODEL_OPTIONS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_ROUTE_CREDENTIAL_ENV,
  DEFAULT_ROUTE_PROFILE,
  INFERENCE_ROUTE_URL,
  MANAGED_PROVIDER_ID,
  OLLAMA_LOCAL_CREDENTIAL_ENV,
  VLLM_LOCAL_CREDENTIAL_ENV,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
  parseGatewayInference,
} from "../../dist/lib/inference-config";

describe("inference selection config", () => {
  it("exposes the curated cloud model picker options", () => {
    expect(CLOUD_MODEL_OPTIONS.map((option: { id: string }) => option.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "z-ai/glm-5.1",
      "minimaxai/minimax-m2.5",
      "openai/gpt-oss-120b",
    ]);
  });

  it("maps ollama-local to the sandbox inference route and default model", () => {
    // Local Ollama uses a dedicated credential env so the sandbox-side
    // config never points at OPENAI_API_KEY (GH #2519).
    expect(getProviderSelectionConfig("ollama-local")).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: DEFAULT_OLLAMA_MODEL,
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
      provider: "ollama-local",
      providerLabel: "Local Ollama",
    });
    expect(OLLAMA_LOCAL_CREDENTIAL_ENV).not.toBe(DEFAULT_ROUTE_CREDENTIAL_ENV);
  });

  it("maps nvidia-nim to the sandbox inference route", () => {
    expect(getProviderSelectionConfig("nvidia-nim", "nvidia/nemotron-3-super-120b-a12b")).toEqual({
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
    expect(
      getProviderSelectionConfig("compatible-anthropic-endpoint", "claude-sonnet-proxy"),
    ).toEqual({
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
    // Full-object assertion for one hosted provider to catch structural regressions
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
    expect(getProviderSelectionConfig("anthropic-prod", "claude-sonnet-4-6")).toEqual(
      expect.objectContaining({ model: "claude-sonnet-4-6", providerLabel: "Anthropic" }),
    );
    expect(getProviderSelectionConfig("gemini-api", "gemini-2.5-pro")).toEqual(
      expect.objectContaining({ model: "gemini-2.5-pro", providerLabel: "Google Gemini" }),
    );
    expect(getProviderSelectionConfig("compatible-endpoint", "openrouter/auto")).toEqual(
      expect.objectContaining({
        model: "openrouter/auto",
        providerLabel: "Other OpenAI-compatible endpoint",
      }),
    );
    // Full-object assertion for one local provider — uses dedicated
    // credential env, not OPENAI_API_KEY (GH #2519).
    expect(getProviderSelectionConfig("vllm-local", "meta-llama")).toEqual({
      endpointType: "custom",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "meta-llama",
      profile: DEFAULT_ROUTE_PROFILE,
      credentialEnv: VLLM_LOCAL_CREDENTIAL_ENV,
      provider: "vllm-local",
      providerLabel: "Local vLLM",
    });
    expect(VLLM_LOCAL_CREDENTIAL_ENV).not.toBe(DEFAULT_ROUTE_CREDENTIAL_ENV);
  });

  it("returns null for unknown providers", () => {
    expect(getProviderSelectionConfig("bogus-provider")).toBe(null);
  });

  it("does not grow beyond the approved provider set", () => {
    const APPROVED_PROVIDERS = [
      "nvidia-prod",
      "nvidia-nim",
      "openai-api",
      "anthropic-prod",
      "compatible-anthropic-endpoint",
      "gemini-api",
      "compatible-endpoint",
      "vllm-local",
      "ollama-local",
    ];
    for (const key of APPROVED_PROVIDERS) {
      expect(getProviderSelectionConfig(key)).not.toBe(null);
    }
    const CANDIDATES = [
      "bedrock",
      "vertex",
      "azure",
      "azure-openai",
      "deepseek",
      "mistral",
      "cohere",
      "fireworks",
      "together",
      "groq",
      "lambda",
      "replicate",
      "perplexity",
      "sambanova",
    ];
    for (const key of CANDIDATES) {
      expect(getProviderSelectionConfig(key)).toBe(null);
    }
  });

  it("falls back to provider defaults when model is omitted", () => {
    expect(getProviderSelectionConfig("openai-api")?.model).toBe("gpt-5.4");
    expect(getProviderSelectionConfig("anthropic-prod")?.model).toBe("claude-sonnet-4-6");
    expect(getProviderSelectionConfig("gemini-api")?.model).toBe("gemini-2.5-flash");
    expect(getProviderSelectionConfig("compatible-endpoint")?.model).toBe("custom-model");
    expect(getProviderSelectionConfig("compatible-anthropic-endpoint")?.model).toBe(
      "custom-anthropic-model",
    );
    expect(getProviderSelectionConfig("vllm-local")?.model).toBe("vllm-local");
  });

  it("builds a qualified OpenClaw primary model for ollama-local", () => {
    expect(getOpenClawPrimaryModel("ollama-local", "nemotron-3-nano:30b")).toBe(
      `${MANAGED_PROVIDER_ID}/nemotron-3-nano:30b`,
    );
  });

  it("builds a default OpenClaw primary model for non-ollama providers", () => {
    expect(getOpenClawPrimaryModel("nvidia-prod")).toBe(
      `${MANAGED_PROVIDER_ID}/nvidia/nemotron-3-super-120b-a12b`,
    );
    expect(getOpenClawPrimaryModel("ollama-local")).toBe(
      `${MANAGED_PROVIDER_ID}/${DEFAULT_OLLAMA_MODEL}`,
    );
  });
});

describe("parseGatewayInference", () => {
  it("parses provider and model from openshell inference get output", () => {
    const output = [
      "Gateway inference:",
      "",
      "  Provider: nvidia-nim",
      "  Model: nvidia/nemotron-3-super-120b-a12b",
      "  Version: 2",
    ].join("\n");
    expect(parseGatewayInference(output)).toEqual({
      provider: "nvidia-nim",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
  });

  it("returns null for empty output", () => {
    expect(parseGatewayInference("")).toBeNull();
    expect(parseGatewayInference(null)).toBeNull();
    expect(parseGatewayInference(undefined)).toBeNull();
  });

  it("returns null when inference is not configured", () => {
    expect(parseGatewayInference("Gateway inference:\n\n  Not configured")).toBeNull();
  });

  it("handles output with only provider (no model line)", () => {
    expect(parseGatewayInference("Gateway inference:\n\n  Provider: nvidia-nim")).toEqual({
      provider: "nvidia-nim",
      model: null,
    });
  });

  it("handles output with only model (no provider line)", () => {
    expect(parseGatewayInference("Gateway inference:\n\n  Model: some/model")).toEqual({
      provider: null,
      model: "some/model",
    });
  });
});
