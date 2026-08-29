// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function compactAnswerText(text: string): string {
  return text.replace(/\s+/g, "");
}

export function containsToolCallStructure(value: unknown): boolean {
  if (typeof value === "string") return containsToolCallOutput(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsToolCallStructure);

  const record = value as Record<string, unknown>;
  const role = String(record.role).replaceAll("_", "-").toLowerCase();
  if (
    role === "toolresult" ||
    role === "tool-result" ||
    ["tool_use", "tool_result", "tool-result", "function"].includes(String(record.type)) ||
    record.tool_call_id != null ||
    record.toolCallId != null ||
    record.function != null ||
    record.function_call != null ||
    (record.tool_calls != null &&
      (!Array.isArray(record.tool_calls) || record.tool_calls.length > 0))
  ) {
    return true;
  }
  if (
    typeof record.name === "string" &&
    ["arguments", "description", "input", "input_schema", "param", "parameters"].some(
      (key) => key in record,
    )
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

export function containsToolCallOutput(text: string): boolean {
  const trimmed = text.trim();
  const jsonLike = trimmed.replace(/^```(?:json)?\s*/iu, "");
  const containsJsonToolField =
    /"(?:arguments|input|input_schema|param|parameters|tool_use)"\s*:/u.test(jsonLike) ||
    /"(?:function|function_call)"\s*:\s*(?!null\b)/u.test(jsonLike) ||
    /"tool_calls"\s*:\s*(?!null\b|\[\s*\])/u.test(jsonLike) ||
    /"type"\s*:\s*"(?:function|tool_use)"/u.test(jsonLike) ||
    (/"name"\s*:/u.test(jsonLike) && /"description"\s*:/u.test(jsonLike));
  const containsToolType =
    /"type"\s*:\s*"(?:function|tool_use|tool_result|tool-result)"/u.test(jsonLike);
  return (
    /^tool[ _-]?calls?\s*:/iu.test(trimmed) ||
    containsToolType ||
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
