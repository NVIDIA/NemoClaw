// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as credentials from "../credentials/store";
import { BACK_TO_SELECTION, type BackToSelection, isBackToSelection } from "../navigation";

export type BackNavigationResult = BackToSelection | { kind: "back" };
export type { BackToSelection };
export { BACK_TO_SELECTION, isBackToSelection };

export function getNavigationChoice(value = ""): "back" | "exit" | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

export function getCredentialPromptNavigation(intent: unknown): "back" | "exit" | null {
  if (!intent || typeof intent !== "object") return null;
  const kind = (intent as { kind?: unknown }).kind;
  if (kind === "back" || kind === "exit") return kind;
  return null;
}

export function printReturningToProviderSelection(): void {
  console.log("  Returning to provider selection.");
  console.log("");
}

export function shouldReturnToProviderSelection(
  result: unknown,
  exitOnboardFromPrompt: () => never,
): boolean {
  const navigation = getCredentialPromptNavigation(result);
  if (navigation === "exit") exitOnboardFromPrompt();
  return navigation === "back" || isBackToSelection(result);
}

export function returningToProviderSelection(
  result: unknown,
  exitOnboardFromPrompt: () => never,
): result is BackNavigationResult {
  if (!shouldReturnToProviderSelection(result, exitOnboardFromPrompt)) return false;
  printReturningToProviderSelection();
  return true;
}

export async function readCredentialValue(
  question: string,
  exitOnboardFromPrompt: () => never,
): Promise<string | BackToSelection> {
  while (true) {
    const input = await credentials.readCredentialPrompt(question, credentials.prompt);
    if (shouldReturnToProviderSelection(input, exitOnboardFromPrompt)) return BACK_TO_SELECTION;
    if (input.kind === "help") {
      console.log("  Type back to choose a different provider, or exit to quit.");
      continue;
    }
    return input.kind === "credential" ? input.value : "";
  }
}

export async function replaceNamedCredential({
  envName,
  label,
  helpUrl = null,
  validator = null,
  exitOnboardFromPrompt,
}: {
  envName: string;
  label: string;
  helpUrl?: string | null;
  validator?: ((value: string) => string | null) | null;
  exitOnboardFromPrompt: () => never;
}): Promise<string | BackToSelection> {
  if (helpUrl) {
    console.log("");
    console.log(`  Get your ${label} from: ${helpUrl}`);
    console.log("");
  }

  while (true) {
    const key = await readCredentialValue(`  ${label}: `, exitOnboardFromPrompt);
    if (isBackToSelection(key)) return key;
    if (!key) {
      console.error(`  ${label} is required.`);
      continue;
    }
    const validationError = typeof validator === "function" ? validator(key) : null;
    if (validationError) {
      console.error(validationError);
      continue;
    }
    credentials.saveCredential(envName, key);
    process.env[envName] = key;
    console.log("");
    console.log("  Credential staged. Onboarding will register it with the OpenShell gateway.");
    console.log("");
    return key;
  }
}

export async function ensureNamedCredential({
  envName,
  label,
  helpUrl = null,
  exitOnboardFromPrompt,
}: {
  envName: string | null;
  label: string;
  helpUrl?: string | null;
  exitOnboardFromPrompt: () => never;
}): Promise<string | BackToSelection> {
  if (!envName) {
    console.error(`  Missing credential target for ${label}.`);
    process.exit(1);
  }
  const key = credentials.getCredential(envName);
  if (key) {
    process.env[envName] = key;
    return key;
  }
  return replaceNamedCredential({ envName, label, helpUrl, exitOnboardFromPrompt });
}

export function createCredentialPromptHelpers(exitOnboardFromPrompt: () => never): {
  readValue: (question: string) => Promise<string | BackToSelection>;
  replaceNamedCredential: (
    envName: string,
    label: string,
    helpUrl?: string | null,
    validator?: ((value: string) => string | null) | null,
  ) => Promise<string | BackToSelection>;
  ensureNamedCredential: (
    envName: string | null,
    label: string,
    helpUrl?: string | null,
  ) => Promise<string | BackToSelection>;
  shouldReturnToProviderSelection: (result: unknown) => boolean;
  returningToProviderSelection: (result: unknown) => result is BackNavigationResult;
} {
  return {
    readValue: (question) => readCredentialValue(question, exitOnboardFromPrompt),
    replaceNamedCredential: (envName, label, helpUrl = null, validator = null) =>
      replaceNamedCredential({ envName, label, helpUrl, validator, exitOnboardFromPrompt }),
    ensureNamedCredential: (envName, label, helpUrl = null) =>
      ensureNamedCredential({ envName, label, helpUrl, exitOnboardFromPrompt }),
    shouldReturnToProviderSelection: (result) =>
      shouldReturnToProviderSelection(result, exitOnboardFromPrompt),
    returningToProviderSelection: (result) =>
      returningToProviderSelection(result, exitOnboardFromPrompt),
  };
}
