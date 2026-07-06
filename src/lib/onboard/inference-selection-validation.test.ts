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

  it("requests streaming validation for OpenClaw custom Anthropic endpoints (#6289)", async () => {
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: true,
      api: "anthropic-messages",
      label: "Anthropic Messages API",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic endpoint",
          "https://compatible.example",
          "nvidia/nemotron-3-super-v3",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).resolves.toEqual({ ok: true, api: "anthropic-messages" });
      expect(probeAnthropicEndpoint).toHaveBeenCalledWith(
        "https://compatible.example",
        "nvidia/nemotron-3-super-v3",
        "test-key",
        { probeStreaming: true },
      );
    } finally {
      log.mockRestore();
    }
  });

  it("validates Hermes custom Anthropic routes on their intended Chat Completions surface (#6289)", async () => {
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: false,
      message: "duplicate message_start",
      failures: [
        {
          name: "Anthropic Messages API (streaming)",
          httpStatus: 200,
          curlStatus: 0,
          message: "duplicate message_start",
        },
      ],
    }));
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
      label: "Chat Completions API",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "Hermes",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic endpoint",
          "https://compatible.example",
          "nvidia/nemotron-3-super-v3",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          null,
          { intendedApi: "openai-completions" },
        ),
      ).resolves.toEqual({ ok: true, api: "openai-completions" });
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
        "https://compatible.example/v1",
        "nvidia/nemotron-3-super-v3",
        "test-key",
        { skipResponsesProbe: true },
      );
      expect(probeAnthropicEndpoint).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("skips Anthropic streaming validation in reasoning mode", async () => {
    vi.stubEnv("NEMOCLAW_REASONING", "yes");
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: true,
      api: "anthropic-messages",
      label: "Anthropic Messages API",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });

    try {
      await helpers.validateCustomAnthropicSelection(
        "Custom Anthropic endpoint",
        "https://compatible.example",
        "reasoning-model",
        "COMPATIBLE_ANTHROPIC_API_KEY",
      );
      expect(probeAnthropicEndpoint).toHaveBeenCalledWith(
        "https://compatible.example",
        "reasoning-model",
        "test-key",
        { probeStreaming: false },
      );
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("keeps rejecting malformed native Anthropic streams for OpenClaw (#6289)", async () => {
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: false,
      message:
        "Anthropic Messages API (streaming): Anthropic Messages streaming on this endpoint " +
        "emits duplicate message_start (2 events for one request).",
      failures: [
        {
          name: "Anthropic Messages API (streaming)",
          httpStatus: 200,
          curlStatus: 0,
          message: "duplicate message_start",
          diagnosticCodes: ["anthropic-streaming-duplicate-message-start"],
        },
      ],
    }));
    const promptValidationRecovery = vi.fn(async () => "model" as const);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery,
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic endpoint",
          "https://compatible.example",
          "nvidia/nemotron-3-super-v3",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).resolves.toEqual({ ok: false, retry: "model" });
      expect(promptValidationRecovery).toHaveBeenCalledOnce();
      expect(error.mock.calls.map((args) => args.join(" ")).join("\n")).toContain(
        "Custom Anthropic endpoint endpoint validation failed.",
      );
      expect(error.mock.calls.map((args) => args.join(" ")).join("\n")).toContain(
        "Anthropic Messages API (streaming): duplicate message_start",
      );
    } finally {
      error.mockRestore();
    }
  });
});
