// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential, prompt, saveCredential } from "../../../credentials/store";
import type { MessagingHookRegistration } from "../types";
import { type ConfigPromptHookOptions, createConfigPromptHookRegistration } from "./config-prompt";
import { createStaticOutputsHookRegistration } from "./static-outputs";
import { createTokenPasteHookRegistration, type TokenPasteHookOptions } from "./token-paste";

export interface CommonHookOptions extends TokenPasteHookOptions {
  readonly tokenPaste?: TokenPasteHookOptions;
  readonly configPrompt?: ConfigPromptHookOptions;
}

export function createCommonHookRegistrations(
  options: CommonHookOptions = {},
): readonly MessagingHookRegistration[] {
  const resolvedOptions = mergeCommonHookOptions(defaultCommonHookOptions(), options);
  const tokenPasteOptions = {
    ...resolvedOptions,
    ...resolvedOptions.tokenPaste,
  };
  const configPromptOptions = {
    env: resolvedOptions.env,
    prompt: resolvedOptions.prompt,
    log: resolvedOptions.log,
    ...resolvedOptions.configPrompt,
  };

  return [
    createStaticOutputsHookRegistration(),
    createTokenPasteHookRegistration(tokenPasteOptions),
    createConfigPromptHookRegistration(configPromptOptions),
  ] as const;
}

export const COMMON_HOOK_REGISTRATIONS: readonly MessagingHookRegistration[] =
  createCommonHookRegistrations();

function defaultCommonHookOptions(): CommonHookOptions {
  return {
    getCredential,
    saveCredential,
    prompt,
    tokenPaste: {
      log: logMessage,
    },
    configPrompt: {
      log: logMessage,
    },
  };
}

function mergeCommonHookOptions(
  defaults: CommonHookOptions,
  options: CommonHookOptions,
): CommonHookOptions {
  const base = {
    ...defaults,
    ...options,
  };
  const inheritedLog = options.log ? { log: options.log } : {};
  return {
    ...base,
    tokenPaste: {
      ...defaults.tokenPaste,
      ...inheritedLog,
      ...options.tokenPaste,
    },
    configPrompt: {
      ...defaults.configPrompt,
      ...inheritedLog,
      ...options.configPrompt,
    },
  };
}

function logMessage(message: string): void {
  console.log(message);
}

export * from "./config-prompt";
export * from "./static-outputs";
export * from "./token-paste";
