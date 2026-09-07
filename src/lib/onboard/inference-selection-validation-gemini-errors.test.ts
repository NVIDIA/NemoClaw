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
    const providerDefaultModel = "gemini-fixture-default";
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
          { provider: "gemini-api", providerDefaultModel, skipResponsesProbe: true },
        ),
      ).rejects.toMatchObject(resumableValidationExit);
      expect(promptValidationRecovery).not.toHaveBeenCalled();
      expect(teardownOrphanManagedGatewayOnAbort).toHaveBeenCalledOnce();
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain("Validation probe summary: Chat Completions API: HTTP 400.");
      expect(errorOutput).toContain(
        `Retry the original command with \`NEMOCLAW_MODEL=${providerDefaultModel}\`.`,
      );
      expect(errorOutput).toContain("OpenAI-compatible function-calling access");
      expect(errorOutput).not.toContain(apiKey);
      expect(errorOutput).not.toContain("provider response echoed");
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
    }
  });

  it("does not recommend the selected Gemini default again (#11141)", async () => {
    const providerDefaultModel = "gemini-fixture-default";
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 400, curlStatus: 0 }],
    }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "NemoHermes",
      getCredential: () => "gemini-test-secret",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "Google Gemini",
          "https://generativelanguage.googleapis.com/v1beta/openai",
          providerDefaultModel,
          "GEMINI_API_KEY",
          undefined,
          undefined,
          { provider: "gemini-api", providerDefaultModel, skipResponsesProbe: true },
        ),
      ).resolves.toEqual({ ok: false, retry: "selection" });
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain("already the configured Gemini default");
      expect(errorOutput).toContain("OpenAI-compatible function-calling access");
      expect(errorOutput).not.toContain(`NEMOCLAW_MODEL=${providerDefaultModel}`);
    } finally {
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
          {
            provider: "gemini-api",
            providerDefaultModel: "gemini-fixture-default",
            skipResponsesProbe: true,
          },
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

  it("does not print Gemini guidance for another provider's HTTP 400 (#11141)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 400, curlStatus: 0 }],
    }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "openai-test-secret",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "OpenAI",
          "https://api.openai.example/v1",
          "gpt-test",
          "OPENAI_API_KEY",
          undefined,
          undefined,
          {
            provider: "openai-api",
            providerDefaultModel: "gemini-fixture-default",
            skipResponsesProbe: true,
          },
        ),
      ).resolves.toEqual({ ok: false, retry: "selection" });
      expect(promptValidationRecovery).toHaveBeenCalledWith(
        "OpenAI",
        { kind: "unknown", retry: "selection" },
        "OPENAI_API_KEY",
        null,
        undefined,
      );
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).not.toContain("Google rejected");
      expect(errorOutput).not.toContain("configured Gemini default");
      expect(errorOutput).not.toContain("NEMOCLAW_MODEL=");
    } finally {
      error.mockRestore();
    }
  });
});
