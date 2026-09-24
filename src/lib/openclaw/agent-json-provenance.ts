// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord, type UnknownRecord } from "../core/json-types";
import { redactFullWithUrls } from "../security/redact";

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
  const sanitized = value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/\r|\u0008/gu, "")
    .replace(CONTROL_PATTERN, "");
  // Preserve line boundaries while redacting so line-oriented header patterns
  // cannot consume unrelated details that happen to follow on another line.
  const squashed = redactProvenanceDetail(sanitized).replace(/\s+/gu, " ").trim();
  return squashed.length <= limit ? squashed : `${squashed.slice(0, limit - 3)}...`;
}

function redactProvenanceDetail(value: string): string {
  return redactFullWithUrls(
    value.replace(PEM_PRIVATE_KEY_PATTERN, "<REDACTED_PRIVATE_KEY>"),
  ).replace(SECRET_KV_PATTERN, "$1=<REDACTED>");
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
      : isObjectRecord(entry.value)
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
  if (Array.isArray(value) || isObjectRecord(value)) {
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
  return parts.length > 0 ? snippet(parts.join(" ")) : "unknown tool";
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

    let children: unknown[];
    let recordValue: UnknownRecord | null = null;
    if (Array.isArray(entry.value)) {
      children = entry.value;
    } else if (isObjectRecord(entry.value)) {
      recordValue = entry.value;
      children = Object.values(recordValue);
    } else {
      continue;
    }

    const objectValue = entry.value as object;
    if (seen.has(objectValue)) continue;
    seen.add(objectValue);

    if (recordValue) {
      const line = toolFailureLine(recordValue);
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

type JsonFrame = {
  docs: unknown[];
  end: number;
  start: number;
};

function jsonFrame(raw: string, start: number, end: number): JsonFrame | null {
  try {
    const parsed = JSON.parse(raw.slice(start, end)) as unknown;
    return { start, end, docs: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return null;
  }
}

function parseCompleteJsonLines(raw: string, incompleteStart: number): JsonFrame[] {
  const firstNewline = raw.indexOf("\n", incompleteStart);
  if (firstNewline < 0) return [];
  const frames: JsonFrame[] = [];
  let lineStart = firstNewline + 1;
  while (lineStart <= raw.length) {
    const newline = raw.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? raw.length : newline;
    const line = raw.slice(lineStart, lineEnd);
    const candidate = line.trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      const candidateStart = lineStart + line.indexOf(candidate);
      const frame = jsonFrame(raw, candidateStart, candidateStart + candidate.length);
      if (frame) frames.push(frame);
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return frames;
}

function parseLogPrefixedJsonFrames(raw: string): JsonFrame[] {
  const frames: JsonFrame[] = [];
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
    else if (char === "{" || char === "[") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (depth > 0 && (char === "}" || char === "]")) {
      depth -= 1;
      if (depth === 0 && start !== null) {
        const frame = jsonFrame(raw, start, index + 1);
        if (frame) frames.push(frame);
        start = null;
      }
    }
  }
  if (start !== null) frames.push(...parseCompleteJsonLines(raw, start));
  return frames;
}

function parseOpenClawJsonFrames(raw: string): JsonFrame[] {
  const clean = jsonFrame(raw, 0, raw.length);
  return clean ? [clean] : parseLogPrefixedJsonFrames(raw);
}

/** Parse clean or log-prefixed OpenClaw JSON without retrying every candidate suffix. */
export function parseOpenClawJsonDocuments(raw: string): unknown[] {
  return parseOpenClawJsonFrames(raw).flatMap(({ docs }) => docs);
}

/** Return log or malformed text outside complete OpenClaw JSON documents. */
export function openClawUnframedJsonText(raw: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const frame of parseOpenClawJsonFrames(raw)) {
    if (frame.start >= cursor) parts.push(raw.slice(cursor, frame.start));
    cursor = Math.max(cursor, frame.end);
  }
  parts.push(raw.slice(cursor));
  return parts.join("\n");
}

function dedupe(lines: string[]): string[] {
  return Array.from(new Set(lines));
}

export function openClawAgentJsonProvenanceLines(raw: string): string[] {
  const docs = parseOpenClawJsonDocuments(raw);
  if (docs.length === 0) return [];
  return dedupe([
    ...collectUntrustedChildProvenance(raw, docs),
    ...docs.flatMap(collectToolFailureProvenance),
  ]);
}

// Read completion markers only from the response envelope's `meta` record.
// Tool results and tool-call arguments are untrusted and can contain the same
// fields. Reading them could retry a completed turn and repeat its side effects.
//
// Treat any nonempty `timeoutPhase` as incomplete so new phases fail closed.
// Treat only `livenessState: "abandoned"` as incomplete.
const ABANDONED_LIVENESS_VALUE = "abandoned";
// Compared after `normalized()`, which lowercases and maps `_` to `-`.
const INCOMPLETE_TURN_ERROR_KIND = "incomplete-turn";

export type OpenClawIncompleteTurnSignal = {
  /** Human-readable `field=value` markers, deduped. */
  markers: string[];
  /** The declared phase the deadline fired in, absent when the run did not time out. */
  timeoutPhase?: string;
};

/** Select a documented local or gateway OpenClaw agent-response record. */
export function openClawAgentResponseRecord(doc: unknown): UnknownRecord | null {
  if (!isObjectRecord(doc)) return null;

  const result = doc.result;
  if (
    !Object.hasOwn(doc, "event") &&
    typeof doc.status === "string" &&
    isObjectRecord(result) &&
    (!Object.hasOwn(result, "payloads") || Array.isArray(result.payloads)) &&
    isObjectRecord(result.meta)
  ) {
    return result;
  }

  if (
    !Object.hasOwn(doc, "event") &&
    (!Object.hasOwn(doc, "payloads") || Array.isArray(doc.payloads)) &&
    isObjectRecord(doc.meta)
  ) {
    return doc;
  }
  return null;
}

/** The declared run-metadata record from an agent response envelope. */
function agentResponseMetaRecord(doc: unknown): UnknownRecord | null {
  const response = openClawAgentResponseRecord(doc);
  return response && isObjectRecord(response.meta) ? response.meta : null;
}

/** Select the final agent response without treating JSON log records as responses. */
function finalAgentResponseMetaRecord(docs: unknown[]): UnknownRecord | null {
  for (let index = docs.length - 1; index >= 0; index -= 1) {
    const meta = agentResponseMetaRecord(docs[index]);
    if (meta) return meta;
  }
  return null;
}

/** The phase the run's deadline fired in, or null when the run did not time out. */
function timedOutPhase(meta: UnknownRecord): string | null {
  const phase = meta.timeoutPhase;
  if (typeof phase !== "string") return null;
  const trimmed = phase.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function turnMetaMarkers(meta: UnknownRecord): string[] {
  const markers: string[] = [];
  if (meta.replayInvalid === true) markers.push("replayInvalid=true");
  if (normalized(meta.livenessState) === ABANDONED_LIVENESS_VALUE) {
    markers.push(`livenessState=${String(meta.livenessState)}`);
  }
  const timeoutPhase = timedOutPhase(meta);
  if (timeoutPhase) markers.push(`timeoutPhase=${timeoutPhase}`);
  const error = meta.error;
  if (isObjectRecord(error) && normalized(error.kind) === INCOMPLETE_TURN_ERROR_KIND) {
    markers.push(`error.kind=${String(error.kind)}`);
  }
  return markers;
}

/**
 * Detect a turn the run metadata itself marks incomplete, abandoned, or timed
 * out. Returns null when no marker is present, so a healthy turn is never
 * reclassified. A timed-out run also carries its declared phase, which the
 * caller uses to pick deadline-specific recovery guidance.
 */
export function openClawAgentIncompleteTurnSignal(
  raw: string,
): OpenClawIncompleteTurnSignal | null {
  const docs = parseOpenClawJsonDocuments(raw);
  if (docs.length === 0) return null;
  const meta = finalAgentResponseMetaRecord(docs);
  if (!meta) return null;
  const markers = dedupe(turnMetaMarkers(meta));
  if (markers.length === 0) return null;
  const timeoutPhase = timedOutPhase(meta);
  return timeoutPhase ? { markers, timeoutPhase } : { markers };
}
