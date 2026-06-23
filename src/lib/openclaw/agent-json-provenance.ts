// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "../core/json-types";

const FAILURE_STATUS_VALUES = new Set(["error", "errored", "failed", "failure"]);
const UNTRUSTED_CHILD_BEGIN = "BEGIN_UNTRUSTED_CHILD_RESULT";
const UNTRUSTED_CHILD_END = "END_UNTRUSTED_CHILD_RESULT";

function snippet(value: string, limit = 300): string {
  const squashed = value.replace(/\s+/gu, " ").trim();
  return squashed.length <= limit ? squashed : `${squashed.slice(0, limit - 3)}...`;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(strings);
}

function detailFromValue(value: unknown): string | null {
  if (typeof value === "string") return snippet(value);
  if (Array.isArray(value) || isRecord(value)) {
    const nested = strings(value)
      .map((part) => snippet(part))
      .filter(Boolean);
    if (nested.length > 0) return snippet(nested.join("; "));
    try {
      return snippet(JSON.stringify(value));
    } catch {
      return snippet(String(value));
    }
  }
  if (value === null || value === undefined) return null;
  return snippet(String(value));
}

function firstDetail(record: Record<string, unknown>): string | null {
  for (const key of [
    "text",
    "content",
    "message",
    "error",
    "stderr",
    "stdout",
    "output",
    "result",
  ]) {
    if (Object.hasOwn(record, key)) {
      const detail = detailFromValue(record[key]);
      if (detail) return detail;
    }
  }
  return null;
}

function normalized(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function isToolLike(record: Record<string, unknown>): boolean {
  const role = normalized(record.role);
  const type = normalized(record.type);
  return (
    role === "toolresult" ||
    role === "tool-result" ||
    type === "toolresult" ||
    type === "tool-result" ||
    ["toolCallId", "tool_call_id", "toolName", "tool_name", "tool"].some((key) =>
      Object.hasOwn(record, key),
    )
  );
}

function hasFailureStatus(record: Record<string, unknown>): boolean {
  if (record.isError === true || record.is_error === true) return true;
  for (const key of ["status", "state", "finalStatus"]) {
    if (FAILURE_STATUS_VALUES.has(normalized(record[key]))) return true;
  }
  return record.ok === false || record.success === false;
}

function toolLabel(record: Record<string, unknown>): string {
  const tool = record.toolName ?? record.tool_name ?? record.name ?? record.tool;
  const callId = record.toolCallId ?? record.tool_call_id ?? record.id;
  const parts = [tool, callId].map((part) => String(part || "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "unknown tool";
}

function toolFailureLine(record: Record<string, unknown>): string | null {
  if (!isToolLike(record) || !hasFailureStatus(record)) return null;
  const detail = firstDetail(record) ?? "no failure detail provided";
  return `[openclaw provenance] failed tool result (${toolLabel(record)}): ${detail}`;
}

function collectToolFailureProvenance(value: unknown): string[] {
  const lines: string[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isRecord(node)) return;
    const line = toolFailureLine(node);
    if (line) lines.push(line);
    for (const child of Object.values(node)) visit(child);
  };

  visit(value);
  return lines;
}

function untrustedChildExcerpt(value: string): string | null {
  const start = value.indexOf(UNTRUSTED_CHILD_BEGIN);
  if (start < 0) return null;
  let body = value.slice(start + UNTRUSTED_CHILD_BEGIN.length);
  const end = body.indexOf(UNTRUSTED_CHILD_END);
  if (end >= 0) body = body.slice(0, end);
  body = body.replace(/^[<>\s]+|[<>\s]+$/gu, "");
  return body ? snippet(body) : null;
}

function collectUntrustedChildProvenance(raw: string, docs: unknown[]): string[] {
  const candidates = [...docs.flatMap(strings), raw];
  if (!candidates.some((candidate) => candidate.includes(UNTRUSTED_CHILD_BEGIN))) return [];

  const lines = [
    "[openclaw provenance] untrusted child result present; verify child-sourced data before treating it as confirmed.",
  ];
  for (const candidate of candidates) {
    const excerpt = untrustedChildExcerpt(candidate);
    if (excerpt) {
      lines.push(`[openclaw provenance] untrusted child excerpt: ${excerpt}`);
      break;
    }
  }
  return lines;
}

function findJsonObjectEnd(raw: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function parseOpenClawJsonDocs(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // OpenClaw has emitted log-prefixed JSON streams; scan for later objects.
  }

  const docs: unknown[] = [];
  for (const match of raw.matchAll(/\{/gu)) {
    const start = match.index;
    const end = findJsonObjectEnd(raw, start);
    if (end === null) continue;
    try {
      const parsed = JSON.parse(raw.slice(start, end)) as unknown;
      docs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Continue scanning for the next candidate object.
    }
  }
  return docs;
}

function dedupe(lines: string[]): string[] {
  return Array.from(new Set(lines));
}

export function openClawAgentJsonProvenanceLines(raw: string): string[] {
  const docs = parseOpenClawJsonDocs(raw);
  if (docs.length === 0) return [];
  return dedupe([
    ...collectUntrustedChildProvenance(raw, docs),
    ...docs.flatMap(collectToolFailureProvenance),
  ]);
}
