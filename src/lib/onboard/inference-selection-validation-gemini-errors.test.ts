// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { requireValue } from "../core/require-value";
import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";
import { createRemoteModelValidator, type SetupNimSelectionState } from "./setup-nim-selection";

const resumableValidationExit = {
  code: 1,
  name: "OnboardDeferredExitError",
  preserveIncompleteSession: true,
};

describe("Gemini inference selection validation errors", () => {
  it("distinguishes a runtime 404 from native model catalog validation (#9298)", async () => {
    const apiKey = "gemini-test-secret";
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 404, curlStatus: 0 }],
    }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => apiKey,
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

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
      ).resolves.toEqual({ ok: false, retry: "selection" });
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain(
        "This 404 came from Google's OpenAI-compatible Chat Completions runtime route, not the native /v1beta/models catalog.",
      );
      expect(errorOutput).toContain("the sandbox uses that Chat Completions route at runtime");
      expect(errorOutput).not.toContain(apiKey);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

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
    const credentialEnv = "GEMINI_FIXTURE_API_KEY";
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
          credentialEnv,
          undefined,
          undefined,
          {
            provider: "gemini-api",
            providerDefaultModel: "gemini-fixture-default",
            skipResponsesProbe: true,
          },
        ),
      ).resolves.toEqual({ ok: false, retry: "credential" });
      expect(promptValidationRecovery).toHaveBeenCalledWith(
        "Google Gemini",
        { kind: "credential", retry: "credential" },
        credentialEnv,
        null,
        undefined,
      );
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain(`Verify or rotate \`${credentialEnv}\``);
      expect(errorOutput).not.toContain("GEMINI_API_KEY");
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

  it("carries provider metadata through the real validator into HTTP 400 guidance (#11141)", async () => {
    const selectedModel = "gemini-selected-model";
    const providerDefaultModel = "gemini-fixture-default";
    const endpointUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    const state: SetupNimSelectionState = {
      model: selectedModel,
      provider: "gemini-api",
      endpointUrl,
      credentialEnv: "GEMINI_FIXTURE_API_KEY",
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: null,
      nimContainer: null,
      allowToolsIncompatible: false,
    };
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const validationHelpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "NemoHermes",
      getCredential: () => "gemini-test-secret",
      probeOpenAiLikeEndpoint: () => ({
        ok: false,
        failures: [{ name: "Chat Completions API", httpStatus: 400, curlStatus: 0 }],
      }),
      promptValidationRecovery,
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator({
      OPENAI_ENDPOINT_URL: "https://default-openai.example/v1",
      ANTHROPIC_ENDPOINT_URL: "https://default-anthropic.example/v1",
      requireValue,
      isBackToSelection: (_value): _value is never => false,
      validateCustomOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
      validateCustomAnthropicSelection: async () => ({ ok: false, retry: "selection" }),
      validateAnthropicSelectionWithRetryMessage: async () => ({
        ok: false,
        retry: "selection",
      }),
      validateOpenAiLikeSelection: validationHelpers.validateOpenAiLikeSelection,
      shouldRequireResponsesToolCalling: () => true,
      shouldSkipResponsesProbe: () => true,
      getProbeAuthMode: () => undefined,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        validateSelectedRemoteModel({
          selected: { key: "gemini" },
          remoteConfig: {
            label: "Google Gemini",
            endpointUrl,
            helpUrl: null,
            defaultModel: providerDefaultModel,
          },
          state,
          selectedCredentialEnv: "GEMINI_FIXTURE_API_KEY",
        }),
      ).resolves.toBe("retry-selection");
      expect(state.model).toBe(selectedModel);
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain(`NEMOCLAW_MODEL=${providerDefaultModel}`);
      expect(errorOutput).not.toContain("NEMOCLAW_MODEL=gemini-3.6-flash");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
