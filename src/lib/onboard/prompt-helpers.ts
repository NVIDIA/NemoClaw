// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function step(n: number, total: number, msg: string): void {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

export function getNavigationChoice(value = ""): "back" | "exit" | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

export function exitOnboardFromPrompt(): never {
  console.log("  Exiting onboarding.");
  process.exit(1);
}

export function isAffirmativeAnswer(value: string | null | undefined): boolean {
  return ["y", "yes"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

export interface PromptHelperDeps {
  isNonInteractive(): boolean;
  note(message: string): void;
  prompt(question: string): Promise<string>;
}

// Prompt wrapper: returns env var value or default in non-interactive mode,
// otherwise prompts the user interactively.
export async function promptOrDefault(
  deps: PromptHelperDeps,
  question: string,
  envVar: string | null,
  defaultValue: string,
): Promise<string> {
  if (deps.isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    const result = val || defaultValue;
    deps.note(`  [non-interactive] ${question.trim()} → ${result}`);
    return result;
  }
  return deps.prompt(question);
}

// Yes/no prompt with a typed default. The `[Y/n]` / `[y/N]` indicator and
// the non-interactive echo letter are both derived from `defaultIsYes`, so
// the case of the indicator and the echoed default cannot drift apart.
// Returns a boolean — callers no longer have to parse reply strings.
// Replies of "y"/"yes" and "n"/"no" win regardless of case; empty and
// unknown input fall back to the default.
export async function promptYesNoOrDefault(
  deps: PromptHelperDeps,
  question: string,
  envVar: string | null,
  defaultIsYes: boolean,
): Promise<boolean> {
  const fullQuestion = `${question} ${defaultIsYes ? "[Y/n]" : "[y/N]"}: `;
  const nonInteractive = deps.isNonInteractive();
  const input = nonInteractive ? (envVar ? process.env[envVar] : null) : await deps.prompt(fullQuestion);

  const value = String(input ?? "")
    .trim()
    .toLowerCase();
  let chosen = defaultIsYes;
  if (value === "y" || value === "yes") chosen = true;
  else if (value === "n" || value === "no") chosen = false;

  if (nonInteractive) {
    deps.note(`  [non-interactive] ${fullQuestion.trim()} → ${chosen ? "Y" : "N"}`);
  }
  return chosen;
}
