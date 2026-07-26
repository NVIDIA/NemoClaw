// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ChatCompletionChoice = {
  message?: {
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
  };
  text?: unknown;
};

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Require an OpenAI-compatible completion body that proves inference.local
 * reached a model. Reasoning models can exhaust a small output budget before
 * emitting final content, so reasoning-only completions remain valid for this
 * connectivity check.
 */
export function requireInferenceLocalCompletionText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("inference.local response was not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("inference.local response was not an object");
  }

  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("inference.local response did not contain a completion choice");
  }

  for (const candidate of choices) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const choice = candidate as ChatCompletionChoice;
    const message = choice.message;
    if (message && typeof message === "object") {
      for (const value of [message.content, message.reasoning_content, message.reasoning]) {
        const completionText = nonEmptyText(value);
        if (completionText) return completionText;
      }
    }
    const legacyText = nonEmptyText(choice.text);
    if (legacyText) return legacyText;
  }

  throw new Error("inference.local response did not contain non-empty content or reasoning text");
}
