// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "../core/json-types";
import { redactFull } from "../security/redact";

const FAILURE_STATUS_VALUES = new Set(["error", "errored", "failed", "failure"]);
const UNTRUSTED_CHILD_BEGIN = "BEGIN_UNTRUSTED_CHILD_RESULT";
const UNTRUSTED_CHILD_END = "END_UNTRUSTED_CHILD_RESULT";
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/gu;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const CONTROL_PATTERN = /[\u0000-\u0007\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const SECRET_KV_PATTERN =
  /\b([A-Z0-9_.-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)[A-Z0-9_.-]*)\s*[:=]\s*["']?[^"'\s;,)]*/giu;
const MAX_PROVENANCE_WALK_NODES = 10_000;
const MAX_PROVENANCE_WALK_DEPTH = 80;

type WalkEntry = {
  depth: number;
  value: unknown;
};

function snippet(value: string, limit = 300): string {
  const squashed = value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/\r|\u0008/gu, "")
    .replace(CONTROL_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
  const redacted = redactProvenanceDetail(squashed);
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit - 3)}...`;
}

function redactProvenanceDetail(value: string): string {
  return redactFull(value.replace(PEM_PRIVATE_KEY_PATTERN, "<REDACTED_PRIVATE_KEY>")).replace(
    SECRET_KV_PATTERN,
    "$1=<REDACTED>",
  );
}

function strings(value: unknown): string[] {
  const result: string[] = [];
  const seen = new WeakSet<object>();
  const stack: WalkEntry[] = [{ value, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_PROVENANCE_WALK_NODES) {
    const entry = stack.pop();
    if (!entry) break;
    visited += 1;
    if (entry.depth > MAX_PROVENANCE_WALK_DEPTH) continue;

    if (typeof entry.value === "string") {
      result.push(entry.value);
      continue;
    }

    const children = Array.isArray(entry.value)
      ? entry.value
      : isRecord(entry.value)
        ? Object.values(entry.value)
        : [];
    if (children.length === 0) continue;

    const objectValue = entry.value as object;
    if (seen.has(objectValue)) continue;
    seen.add(objectValue);

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: entry.depth + 1 });
    }
  }

  return result;
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
  const seen = new WeakSet<object>();
  const stack: WalkEntry[] = [{ value, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_PROVENANCE_WALK_NODES) {
    const entry = stack.pop();
    if (!entry) break;
    visited += 1;
    if (entry.depth > MAX_PROVENANCE_WALK_DEPTH) continue;

    const children = Array.isArray(entry.value)
      ? entry.value
      : isRecord(entry.value)
        ? Object.values(entry.value)
        : [];
    if (!Array.isArray(entry.value) && !isRecord(entry.value)) continue;

    const objectValue = entry.value as object;
    if (seen.has(objectValue)) continue;
    seen.add(objectValue);

    if (isRecord(entry.value)) {
      const line = toolFailureLine(entry.value);
      if (line) lines.push(line);
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: entry.depth + 1 });
    }
  }
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

function parseLogPrefixedJsonDocs(raw: string): unknown[] {
  const docs: unknown[] = [];
  let start: number | null = null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (depth > 0 && char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (depth > 0 && char === "}") {
      depth -= 1;
      if (depth === 0 && start !== null) {
        try {
          const parsed = JSON.parse(raw.slice(start, index + 1)) as unknown;
          docs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch {
          // Continue scanning for the next balanced candidate object.
        }
        start = null;
      }
    }
  }
  return docs;
}

function parseOpenClawJsonDocs(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Invalid state: upstream OpenClaw has emitted log-prefixed/non-clean JSON
    // framing for `openclaw agent --json`. Source boundary: OpenClaw owns the
    // emitter/framing; NemoClaw only consumes the stream to keep provenance
    // visible. Source-fix constraint: do not patch or fork OpenClaw from this
    // host-wrapper PR. Regression tests cover log-prefixed balanced candidates
    // and provenance extraction. Removal condition: supported OpenClaw versions
    // guarantee stable clean JSON framing on stdout.
  }

  return parseLogPrefixedJsonDocs(raw);
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
