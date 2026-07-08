// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { selectBedrockRuntimeCustomAnthropic } from "./bedrock-runtime";
import { BACK_TO_SELECTION } from "./credential-navigation";

const BEDROCK_URL = "https://bedrock-runtime.us-east-1.amazonaws.com";

function createBedrockRuntimeDependencies() {
  return {
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`EXIT_CALLED:${code}`);
    }),
    error: vi.fn(),
    log: vi.fn(),
  };
}

function clearBedrockAuthEnv(): void {
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  delete process.env.COMPATIBLE_ANTHROPIC_API_KEY;
}

afterEach(() => {
  clearBedrockAuthEnv();
  vi.restoreAllMocks();
});

describe("Bedrock Runtime onboarding helper", () => {
  it("uses the injected exit boundary when non-interactive selection has no auth", async () => {
    clearBedrockAuthEnv();
    const error = vi.fn();
    const log = vi.fn();
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`EXIT_CALLED:${code}`);
    });
    const promptInputModel = vi.fn(async () => "unused-model");
    const replaceNamedCredential = vi.fn(async () => "unused-credential");

    await expect(
      selectBedrockRuntimeCustomAnthropic({
        selectedKey: "anthropicCompatible",
        endpointUrl: BEDROCK_URL,
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        label: "Other Anthropic-compatible endpoint",
        helpUrl: null,
        defaultModel: "anthropic.claude",
        backToSelection: BACK_TO_SELECTION,
        isNonInteractive: () => true,
        promptInputModel,
        replaceNamedCredential,
        error,
        exitProcess,
        log,
      }),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(error).toHaveBeenCalledWith(
      "  AWS_BEARER_TOKEN_BEDROCK, AWS_PROFILE, IAM environment credentials, or an explicitly exported Bedrock-compatible endpoint key is required for a Bedrock Runtime endpoint.",
    );
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
    expect(promptInputModel).not.toHaveBeenCalled();
    expect(replaceNamedCredential).not.toHaveBeenCalled();
  });

  it("prompts for a Bedrock-compatible credential when no explicit AWS auth source exists", async () => {
    clearBedrockAuthEnv();
    const replaceNamedCredential = vi.fn(async () => "bedrock-bearer");
    const promptInputModel = vi.fn(async () => "anthropic.claude");

    const result = await selectBedrockRuntimeCustomAnthropic({
      ...createBedrockRuntimeDependencies(),
      selectedKey: "anthropicCompatible",
      endpointUrl: BEDROCK_URL,
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      label: "Other Anthropic-compatible endpoint",
      helpUrl: null,
      defaultModel: "anthropic.claude",
      backToSelection: BACK_TO_SELECTION,
      isNonInteractive: () => false,
      promptInputModel,
      replaceNamedCredential,
    });

    expect(replaceNamedCredential).toHaveBeenCalledWith(
      "COMPATIBLE_ANTHROPIC_API_KEY",
      "Other Anthropic-compatible endpoint API key",
      null,
    );
    expect(result).toEqual({
      action: "selected",
      model: "anthropic.claude",
      preferredInferenceApi: "openai-completions",
    });
  });

  it("returns to provider selection when the Bedrock-compatible credential prompt chooses back", async () => {
    clearBedrockAuthEnv();
    const replaceNamedCredential = vi.fn(async () => BACK_TO_SELECTION);
    const promptInputModel = vi.fn(async () => {
      throw new Error("model prompt should not run after back navigation");
    });

    const result = await selectBedrockRuntimeCustomAnthropic({
      ...createBedrockRuntimeDependencies(),
      selectedKey: "anthropicCompatible",
      endpointUrl: BEDROCK_URL,
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      label: "Other Anthropic-compatible endpoint",
      helpUrl: null,
      defaultModel: "anthropic.claude",
      backToSelection: BACK_TO_SELECTION,
      isNonInteractive: () => false,
      promptInputModel,
      replaceNamedCredential,
    });

    expect(replaceNamedCredential).toHaveBeenCalledWith(
      "COMPATIBLE_ANTHROPIC_API_KEY",
      "Other Anthropic-compatible endpoint API key",
      null,
    );
    expect(promptInputModel).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "retry-selection" });
  });

  it("accepts an explicit AWS profile without prompting for the compatible endpoint key", async () => {
    clearBedrockAuthEnv();
    process.env.AWS_PROFILE = "bedrock-dev";
    const replaceNamedCredential = vi.fn(async () => "unused");

    const result = await selectBedrockRuntimeCustomAnthropic({
      ...createBedrockRuntimeDependencies(),
      selectedKey: "anthropicCompatible",
      endpointUrl: BEDROCK_URL,
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      label: "Other Anthropic-compatible endpoint",
      helpUrl: null,
      defaultModel: "anthropic.claude",
      backToSelection: BACK_TO_SELECTION,
      isNonInteractive: () => true,
      promptInputModel: vi.fn(async () => {
        throw new Error("non-interactive selection should not prompt");
      }),
      replaceNamedCredential,
    });

    expect(replaceNamedCredential).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: "selected",
      model: "anthropic.claude",
      preferredInferenceApi: "openai-completions",
    });
  });
});
