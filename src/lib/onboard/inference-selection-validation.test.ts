// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";

describe("inference selection validation", () => {
  it("preserves non-zero exit signaling when non-interactive endpoint validation fails (#5721)", async () => {
    const originalExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "nvapi-invalid-key-12345",
      probeOpenAiLikeEndpoint: () => ({
        ok: false,
        failures: [{ name: "Chat Completions API", httpStatus: 403 }],
      }),
      promptValidationRecovery,
    });

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "NVIDIA Endpoints",
          "https://integrate.api.nvidia.com/v1",
          "meta/llama-3.3-70b-instruct",
          "NVIDIA_INFERENCE_API_KEY",
        ),
      ).rejects.toThrow("Non-interactive endpoint validation failed.");
      expect(exit).toHaveBeenCalledWith(1);
      expect(process.exitCode).toBe(1);
      expect(promptValidationRecovery).not.toHaveBeenCalled();
      expect(error.mock.calls.map((args) => args.join(" "))).toEqual([
        "  NVIDIA Endpoints endpoint validation failed.",
        "  Validation probe summary: Chat Completions API: HTTP 403.",
        "  Validation details were omitted to avoid exposing credentials.",
      ]);
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("fails reasoning-mode validation when Chat Completions fails (#3279)", async () => {
    vi.stubEnv("NEMOCLAW_REASONING", "yes");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 500 }],
    }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
    });

    try {
      await expect(
        helpers.validateCustomOpenAiLikeSelection(
          "Custom endpoint",
          "https://compatible.example/v1",
          "reasoning-model",
          "COMPATIBLE_API_KEY",
        ),
      ).resolves.toEqual({ ok: false, retry: "selection" });
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
        "https://compatible.example/v1",
        "reasoning-model",
        "test-key",
        {
          requireResponsesToolCalling: false,
          skipResponsesProbe: true,
          probeStreaming: false,
        },
      );
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("refuses a custom OpenAI-like endpoint that resolves to a private address before probing (#6293)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "10.0.0.8", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomOpenAiLikeSelection(
          "Custom endpoint",
          "https://public-name.example/v1",
          "model-a",
          "COMPATIBLE_API_KEY",
        ),
      ).resolves.toEqual({ ok: false, retry: "selection" });
      expect(probeOpenAiLikeEndpoint).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("exits non-interactively when a custom Anthropic endpoint resolves to link-local metadata, without probing (#6293)", async () => {
    const originalExitCode = process.exitCode;
    const probeAnthropicEndpoint = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "169.254.169.254", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic",
          "https://metadata-name.example/v1",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).rejects.toThrow("Non-interactive endpoint validation failed.");
      expect(probeAnthropicEndpoint).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      process.exitCode = originalExitCode;
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("probes a custom endpoint that resolves to a public address (#6293)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    await expect(
      helpers.validateCustomOpenAiLikeSelection(
        "Custom endpoint",
        "https://vllm.public.test/v1",
        "model-a",
        "COMPATIBLE_API_KEY",
      ),
    ).resolves.toEqual({ ok: true, api: "openai-completions" });
    // The probe is called with the pinned --resolve args from the preflight, so
    // curl connects to the validated IP instead of re-resolving the hostname.
    expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
      "https://vllm.public.test/v1",
      "model-a",
      "test-key",
      expect.objectContaining({
        resolveArgs: ["--resolve", "vllm.public.test:443:93.184.216.34"],
      }),
    );
  });
});
