// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function compactAnswerText(text: string): string {
  return text.replace(/\s+/g, "");
}

export function containsToolCallStructure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsToolCallStructure);

  const record = value as Record<string, unknown>;
  if (
    record.type === "tool_use" ||
    record.type === "function" ||
    record.function != null ||
    record.function_call != null ||
    record.tool_calls != null
  ) {
    return true;
  }
  if (
    typeof record.name === "string" &&
    ["arguments", "description", "input", "input_schema", "parameters"].some((key) => key in record)
  ) {
    return true;
  }
  return Object.values(record).some(containsToolCallStructure);
}

function containsStructuredToolOutput(text: string): boolean {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    return containsToolCallStructure(value);
  } catch {
    return false;
  }
}

function containsToolCallOutput(text: string): boolean {
  const trimmed = text.trim();
  const jsonLike = trimmed.replace(/^```(?:json)?\s*/iu, "");
  const containsJsonToolField =
    /^[{[]/u.test(jsonLike) &&
    (/(?:"(?:function|arguments|parameters|param|input|input_schema|tool_use|tool_calls)")\s*:/u.test(
      jsonLike,
    ) ||
      (/"name"\s*:/u.test(jsonLike) && /"description"\s*:/u.test(jsonLike)));
  return (
    /^tool[ _-]?calls?\s*:/iu.test(trimmed) ||
    containsJsonToolField ||
    containsStructuredToolOutput(trimmed)
  );
}

export function containsAnswer(text: string, answer: string): boolean {
  const compactText = compactAnswerText(text.trim());
  const compactAnswer = compactAnswerText(answer);
  if (!compactText || !compactAnswer || containsToolCallOutput(text)) return false;
  if (!/^\d+$/u.test(compactAnswer)) return compactText.includes(compactAnswer);
  const escapedAnswer = compactAnswer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9])${escapedAnswer}([^0-9]|$)`, "u").test(compactText);
}

export function containsReplyTokenAllowingWhitespace(text: string, replyToken: string): boolean {
  return compactAnswerText(text).includes(compactAnswerText(replyToken));
}
