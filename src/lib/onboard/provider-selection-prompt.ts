// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderMenuChoice } from "./provider-menu";

export interface PromptForInferenceProviderSelectionInput<T extends ProviderMenuChoice> {
  options: T[];
  vllmRunning: boolean;
  ollamaRunning: boolean;
  env?: NodeJS.ProcessEnv;
  prompt(question: string): Promise<string>;
  log(message?: string): void;
  selectFromNumberedMenu(rawChoice: string, defaultIdx: number, options: T[]): T;
}

function getDefaultProviderIndex(options: ProviderMenuChoice[], env: NodeJS.ProcessEnv): number {
  const envProviderHint = (env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  const envProviderIdx = envProviderHint
    ? options.findIndex((option) => option.key.toLowerCase() === envProviderHint)
    : -1;
  return (
    (envProviderIdx >= 0 ? envProviderIdx : options.findIndex((option) => option.key === "build")) +
    1
  );
}

function getDetectedLocalInferenceSuggestions(input: {
  vllmRunning: boolean;
  ollamaRunning: boolean;
}): string[] {
  const suggestions: string[] = [];
  if (input.vllmRunning) suggestions.push("vLLM");
  if (input.ollamaRunning) suggestions.push("Ollama");
  return suggestions;
}

export async function promptForInferenceProviderSelection<T extends ProviderMenuChoice>(
  input: PromptForInferenceProviderSelectionInput<T>,
): Promise<T> {
  const suggestions = getDetectedLocalInferenceSuggestions(input);
  if (suggestions.length > 0) {
    input.log(
      `  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`,
    );
    input.log("");
  }

  input.log("");
  input.log("  Select your inference provider:");
  input.options.forEach((option, index) => {
    input.log(`    ${index + 1}) ${option.label}`);
  });
  input.log("");

  const defaultIdx = getDefaultProviderIndex(input.options, input.env ?? process.env);
  const choice = await input.prompt(`  Choose [${defaultIdx}]: `);
  return input.selectFromNumberedMenu(choice, defaultIdx, input.options);
}
