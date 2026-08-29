// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function compactAnswerText(text: string): string {
  return text.replace(/\s+/g, "");
}

function isToolCallObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "tool_use" || "function" in record || "tool_calls" in record) return true;
  if (typeof record.name !== "string") return false;
  return ["arguments", "description", "input", "input_schema", "parameters"].some(
    (key) => key in record,
  );
}

function containsStructuredToolOutput(text: string): boolean {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    return Array.isArray(value) ? value.some(isToolCallObject) : isToolCallObject(value);
  } catch {
    return false;
  }
}

function containsToolCallOutput(text: string): boolean {
  return (
    /\btool[ _-]?calls?\b/i.test(text) ||
    /"(?:function|arguments|parameters|param)"\s*:/u.test(text) ||
    containsStructuredToolOutput(text)
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
