// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { containsToolCallStructure } from "../../helpers/e2e-answer-assertions.ts";

export interface OpenClawAgentJsonDocument {
  [key: string]: unknown;
  payloads?: Array<{ text?: unknown }>;
  result?: { meta?: unknown; payloads?: Array<{ text?: unknown }> };
}

const OPENCLAW_TEXT_KEYS = ["text", "content", "reasoning_content"] as const;
const OPENCLAW_CONTAINER_KEYS = [
  "result",
  "payloads",
  "payload",
  "messages",
  "choices",
  "message",
  "delta",
  "response",
  "data",
  "output",
  "outputs",
  "items",
  "segments",
] as const;

function openClawAgentJsonDocuments(value: unknown): OpenClawAgentJsonDocument[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(
    (entry): entry is OpenClawAgentJsonDocument =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

export function parseOpenClawAgentJsonDocuments(raw: string): OpenClawAgentJsonDocument[] {
  try {
    return openClawAgentJsonDocuments(JSON.parse(raw) as unknown);
  } catch {
    // OpenClaw has emitted both complete JSON documents and log-prefixed
    // streams. Keep this compatibility parser local to the E2E fixture layer.
  }

  const documents: OpenClawAgentJsonDocument[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start < 0) {
      if (character === "{" || character === "[") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    if (depth !== 0) continue;

    try {
      documents.push(
        ...openClawAgentJsonDocuments(JSON.parse(raw.slice(start, index + 1)) as unknown),
      );
    } catch {
      // A balanced log fragment is not necessarily JSON. Resume scanning at
      // the next top-level object instead of retrying every candidate suffix.
    } finally {
      start = -1;
      inString = false;
      escaped = false;
    }
  }
  return documents;
}

function collectOpenClawAssistantText(
  value: unknown,
  parts: string[],
  visited: Set<unknown>,
): void {
  if (value == null || visited.has(value)) return;
  if (typeof value === "string") {
    if (value.trim()) parts.push(value.trim());
    return;
  }
  if (typeof value !== "object") return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectOpenClawAssistantText(item, parts, visited));
    return;
  }

  const record = value as Record<string, unknown>;
  if (["user", "tool", "function"].includes(String(record.role))) return;
  for (const key of OPENCLAW_TEXT_KEYS) {
    collectOpenClawAssistantText(record[key], parts, visited);
  }
  for (const key of OPENCLAW_CONTAINER_KEYS) {
    collectOpenClawAssistantText(record[key], parts, visited);
  }
}

export function parseOpenClawAgentText(raw: string): string {
  const documents = parseOpenClawAgentJsonDocuments(raw);
  if (documents.some(containsToolCallStructure)) return "";
  const parts: string[] = [];
  for (const document of documents) {
    collectOpenClawAssistantText(document, parts, new Set());
  }
  return parts.join("\n");
}
