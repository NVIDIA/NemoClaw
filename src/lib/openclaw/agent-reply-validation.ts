// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function containsToolCallStructure(value: unknown): boolean {
  if (typeof value === "string") return containsToolCallOutput(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsToolCallStructure);

  const record = value as Record<string, unknown>;
  const role = String(record.role).replaceAll("_", "-").toLowerCase();
  if (
    role === "tool" ||
    role === "function" ||
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
    /(?:^|\n)\s*(?:```(?:json)?\s*)?(?:\{|\[)[\s\S]*"(?:arguments|description|input|input_schema|param|parameters|tool_use)"\s*:/iu.test(
      jsonLike,
    ) ||
    /^\s*"?(?:function|function_call)"?\s*:\s*(?!null\b)/u.test(jsonLike) ||
    /^\s*"?tool_calls"?\s*:\s*(?!null\b|\[\s*\])/u.test(jsonLike) ||
    /^\s*"?type"?\s*:\s*"(?:function|tool_use)"/u.test(jsonLike);
  const containsToolType =
    /(?:^|\n)\s*(?:```(?:json)?\s*)?(?:\{|\[)[\s\S]*"type"\s*:\s*"(?:function|tool_use|tool_result|tool-result)"/iu.test(
      jsonLike,
    );
  return (
    /^tool[ _-]?calls?\s*:/iu.test(trimmed) ||
    containsToolType ||
    containsJsonToolField ||
    containsStructuredToolOutput(trimmed)
  );
}
