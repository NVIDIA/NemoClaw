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
      if (character === "{") {
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
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
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

function collectOpenClawAssistantText(value: unknown): string[] {
  const parts: string[] = [];
  const visited = new Set<unknown>();
  const collect = (candidate: unknown): void => {
    if (candidate == null || visited.has(candidate)) return;
    visited.add(candidate);
    if (typeof candidate === "string") {
      if (candidate.trim()) parts.push(candidate.trim());
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(collect);
      return;
    }
    if (typeof candidate !== "object") return;

    const record = candidate as Record<string, unknown>;
    if (["user", "tool", "function"].includes(String(record.role))) return;
    for (const key of OPENCLAW_TEXT_KEYS) collect(record[key]);
    for (const key of OPENCLAW_CONTAINER_KEYS) collect(record[key]);
  };

  collect(value);
  return parts;
}

export function parseOpenClawBroadAgentTextParts(raw: string): string[] {
  const documents = parseOpenClawAgentJsonDocuments(raw);
  if (documents.some(containsToolCallStructure)) return [];
  return documents.flatMap(collectOpenClawAssistantText);
}

export function parseOpenClawBroadAgentText(raw: string): string {
  return parseOpenClawBroadAgentTextParts(raw).join("\n");
}

export function parseOpenClawAgentText(raw: string): string {
  const documents = parseOpenClawAgentJsonDocuments(raw);
  if (documents.some(containsToolCallStructure)) return "";
  return documents
    .flatMap((document) => document.payloads ?? document.result?.payloads ?? [])
    .map((payload) => payload.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
}
