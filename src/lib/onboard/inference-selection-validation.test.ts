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
});
