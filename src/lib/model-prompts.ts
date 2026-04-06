// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLOUD_MODEL_OPTIONS } from "./inference-config";
import { isSafeModelId } from "./validation";
import { validateNvidiaEndpointModel } from "./provider-models";

// credentials.js is CJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getCredential, prompt } = require("../../bin/lib/credentials");

export const BACK_TO_SELECTION = "__NEMOCLAW_BACK_TO_SELECTION__";

export const REMOTE_MODEL_OPTIONS: Record<string, string[]> = {
  openai: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro-2026-03-05"],
  anthropic: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
};

export interface PromptValidationResult {
  ok: boolean;
  message?: string;
  deferValidation?: boolean;
}

export interface ModelPromptOptions {
  promptFn?: (question: string) => Promise<string>;
  errorLine?: (message: string) => void;
  writeLine?: (message: string) => void;
  exitFn?: () => never;
  getNavigationChoiceFn?: (value?: string) => "back" | "exit" | null;
  getCredentialFn?: (envName: string) => string | null;
  validateNvidiaEndpointModelFn?: (model: string, apiKey: string) => PromptValidationResult;
  cloudModelOptions?: Array<{ id: string; label: string }>;
  remoteModelOptions?: Record<string, string[]>;
  backToSelection?: string;
}

function getNavigationChoice(value = ""): "back" | "exit" | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

function exitOnboardFromPrompt(): never {
  console.log("  Exiting onboarding.");
  process.exit(1);
}

function shouldDeferValidationFailure(validation: PromptValidationResult): boolean {
  return (
    validation.deferValidation === true ||
    /^Could not validate model against /i.test(String(validation.message || ""))
  );
}

function resolvePromptOptions(options: ModelPromptOptions = {}) {
  return {
    promptFn: options.promptFn ?? prompt,
    errorLine: options.errorLine ?? console.error,
    writeLine: options.writeLine ?? console.log,
    exitFn: options.exitFn ?? exitOnboardFromPrompt,
    getNavigationChoiceFn: options.getNavigationChoiceFn ?? getNavigationChoice,
    getCredentialFn: options.getCredentialFn ?? getCredential,
    validateNvidiaEndpointModelFn:
      options.validateNvidiaEndpointModelFn ?? validateNvidiaEndpointModel,
    cloudModelOptions: options.cloudModelOptions ?? CLOUD_MODEL_OPTIONS,
    remoteModelOptions: options.remoteModelOptions ?? REMOTE_MODEL_OPTIONS,
    backToSelection: options.backToSelection ?? BACK_TO_SELECTION,
  };
}

export async function promptManualModelId(
  promptLabel: string,
  errorLabel: string,
  validator: ((model: string) => PromptValidationResult) | null = null,
  options: ModelPromptOptions = {},
): Promise<string> {
  const deps = resolvePromptOptions(options);
  while (true) {
    const manual = await deps.promptFn(promptLabel);
    const trimmed = manual.trim();
    const navigation = deps.getNavigationChoiceFn(trimmed);
    if (navigation === "back") {
      return deps.backToSelection;
    }
    if (navigation === "exit") {
      deps.exitFn();
    }
    if (!trimmed || !isSafeModelId(trimmed)) {
      deps.errorLine(`  Invalid ${errorLabel} model id.`);
      continue;
    }
    if (validator) {
      const validation = validator(trimmed);
      if (!validation.ok) {
        if (validation.message) {
          deps.errorLine(`  ${validation.message}`);
        }
        if (shouldDeferValidationFailure(validation)) {
          return trimmed;
        }
        continue;
      }
    }
    return trimmed;
  }
}

export async function promptCloudModel(options: ModelPromptOptions = {}): Promise<string> {
  const deps = resolvePromptOptions(options);

  deps.writeLine("");
  deps.writeLine("  Cloud models:");
  deps.cloudModelOptions.forEach((option, index) => {
    deps.writeLine(`    ${index + 1}) ${option.label} (${option.id})`);
  });
  deps.writeLine(`    ${deps.cloudModelOptions.length + 1}) Other...`);
  deps.writeLine("");

  const choice = await deps.promptFn("  Choose model [1]: ");
  const navigation = deps.getNavigationChoiceFn(choice);
  if (navigation === "back") {
    return deps.backToSelection;
  }
  if (navigation === "exit") {
    deps.exitFn();
  }
  const index = parseInt(choice || "1", 10) - 1;
  if (Number.isFinite(index) && index >= 0 && index < deps.cloudModelOptions.length) {
    return deps.cloudModelOptions[index].id;
  }

  const nvidiaApiKey = deps.getCredentialFn("NVIDIA_API_KEY");
  if (!nvidiaApiKey) {
    deps.errorLine("  NVIDIA_API_KEY is required before validating a custom NVIDIA Endpoints model.");
    return deps.backToSelection;
  }

  return promptManualModelId(
    "  NVIDIA Endpoints model id: ",
    "NVIDIA Endpoints",
    (model) => deps.validateNvidiaEndpointModelFn(model, nvidiaApiKey),
    deps,
  );
}

export async function promptRemoteModel(
  label: string,
  providerKey: string,
  defaultModel: string,
  validator: ((model: string) => PromptValidationResult) | null = null,
  options: ModelPromptOptions = {},
): Promise<string> {
  const deps = resolvePromptOptions(options);
  const modelOptions = deps.remoteModelOptions[providerKey] || [];
  const defaultIndex = Math.max(0, modelOptions.indexOf(defaultModel));

  deps.writeLine("");
  deps.writeLine(`  ${label} models:`);
  modelOptions.forEach((option, index) => {
    deps.writeLine(`    ${index + 1}) ${option}`);
  });
  deps.writeLine(`    ${modelOptions.length + 1}) Other...`);
  deps.writeLine("");

  const choice = await deps.promptFn(`  Choose model [${defaultIndex + 1}]: `);
  const navigation = deps.getNavigationChoiceFn(choice);
  if (navigation === "back") {
    return deps.backToSelection;
  }
  if (navigation === "exit") {
    deps.exitFn();
  }
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  if (Number.isFinite(index) && index >= 0 && index < modelOptions.length) {
    return modelOptions[index];
  }

  return promptManualModelId(`  ${label} model id: `, label, validator, deps);
}

export async function promptInputModel(
  label: string,
  defaultModel: string,
  validator: ((model: string) => PromptValidationResult) | null = null,
  options: ModelPromptOptions = {},
): Promise<string> {
  const deps = resolvePromptOptions(options);
  while (true) {
    const value = await deps.promptFn(`  ${label} model [${defaultModel}]: `);
    const navigation = deps.getNavigationChoiceFn(value);
    if (navigation === "back") {
      return deps.backToSelection;
    }
    if (navigation === "exit") {
      deps.exitFn();
    }
    const trimmed = (value || defaultModel).trim();
    if (!trimmed || !isSafeModelId(trimmed)) {
      deps.errorLine(`  Invalid ${label} model id.`);
      continue;
    }
    if (validator) {
      const validation = validator(trimmed);
      if (!validation.ok) {
        if (validation.message) {
          deps.errorLine(`  ${validation.message}`);
        }
        if (shouldDeferValidationFailure(validation)) {
          return trimmed;
        }
        continue;
      }
    }
    return trimmed;
  }
}
