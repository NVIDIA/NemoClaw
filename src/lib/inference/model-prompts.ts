// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLOUD_MODEL_OPTIONS, HERMES_PROVIDER_MODEL_OPTIONS } from "./config";
import { isSafeModelId } from "../validation";
import { validateNvidiaEndpointModel } from "./provider-models";

// credentials.ts still uses CommonJS-style exports.
const { getCredential, prompt } = require("../credentials/store");

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
  hermesProvider: [...HERMES_PROVIDER_MODEL_OPTIONS],
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
  /** Pre-fill this model ID as the default in interactive prompts. */
  defaultModelId?: string;
  /** Show only this many remote models in the first menu before offering Other. */
  topLevelModelLimit?: number;
  /** When true, Other opens the full model list before falling back to manual entry. */
  otherShowsFullList?: boolean;
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
  const defaultModelId = options.defaultModelId ?? "";

  // Find if the default matches a curated option
  const defaultCuratedIdx = defaultModelId
    ? deps.cloudModelOptions.findIndex((o) => o.id === defaultModelId)
    : -1;
  // Default list selection: match defaultModelId, or fall back to first option (index 0)
  const defaultListChoice = defaultCuratedIdx >= 0 ? defaultCuratedIdx + 1 : 1;

  deps.writeLine("");
  deps.writeLine("  Cloud models:");
  deps.cloudModelOptions.forEach((option, index) => {
    deps.writeLine(`    ${index + 1}) ${option.label} (${option.id})`);
  });
  deps.writeLine(`    ${deps.cloudModelOptions.length + 1}) Other...`);
  deps.writeLine("");

  const choice = await deps.promptFn(`  Choose model [${defaultListChoice}]: `);
  const navigation = deps.getNavigationChoiceFn(choice);
  if (navigation === "back") {
    return deps.backToSelection;
  }
  if (navigation === "exit") {
    deps.exitFn();
  }
  const index = parseInt(choice || String(defaultListChoice), 10) - 1;
  if (Number.isFinite(index) && index >= 0 && index < deps.cloudModelOptions.length) {
    return deps.cloudModelOptions[index].id;
  }

  const nvidiaApiKey = deps.getCredentialFn("NVIDIA_API_KEY");
  if (!nvidiaApiKey) {
    deps.errorLine("  NVIDIA_API_KEY is required before validating a custom NVIDIA Endpoints model.");
    return deps.backToSelection;
  }

  // If default is a custom (non-curated) model ID, pre-fill it in the manual prompt
  const manualDefault = defaultCuratedIdx < 0 && defaultModelId && isSafeModelId(defaultModelId) ? defaultModelId : "";
  const manualLabel = manualDefault
    ? `  NVIDIA Endpoints model id [${manualDefault}]: `
    : "  NVIDIA Endpoints model id: ";
  return promptManualModelId(
    manualLabel,
    "NVIDIA Endpoints",
    (model) => deps.validateNvidiaEndpointModelFn(model, nvidiaApiKey),
    { ...deps, promptFn: async (q) => (await deps.promptFn(q)) || manualDefault },
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
  const defaultIndex = modelOptions.indexOf(defaultModel);
  const topLevelLimit =
    options.topLevelModelLimit && options.topLevelModelLimit > 0
      ? Math.min(options.topLevelModelLimit, modelOptions.length)
      : modelOptions.length;
  const shouldOfferFullList =
    options.otherShowsFullList === true && topLevelLimit < modelOptions.length;
  const visibleOptions = modelOptions.slice(0, topLevelLimit);
  const currentDefaultChoice =
    defaultIndex >= 0
      ? defaultIndex + 1
      : defaultModel && isSafeModelId(defaultModel)
        ? visibleOptions.length + 2
        : null;
  const defaultChoice =
    currentDefaultChoice ??
    Math.min(Math.max(visibleOptions.length, 1), visibleOptions.length + 1);

  deps.writeLine("");
  deps.writeLine(`  ${label} models:`);
  visibleOptions.forEach((option, index) => {
    deps.writeLine(`    ${index + 1}) ${option}`);
  });
  deps.writeLine(`    ${visibleOptions.length + 1}) Other...`);
  if (currentDefaultChoice !== null && currentDefaultChoice > visibleOptions.length + 1) {
    deps.writeLine(`    ${currentDefaultChoice}) ${defaultModel} (current)`);
  }
  deps.writeLine("");

  const choice = await deps.promptFn(`  Choose model [${defaultChoice}]: `);
  const navigation = deps.getNavigationChoiceFn(choice);
  if (navigation === "back") {
    return deps.backToSelection;
  }
  if (navigation === "exit") {
    deps.exitFn();
  }
  const index = parseInt(choice || String(defaultChoice), 10) - 1;
  if (currentDefaultChoice !== null && index === currentDefaultChoice - 1) {
    return defaultModel;
  }
  if (Number.isFinite(index) && index >= 0 && index < visibleOptions.length) {
    return visibleOptions[index];
  }
  if (index === visibleOptions.length) {
    return shouldOfferFullList
      ? promptFullRemoteModelList(label, modelOptions, defaultModel, validator, deps)
      : promptManualModelId(`  ${label} model id: `, label, validator, deps);
  }

  return promptManualModelId(`  ${label} model id: `, label, validator, deps);
}

async function promptFullRemoteModelList(
  label: string,
  modelOptions: string[],
  defaultModel: string,
  validator: ((model: string) => PromptValidationResult) | null,
  options: ModelPromptOptions,
): Promise<string> {
  const deps = resolvePromptOptions(options);
  const defaultIndex = Math.max(0, modelOptions.indexOf(defaultModel));

  deps.writeLine("");
  deps.writeLine(`  ${label} full model list:`);
  modelOptions.forEach((option, index) => {
    deps.writeLine(`    ${index + 1}) ${option}`);
  });
  deps.writeLine(`    ${modelOptions.length + 1}) Custom model id...`);
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
