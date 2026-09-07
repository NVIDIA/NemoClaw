// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";

const resumableValidationExit = {
  code: 1,
  name: "OnboardDeferredExitError",
  preserveIncompleteSession: true,
};

describe("Gemini inference selection validation errors", () => {
  it("prints redaction-safe HTTP 400 recovery before non-interactive exit (#11141)", async () => {
    const originalExitCode = process.exitCode;
    const apiKey = "gemini-test-secret";
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      message: `Chat Completions API: HTTP 400: rejected ${apiKey}`,
      failures: [
        {
          name: "Chat Completions API",
          httpStatus: 400,
          curlStatus: 0,
          message: `HTTP 400: request contains an invalid argument ${apiKey}`,
          body: `provider response echoed ${apiKey}`,
        },
      ],
    }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const teardownOrphanManagedGatewayOnAbort = vi.fn(() => true);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "NemoHermes",
      getCredential: () => apiKey,
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      teardownOrphanManagedGatewayOnAbort,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "Google Gemini",
          "https://generativelanguage.googleapis.com/v1beta/openai",
          "gemini-2.5-flash",
          "GEMINI_API_KEY",
          undefined,
          undefined,
          { provider: "gemini-api", skipResponsesProbe: true },
        ),
      ).rejects.toMatchObject(resumableValidationExit);
      expect(promptValidationRecovery).not.toHaveBeenCalled();
      expect(teardownOrphanManagedGatewayOnAbort).toHaveBeenCalledOnce();
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain("Validation probe summary: Chat Completions API: HTTP 400.");
      expect(errorOutput).toContain(
        "Retry the original command with `NEMOCLAW_MODEL=gemini-3.6-flash`.",
      );
      expect(errorOutput).toContain("OpenAI-compatible function-calling access");
      expect(errorOutput).not.toContain(apiKey);
      expect(errorOutput).not.toContain("provider response echoed");
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
    }
  });

  it("routes an HTTP 400 credential response to credential recovery (#11141)", async () => {
    const apiKey = "gemini-test-secret";
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      failures: [
        {
          name: "Chat Completions API",
          httpStatus: 400,
          curlStatus: 0,
          message: `HTTP 400: API key expired ${apiKey}`,
          body: `provider response echoed ${apiKey}`,
        },
      ],
    }));
    const promptValidationRecovery = vi.fn(async () => "credential" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "NemoHermes",
      getCredential: () => apiKey,
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "Google Gemini",
          "https://generativelanguage.googleapis.com/v1beta/openai",
          "gemini-2.5-flash",
          "GEMINI_API_KEY",
          undefined,
          undefined,
          { provider: "gemini-api", skipResponsesProbe: true },
        ),
      ).resolves.toEqual({ ok: false, retry: "credential" });
      expect(promptValidationRecovery).toHaveBeenCalledOnce();
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain("Verify or rotate `GEMINI_API_KEY`");
      expect(errorOutput).not.toContain("NEMOCLAW_MODEL=gemini-3.6-flash");
      expect(errorOutput).not.toContain(apiKey);
      expect(errorOutput).not.toContain("provider response echoed");
    } finally {
      error.mockRestore();
    }
  });
});
